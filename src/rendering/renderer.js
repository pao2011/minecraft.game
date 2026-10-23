// Three.js scene management: chunk section meshes, atmosphere (sky, sun, moon, stars, clouds,
// fog), block selection outline, mining crack overlay, first-person held item and particles.
import * as THREE from 'three';
import { buildAtlasPixels } from './textures.js';
import { chunkVertex, chunkFragment, translucentFragment, skyVertex, skyFragment } from './shaders.js';
import { CHUNK_SIZE, SECTION_SIZE } from '../config/constants.js';
import { ATLAS_COLS, ATLAS_ROWS, TILE } from '../world/tiles.js';
import { clamp, lerp, smoothstep, makeRng } from '../util/noise.js';
import { PostFX, FX_DEFAULTS } from './post.js';
import { ParticleSystem } from './particles.js';
import { BlobShadows } from './blobShadows.js';

const v3 = (r, g, b) => new THREE.Vector3(r, g, b);
const SKY = {
  dayTop: v3(0.36, 0.58, 0.92),
  dayHorizon: v3(0.7, 0.83, 0.96),
  nightTop: v3(0.01, 0.015, 0.05),
  nightHorizon: v3(0.035, 0.05, 0.1),
  sunsetHorizon: v3(0.96, 0.52, 0.3),
};

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    // The voxel shader writes final colors directly; keep built-in materials consistent with it.
    THREE.ColorManagement.enabled = false;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.gl.autoClear = false;
    this.gl.setClearColor(0x000000);
    this.post = new PostFX(this.gl);
    this.fx = { ...FX_DEFAULTS };
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.scene.fog = new THREE.Fog(0xaaccee, 40, 80);
    this.sections = new Map();
    this.time = 0;
    this.quality = { pixelRatio: 1, clouds: true, waterAnimation: true, particles: 1, effects: 'off' };

    const { pixels, width, height } = buildAtlasPixels();
    this.atlasPixels = pixels;
    this.atlas = new THREE.DataTexture(pixels, width, height, THREE.RGBAFormat);
    this.atlas.magFilter = THREE.NearestFilter;
    this.atlas.minFilter = THREE.NearestFilter;
    this.atlas.generateMipmaps = false;
    this.atlas.colorSpace = THREE.NoColorSpace;
    this.atlas.needsUpdate = true;

    this.uniforms = {
      map: { value: this.atlas },
      uTime: { value: 0 },
      uWave: { value: 1 },
      uDaylight: { value: 1 },
      uSkyLight: { value: new THREE.Vector3(1, 1, 1) },
      uFogColor: { value: new THREE.Vector3(0.7, 0.8, 0.95) },
      uFogNear: { value: 40 },
      uFogFar: { value: 80 },
      uMinLight: { value: 0.03 },
      uMinTint: { value: new THREE.Vector3(1, 1, 1) },
      uGamma: { value: 0.25 },
      uHeld: { value: new THREE.Vector4(0, 0, 0, 0) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Vector3(1, 0.9, 0.7) },
      uUnder: { value: 0 },
    };
    this.opaqueMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: chunkVertex, fragmentShader: chunkFragment });
    this.transMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: chunkVertex, fragmentShader: translucentFragment, transparent: true, depthWrite: false,
    });
    this.buildSky();
    this.buildClouds();
    this.buildSelection();
    this.buildParticles();
    this.pfx = new ParticleSystem(this.scene);
    this.blobs = new BlobShadows(this.scene);
    this.sizeVec = new THREE.Vector2();
    this.sunWorld = new THREE.Vector3(0, 1, 0);
    this.sunScreen = new THREE.Vector3();
    this.rayPower = 0;
    this.buildHand();
    this.resize();
  }

  // ---- Chunk sections -----------------------------------------------------------------------

  makeGeometry(m) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(m.position, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(m.uv, 2));
    g.setAttribute('light', new THREE.BufferAttribute(m.light, 4, true));
    g.setAttribute('tint', new THREE.BufferAttribute(m.color, 3, true));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(8, 8, 8), 15);
    return g;
  }

  uploadSection(key, cx, sy, cz, data) {
    let entry = this.sections.get(key);
    if (!entry) {
      entry = { opaque: null, trans: null, cx, cz };
      this.sections.set(key, entry);
    }
    for (const [slot, mat, m] of [['opaque', this.opaqueMat, data?.opaque], ['trans', this.transMat, data?.translucent]]) {
      const mesh = entry[slot];
      if (!m) {
        if (mesh) {
          mesh.geometry.dispose();
          this.scene.remove(mesh);
          entry[slot] = null;
        }
        continue;
      }
      const geo = this.makeGeometry(m);
      if (mesh) {
        mesh.geometry.dispose();
        mesh.geometry = geo;
      } else {
        const nm = new THREE.Mesh(geo, mat);
        nm.position.set(cx * CHUNK_SIZE, sy * SECTION_SIZE, cz * CHUNK_SIZE);
        nm.matrixAutoUpdate = false;
        nm.updateMatrix();
        if (slot === 'trans') nm.renderOrder = 1;
        this.scene.add(nm);
        entry[slot] = nm;
      }
    }
  }

  removeChunk(cx, cz) {
    for (const [key, e] of this.sections) {
      if (e.cx !== cx || e.cz !== cz) continue;
      for (const slot of ['opaque', 'trans']) {
        if (e[slot]) {
          e[slot].geometry.dispose();
          this.scene.remove(e[slot]);
        }
      }
      this.sections.delete(key);
    }
  }

  clearChunks() {
    for (const e of this.sections.values()) {
      for (const slot of ['opaque', 'trans']) {
        if (e[slot]) {
          e[slot].geometry.dispose();
          this.scene.remove(e[slot]);
        }
      }
    }
    this.sections.clear();
  }

  // ---- Atmosphere ---------------------------------------------------------------------------

  buildSky() {
    this.skyUniforms = {
      uTop: { value: SKY.dayTop.clone() },
      uHorizon: { value: SKY.dayHorizon.clone() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uGlow: { value: new THREE.Vector3(0, 0, 0) },
      uTime: { value: 0 },
      uAurora: { value: 0 },
      uFlash: { value: 0 },
      uRealm: { value: 0 },
    };
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(10, 24, 12),
      new THREE.ShaderMaterial({ uniforms: this.skyUniforms, vertexShader: skyVertex, fragmentShader: skyFragment, side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }),
    );
    sky.frustumCulled = false;
    this.sky = sky;
    // Sky objects live in their own scene, drawn first, so terrain at any distance covers them.
    this.skyScene = new THREE.Scene();
    this.skyCamera = new THREE.PerspectiveCamera(70, 1, 0.1, 50);
    this.skyCamera.rotation.order = 'YXZ';
    this.skyScene.add(sky);

    // Sun and moon are small pixel-art discs drawn on the sky.
    const disc = (color, glowColor, size, craters = false) => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      g.fillStyle = glowColor;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (Math.hypot(x - 15.5, y - 15.5) < 13) g.fillRect(x, y, 1, 1);
      g.fillStyle = color;
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (Math.hypot(x - 15.5, y - 15.5) < 8.5) g.fillRect(x, y, 1, 1);
      if (craters) {
        g.fillStyle = 'rgba(120,135,160,0.55)';
        for (const [x, y, r] of [[12, 12, 2], [19, 17, 2.4], [14, 20, 1.4], [20, 11, 1.2]]) for (let j = -3; j <= 3; j++) for (let i = -3; i <= 3; i++) if (Math.hypot(i, j) <= r) g.fillRect(x + i, y + j, 1, 1);
      }
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
      m.renderOrder = 2;
      m.frustumCulled = false;
      this.skyScene.add(m);
      return m;
    };
    this.sun = disc('#fff6c8', 'rgba(255,230,140,0.3)', 2.4);
    this.moon = disc('#dfe6f2', 'rgba(200,215,240,0.16)', 1.7, true);

    const rng = makeRng(7);
    const starPos = [], starAux = [];
    for (let i = 0; i < 1100; i++) {
      const u = rng() * 2 - 1, a = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      if (u < -0.1) continue;
      starPos.push(r * Math.cos(a) * 9, u * 9, r * Math.sin(a) * 9);
      const mag = rng();
      starAux.push(rng() * 6.28, 1 + mag * mag * 2.4, 0.5 + mag * 0.9); // phase, size px, brightness
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    sg.setAttribute('aux', new THREE.Float32BufferAttribute(starAux, 3));
    this.starUniforms = { uOpacity: { value: 0 }, uTime: { value: 0 }, uBoost: { value: 1 }, uPx: { value: 1 } };
    this.stars = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: this.starUniforms, transparent: true, depthWrite: false, depthTest: false, fog: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec3 aux; uniform float uTime; uniform float uPx; varying float vB; varying vec3 vC;
        void main() { float tw = 0.75 + 0.25 * sin(uTime * (1.5 + aux.x * 0.4) + aux.x * 9.0); vB = aux.z * tw;
          vC = mix(vec3(0.75, 0.85, 1.0), vec3(1.0, 0.92, 0.75), fract(aux.x * 3.7));
          gl_PointSize = aux.y * uPx; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uOpacity; uniform float uBoost; varying float vB; varying vec3 vC;
        void main() { float d = length(gl_PointCoord - 0.5); float a = smoothstep(0.5, 0.0, d); gl_FragColor = vec4(vC * vB * uBoost * a * uOpacity, 1.0); }`,
    }));
    this.stars.material.opacity = 0; // kept for callers that read it; the shader uses uOpacity
    this.stars.renderOrder = 1;
    this.stars.frustumCulled = false;
    this.skyScene.add(this.stars);

    // Soft additive halos around the sun and moon.
    const hc = document.createElement('canvas');
    hc.width = hc.height = 64;
    const hg = hc.getContext('2d');
    const grad = hg.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    hg.fillStyle = grad;
    hg.fillRect(0, 0, 64, 64);
    const haloTex = new THREE.CanvasTexture(hc);
    const halo = (size) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: haloTex, transparent: true, depthWrite: false, depthTest: false, fog: false, blending: THREE.AdditiveBlending }));
      m.renderOrder = 1.5;
      m.frustumCulled = false;
      this.skyScene.add(m);
      return m;
    };
    this.sunHalo = halo(9);
    this.moonHalo = halo(5);

    // Shooting star: one additive streak that restarts every so often at night.
    const sgeo = new THREE.BufferGeometry();
    sgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
    sgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 2, 2, 2.4]), 3));
    this.meteor = new THREE.Line(sgeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, fog: false }));
    this.meteor.frustumCulled = false;
    this.meteor.visible = false;
    this.meteor.renderOrder = 1.6;
    this.skyScene.add(this.meteor);
    this.meteorState = { t: 0, wait: 8, dir: new THREE.Vector3(), from: new THREE.Vector3() };
  }

  buildClouds() {
    const N = 64;
    const data = new Uint8Array(N * N * 4);
    const rng = makeRng(31);
    // Blocky clouds: threshold a few random blobs on a wrapping grid.
    const field = new Float32Array(N * N);
    for (let k = 0; k < 70; k++) {
      const cx = rng() * N, cy = rng() * N, r = 2 + rng() * 5;
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
        let dx = Math.abs(x - cx), dy = Math.abs(y - cy);
        dx = Math.min(dx, N - dx);
        dy = Math.min(dy, N - dy);
        field[y * N + x] += Math.max(0, 1 - Math.hypot(dx, dy * 1.6) / r);
      }
    }
    for (let i = 0; i < N * N; i++) {
      const on = field[i] > 0.55;
      data.set([255, 255, 255, on ? 200 : 0], i * 4);
    }
    const tex = new THREE.DataTexture(data, N, N);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    this.cloudTex = tex;
    const geo = new THREE.PlaneGeometry(768, 768);
    geo.rotateX(-Math.PI / 2);
    this.clouds = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.85 }));
    tex.repeat.set(768 / (N * 12), 768 / (N * 12));
    this.clouds.renderOrder = 2;
    this.clouds.frustumCulled = false;
    this.scene.add(this.clouds);
    // A darker underside layer a little lower gives the flat sheet some thickness.
    this.cloudsLow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.8 }));
    this.cloudsLow.renderOrder = 1.9;
    this.cloudsLow.frustumCulled = false;
    this.scene.add(this.cloudsLow);
  }

  buildSelection() {
    const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
    this.outline = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0x101010, transparent: true, opacity: 0.55 }));
    this.outline.visible = false;
    this.scene.add(this.outline);

    const box = new THREE.BoxGeometry(1.004, 1.004, 1.004);
    this.crackGeo = box;
    this.crackBaseUV = box.attributes.uv.array.slice();
    this.crack = new THREE.Mesh(box, new THREE.MeshBasicMaterial({ map: this.atlas, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, opacity: 0.85 }));
    this.crack.visible = false;
    this.crackStage = -1;
    this.scene.add(this.crack);
  }

  /** Show the selection outline around a box (world coords) or hide it with null. */
  setSelection(hit) {
    if (!hit) {
      this.outline.visible = false;
      return;
    }
    const b = hit.box;
    this.outline.visible = true;
    this.outline.position.set(hit.x + (b[0] + b[3]) / 2, hit.y + (b[1] + b[4]) / 2, hit.z + (b[2] + b[5]) / 2);
    this.outline.scale.set(b[3] - b[0] + 0.004, b[4] - b[1] + 0.004, b[5] - b[2] + 0.004);
  }

  /** Mining crack overlay; progress in [0, 1) or null to hide. */
  setCrack(hit, progress) {
    if (!hit || progress == null || progress <= 0) {
      this.crack.visible = false;
      return;
    }
    const stage = Math.min(7, Math.floor(progress * 8));
    if (stage !== this.crackStage) {
      this.crackStage = stage;
      const tile = TILE.crack_0 + stage;
      const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
      const uv = this.crackGeo.attributes.uv;
      const base = this.crackBaseUV;
      for (let i = 0; i < uv.count; i++) {
        const u = base[i * 2], v = base[i * 2 + 1];
        uv.setXY(i, (col + 0.001 + u * 0.998) / ATLAS_COLS, (row + 0.999 - v * 0.998) / ATLAS_ROWS);
      }
      uv.needsUpdate = true;
    }
    const b = hit.box;
    this.crack.visible = true;
    this.crack.position.set(hit.x + (b[0] + b[3]) / 2, hit.y + (b[1] + b[4]) / 2, hit.z + (b[2] + b[5]) / 2);
    this.crack.scale.set(b[3] - b[0], b[4] - b[1], b[5] - b[2]);
  }

  // ---- Particles ----------------------------------------------------------------------------

  buildParticles() {
    const MAX = 400;
    this.pMax = MAX;
    this.particles = [];
    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX * 3);
    this.pUv = new Float32Array(MAX * 2);
    this.pBright = new Float32Array(MAX);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('tile', new THREE.BufferAttribute(this.pUv, 2));
    g.setAttribute('bright', new THREE.BufferAttribute(this.pBright, 1));
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: this.atlas }, uScale: { value: 400 }, fogColor: { value: new THREE.Color() }, fogNear: { value: 1 }, fogFar: { value: 100 } },
      vertexShader: `attribute vec2 tile; attribute float bright; varying vec2 vTile; varying float vB; uniform float uScale;
        void main(){ vTile = tile; vB = bright; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = uScale * 0.09 / -mv.z; gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform sampler2D map; varying vec2 vTile; varying float vB;
        void main(){ vec2 uv = vTile + gl_PointCoord * vec2(${(4 / 16 / ATLAS_COLS).toFixed(6)}, ${(4 / 16 / ATLAS_ROWS).toFixed(6)}); vec4 t = texture2D(map, uv); if (t.a < 0.5) discard; gl_FragColor = vec4(t.rgb * vB, 1.0); }`,
    });
    this.pPoints = new THREE.Points(g, mat);
    this.pPoints.frustumCulled = false;
    this.scene.add(this.pPoints);
  }

  /** Burst of block fragments. tile: atlas tile index; bright: 0..1 light multiplier. */
  spawnBlockParticles(x, y, z, tile, bright, count = 14) {
    count = Math.round(count * this.quality.particles);
    const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
    for (let i = 0; i < count; i++) {
      if (this.particles.length >= this.pMax) this.particles.shift();
      this.particles.push({
        x: x + 0.2 + Math.random() * 0.6, y: y + 0.2 + Math.random() * 0.6, z: z + 0.2 + Math.random() * 0.6,
        vx: (Math.random() - 0.5) * 3, vy: Math.random() * 3.5, vz: (Math.random() - 0.5) * 3,
        life: 0.5 + Math.random() * 0.6,
        u: (col + Math.floor(Math.random() * 3) * 0.25) / ATLAS_COLS,
        v: (row + Math.floor(Math.random() * 3) * 0.25) / ATLAS_ROWS,
        b: bright,
      });
    }
  }

  updateParticles(dt, world) {
    this.gl.getDrawingBufferSize(this.sizeVec);
    this.pfx.update(dt, world, { height: this.sizeVec.y, fov: this.camera.fov, far: this.uniforms.uFogFar.value, hdr: this.post.enabled && this.post.hdr });
    const ps = this.particles;
    let n = 0;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.life -= dt;
      p.vy -= 18 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (world && world.getBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) && p.vy < 0) {
        p.vy = 0;
        p.vx *= 0.5;
        p.vz *= 0.5;
        p.y = Math.floor(p.y) + 1.02;
      }
      if (p.life <= 0) ps.splice(i, 1);
    }
    for (const p of ps) {
      this.pPos[n * 3] = p.x;
      this.pPos[n * 3 + 1] = p.y;
      this.pPos[n * 3 + 2] = p.z;
      this.pUv[n * 2] = p.u;
      this.pUv[n * 2 + 1] = p.v;
      this.pBright[n] = p.b;
      n++;
    }
    const g = this.pPoints.geometry;
    g.setDrawRange(0, n);
    g.attributes.position.needsUpdate = true;
    g.attributes.tile.needsUpdate = true;
    g.attributes.bright.needsUpdate = true;
  }

  // ---- Weather ------------------------------------------------------------------------------

  /** Rain streaks / snowflakes in a box around the camera (bounded count, never world-wide). */
  buildWeather() {
    const N = 900;
    this.wN = N;
    this.wDrops = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      this.wDrops[i * 3] = (Math.random() - 0.5) * 32;
      this.wDrops[i * 3 + 1] = Math.random() * 24;
      this.wDrops[i * 3 + 2] = (Math.random() - 0.5) * 32;
    }
    const rg = new THREE.BufferGeometry();
    this.rainPos = new Float32Array(N * 6);
    rg.setAttribute('position', new THREE.BufferAttribute(this.rainPos, 3));
    this.rain = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xa8b8d0, transparent: true, opacity: 0.5, depthWrite: false }));
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.scene.add(this.rain);
    const sg = new THREE.BufferGeometry();
    this.snowPos = new Float32Array(N * 3);
    sg.setAttribute('position', new THREE.BufferAttribute(this.snowPos, 3));
    this.snow = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 0.09, transparent: true, opacity: 0.85, depthWrite: false }));
    this.snow.frustumCulled = false;
    this.snow.visible = false;
    this.scene.add(this.snow);
  }

  /** kind: 'rain' | 'snow' | null; strength 0..1; heightAt(x, z) gives the precipitation floor. */
  updateWeather(dt, cam, kind, strength, heightAt) {
    if (!this.rain) this.buildWeather();
    const count = Math.floor(this.wN * strength * Math.max(0.3, this.quality.particles));
    this.rain.visible = kind === 'rain' && count > 0;
    this.snow.visible = kind === 'snow' && count > 0;
    if (!kind || !count) return;
    const fall = kind === 'rain' ? 16 : 2;
    const d = this.wDrops;
    const out = kind === 'rain' ? this.rainPos : this.snowPos;
    // Drops keep world x/z and wrap into a 32-block box around the camera.
    const wrap = (v, c) => c + ((((v - c + 16) % 32) + 32) % 32) - 16;
    let n = 0;
    for (let i = 0; i < count; i++) {
      d[i * 3 + 1] -= fall * dt;
      if (kind === 'snow') d[i * 3] += Math.sin(this.time + i) * dt * 0.4;
      if (d[i * 3 + 1] < -8) {
        d[i * 3 + 1] += 24;
        d[i * 3] = (Math.random() - 0.5) * 32;
        d[i * 3 + 2] = (Math.random() - 0.5) * 32;
      }
      const wx = wrap(d[i * 3], cam.x), wz = wrap(d[i * 3 + 2], cam.z);
      const wy = cam.y + d[i * 3 + 1] - 6;
      if (wy < heightAt(Math.floor(wx), Math.floor(wz))) continue; // sheltered
      if (kind === 'rain') {
        out.set([wx, wy, wz, wx + 0.02, wy + 0.55, wz], n * 6);
      } else out.set([wx, wy, wz], n * 3);
      n++;
    }
    const obj = kind === 'rain' ? this.rain : this.snow;
    obj.geometry.setDrawRange(0, kind === 'rain' ? n * 2 : n);
    obj.geometry.attributes.position.needsUpdate = true;
    obj.material.color.setScalar(0.35 + 0.65 * (this.daylight ?? 1));
  }

  // ---- First-person held item ---------------------------------------------------------------

  buildHand() {
    this.handScene = new THREE.Scene();
    this.handCamera = new THREE.PerspectiveCamera(60, 1, 0.01, 10);
    const mk = () => {
      const group = new THREE.Group();
      this.handScene.add(group);
      return { group, mesh: null, key: null };
    };
    this.hands = { main: mk(), off: mk() };
    this.swing = 0;
    this.bob = 0;
  }

  /**
   * Set a hand's held item visual ('main' or 'off'). blockFaces: per-face atlas tiles for a block,
   * or iconTexture for flat items; key null clears the hand.
   */
  setHeld(key, { blockFaces, iconTexture } = {}, hand = 'main') {
    const st = this.hands[hand];
    if (key === st.key) return;
    st.key = key;
    if (st.mesh) {
      st.group.remove(st.mesh);
      st.mesh.geometry.dispose();
      st.mesh.material.dispose();
      st.mesh = null;
    }
    if (!key) return;
    const m = hand === 'off' ? -1 : 1;
    const k = hand === 'off' ? 0.8 : 1;
    let mesh;
    if (blockFaces) {
      const g = new THREE.BoxGeometry(0.4 * k, 0.4 * k, 0.4 * k);
      const uv = g.attributes.uv;
      // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each).
      for (let f = 0; f < 6; f++) {
        const tile = blockFaces[f];
        const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
        for (let q = 0; q < 4; q++) {
          const i = f * 4 + q;
          const u = uv.getX(i), v = uv.getY(i);
          uv.setXY(i, (col + 0.001 + u * 0.998) / ATLAS_COLS, (row + 0.999 - v * 0.998) / ATLAS_ROWS);
        }
      }
      mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: this.atlas, alphaTest: 0.5 }));
      mesh.position.set(0.42 * m, -0.42, -0.75);
      mesh.rotation.set(0.15, 0.75 * m, 0);
    } else {
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55 * k, 0.55 * k), new THREE.MeshBasicMaterial({ map: iconTexture, alphaTest: 0.5, side: THREE.DoubleSide }));
      mesh.position.set(0.45 * m, -0.36, -0.7);
      mesh.rotation.set(0.1, -0.5 * m, 0.35 * m);
    }
    st.mesh = mesh;
    st.group.add(mesh);
  }

  /** Shooting star on clear nights; one streak every 10-30 seconds. */
  updateMeteor(dt) {
    const m = this.meteorState;
    const night = (this.nightness || 0) * (1 - (this.fx.sat < 0.9 ? 0.5 : 0));
    if (m.t <= 0) {
      this.meteor.visible = false;
      m.wait -= dt;
      if (m.wait <= 0 && night > 0.7 && this.starUniforms.uOpacity.value > 0.6) {
        m.t = 0.9;
        m.wait = 10 + Math.random() * 20;
        const a = Math.random() * Math.PI * 2;
        m.from.set(Math.cos(a), 0.45 + Math.random() * 0.4, Math.sin(a)).normalize().multiplyScalar(9);
        m.dir.set(Math.random() - 0.5, -0.35 - Math.random() * 0.25, Math.random() - 0.5).normalize();
      }
      return;
    }
    m.t -= dt;
    const k = 1 - m.t / 0.9;
    const head = m.from.clone().addScaledVector(m.dir, k * 7);
    const tail = m.from.clone().addScaledVector(m.dir, Math.max(0, k - 0.22) * 7);
    const pos = this.meteor.geometry.attributes.position;
    pos.setXYZ(0, tail.x, tail.y, tail.z);
    pos.setXYZ(1, head.x, head.y, head.z);
    pos.needsUpdate = true;
    this.meteor.material.opacity = Math.sin(k * Math.PI);
    this.meteor.visible = true;
  }

  /** Lightning bolt from the clouds to (x, y, z); fades out over a fraction of a second. */
  strike(x, y, z) {
    this.bolt?.geometry.dispose();
    if (this.bolt) this.scene.remove(this.bolt);
    const pts = [];
    const top = 150;
    let cx = x + (Math.random() - 0.5) * 16, cz = z + (Math.random() - 0.5) * 16;
    const steps = 14;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const yy = top + (y - top) * t;
      pts.push(new THREE.Vector3(i === steps ? x : cx, yy, i === steps ? z : cz));
      cx += (x - cx) * 0.18 + (Math.random() - 0.5) * 7 * (1 - t);
      cz += (z - cz) * 0.18 + (Math.random() - 0.5) * 7 * (1 - t);
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    this.bolt = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: new THREE.Color(this.post.enabled && this.post.hdr ? 6 : 1, this.post.enabled && this.post.hdr ? 6 : 1, this.post.enabled && this.post.hdr ? 7 : 1), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
    this.bolt.frustumCulled = false;
    this.boltLife = 0.35;
    this.scene.add(this.bolt);
    this.skyUniforms.uFlash.value = 1;
  }

  updateBolt(dt) {
    this.skyUniforms.uFlash.value = Math.max(0, this.skyUniforms.uFlash.value - dt * 3);
    if (!this.bolt) return;
    this.boltLife -= dt;
    // Two quick flickers, then gone.
    this.bolt.material.opacity = this.boltLife > 0 ? (Math.sin(this.boltLife * 60) > -0.3 ? 1 : 0.25) * Math.min(1, this.boltLife * 4) : 0;
    if (this.boltLife <= 0) {
      this.bolt.geometry.dispose();
      this.scene.remove(this.bolt);
      this.bolt = null;
    }
  }

  /** Contact shadows; casters sit on the ground. Fades with the sun. */
  setShadows(casters) {
    this.blobs.set(casters, 0.3 + 0.7 * (this.daylight ?? 1));
  }

  /** Dynamic light carried by the player (a held torch, either hand); level 0 turns it off. */
  setHeldLight(x, y, z, level) {
    this.uniforms.uHeld.value.set(x, y, z, level);
  }

  triggerSwing() {
    if (this.swing <= 0) this.swing = 1;
  }

  // ---- Environment --------------------------------------------------------------------------

  /**
   * timeOfDay in [0,1): 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight.
   */
  setEnvironment({ timeOfDay, rain = 0, underwater = false, inLava = false, renderDistance = 5, brightness = 0.5, dimension = 'overworld', cold = 0, fog = null }) {
    const angle = timeOfDay * Math.PI * 2;
    const sunH = Math.sin(angle);
    const day = smoothstep(-0.22, 0.28, sunH);
    const sunset = clamp(1 - Math.abs(sunH) * 3.2, 0, 1) * (1 - rain * 0.7);
    const top = SKY.nightTop.clone().lerp(SKY.dayTop, day);
    const horizon = SKY.nightHorizon.clone().lerp(SKY.dayHorizon, day).lerp(SKY.sunsetHorizon, sunset * 0.75);
    if (rain > 0) {
      const gray = v3(0.42, 0.45, 0.5).multiplyScalar(0.25 + day * 0.75);
      top.lerp(gray, rain * 0.8);
      horizon.lerp(gray, rain * 0.75);
    }
    const other = dimension !== 'overworld';
    if (dimension === 'nether') {
      top.set(0.2, 0.05, 0.04);
      horizon.set(0.26, 0.07, 0.05);
    } else if (dimension === 'end') {
      top.set(0.05, 0.02, 0.1);
      horizon.set(0.13, 0.07, 0.2);
    }
    this.skyUniforms.uRealm.value = dimension === 'nether' ? 1 : dimension === 'end' ? 2 : 0;
    this.fx.heat = dimension === 'nether' ? 1 : 0;
    this.skyUniforms.uTop.value.copy(top);
    this.skyUniforms.uHorizon.value.copy(horizon);
    const sunDir = new THREE.Vector3(Math.cos(angle), sunH, 0.25).normalize();
    this.skyUniforms.uSunDir.value.copy(sunDir);
    this.skyUniforms.uGlow.value.set(0.9, 0.45, 0.2).multiplyScalar(sunset * 0.6);

    const daylight = other ? (dimension === 'nether' ? 0.5 : 0.42) : lerp(0.16, 1, day) * (1 - rain * 0.3);
    this.uniforms.uDaylight.value = daylight;
    const skyLight = dimension === 'nether' ? v3(1, 0.55, 0.42) : dimension === 'end' ? v3(0.8, 0.7, 1) : v3(0.55, 0.62, 0.9).lerp(v3(1, 1, 1), day).lerp(v3(1, 0.86, 0.72), sunset * 0.5);
    this.uniforms.uSkyLight.value.copy(skyLight);
    this.uniforms.uGamma.value = brightness * 0.9;
    this.uniforms.uMinLight.value = (dimension === 'nether' ? 0.14 : 0.025) + brightness * 0.07;
    this.uniforms.uMinTint.value.set(...(dimension === 'nether' ? [1.1, 0.5, 0.36] : dimension === 'end' ? [0.8, 0.7, 1.1] : [0.9, 0.97, 1.1]));

    const far = renderDistance * CHUNK_SIZE;
    let fogColor = horizon.clone();
    let near = far * 0.62, fogFar = far * 0.98;
    if (underwater) {
      fogColor = v3(0.08, 0.2, 0.42).multiplyScalar(0.3 + daylight * 0.7);
      near = 0;
      fogFar = 18;
    } else if (inLava) {
      fogColor = v3(0.8, 0.3, 0.05);
      near = 0;
      fogFar = 2.5;
    } else if (dimension === 'nether') {
      near = 6;
      fogFar = Math.min(far, 96) * 0.9;
    } else if (rain > 0) {
      near *= 1 - rain * 0.45;
      fogFar *= 1 - rain * 0.25;
    }
    if (fog && !underwater && !inLava && dimension === 'overworld') {
      // Biome haze: swamp mist, desert dust... blended in by `fog.mix`, dimmed with the daylight.
      fogColor.lerp(v3(fog.tint[0], fog.tint[1], fog.tint[2]).multiplyScalar(0.12 + 0.88 * day), fog.mix);
      near *= 1 - fog.mix * fog.near;
      fogFar *= 1 - fog.mix * fog.far;
    }
    this.uniforms.uFogColor.value.copy(fogColor);
    this.uniforms.uFogNear.value = near;
    this.uniforms.uFogFar.value = fogFar;
    this.scene.fog.color.setRGB(fogColor.x, fogColor.y, fogColor.z);
    this.scene.fog.near = near;
    this.scene.fog.far = fogFar;
    this.camera.far = far + 48;
    this.camera.updateProjectionMatrix();

    this.sun.visible = this.moon.visible = !other;
    this.clouds.visible = this.cloudsLow.visible = !other && !!this.quality.clouds;
    this.sun.position.copy(sunDir).multiplyScalar(8);
    this.moon.position.copy(sunDir).multiplyScalar(-8);
    this.sun.lookAt(0, 0, 0);
    this.moon.lookAt(0, 0, 0);
    const starOp = dimension === 'end' ? 0.95 : dimension === 'nether' ? 0 : clamp((1 - day) * 1.4 - rain, 0, 1);
    this.starUniforms.uOpacity.value = starOp;
    this.nightness = other ? 0 : 1 - day;
    // Aurora ribbons at night, strongest in cold biomes.
    this.skyUniforms.uAurora.value = dimension === 'overworld' ? clamp((1 - day) * 1.4 - 0.2, 0, 1) * (0.5 + 0.5 * cold) * (1 - rain) : dimension === 'end' ? 0.55 : 0;
    const lightDir = sunH > -0.05 ? sunDir : sunDir.clone().negate();
    this.uniforms.uSunDir.value.copy(lightDir);
    const sunUp = smoothstep(-0.05, 0.25, sunH);
    this.sunWorld.copy(sunDir);
    this.rayPower = other || underwater ? 0 : sunUp * (1 - rain) * (0.55 + sunset * 0.8);
    this.uniforms.uSunColor.value.set(...(other ? [0, 0, 0] : sunH > -0.05
      ? [lerp(1, 0.8, 1 - sunset) * 1.0, lerp(0.95, 0.5, sunset), lerp(0.85, 0.25, sunset)].map((v) => v * sunUp * (1 - rain))
      : [0.45, 0.55, 0.8].map((v) => v * (1 - day) * (1 - rain))));
    this.uniforms.uUnder.value = underwater ? 1 : 0;
    const warm = sunset * 0.6;
    this.sunHalo.visible = !other && sunH > -0.15;
    this.sunHalo.position.copy(sunDir).multiplyScalar(8);
    this.sunHalo.lookAt(0, 0, 0);
    this.sunHalo.material.color.setRGB(1.2 + warm, 0.95 - warm * 0.4, 0.55 - warm * 0.35).multiplyScalar(0.34 * (1 - rain * 0.6) * (this.post.enabled && this.post.hdr ? 1.2 : 1));
    this.sunHalo.scale.setScalar(1 + sunset * 0.7);
    this.moonHalo.visible = !other && sunH < 0.15;
    this.moonHalo.position.copy(sunDir).multiplyScalar(-8);
    this.moonHalo.lookAt(0, 0, 0);
    this.moonHalo.material.color.setRGB(0.5, 0.62, 0.9).multiplyScalar(0.45 * (1 - day) * (1 - rain));
    this.clouds.material.color.setRGB(lerp(0.18, 1, day), lerp(0.2, 1, day), lerp(0.28, 1, day)).multiplyScalar(1 - rain * 0.35);
    // Undersides pick up the sunset glow and turn grey in storms.
    this.cloudsLow.material.color.setRGB(lerp(0.12, 0.72, day) + sunset * 0.25, lerp(0.14, 0.76, day) + sunset * 0.05, lerp(0.22, 0.86, day) - sunset * 0.1).multiplyScalar(1 - rain * 0.3);
    // Color grading: warm at sunset, cool moonlit nights, hot Nether, violet End.
    this.fx.tint = dimension === 'nether' ? [1.1, 0.93, 0.86] : dimension === 'end' ? [0.96, 0.9, 1.1]
      : [lerp(0.84, 1.02, day) + sunset * 0.1, lerp(0.92, 1, day) - sunset * 0.03, lerp(1.1, 0.97, day) - sunset * 0.14];
    this.fx.sat = dimension === 'overworld' ? 1.04 + day * 0.08 - rain * 0.25 : 1.1;
    this.dayFactor = day;
    this.daylight = daylight;
    return { daylight, skyLight };
  }

  /** CPU-side brightness for entities and items, matching the chunk shader curve. */
  lightLevelToBrightness(sky, blk) {
    const curve = (x) => {
      const c = x / (4 - 3 * x);
      return c + (x - c) * this.uniforms.uGamma.value;
    };
    const s = curve(sky / 15) * this.uniforms.uDaylight.value;
    const b = curve(blk / 15);
    return Math.max(s, b, this.uniforms.uMinLight.value);
  }

  setQuality(q) {
    Object.assign(this.quality, q);
    this.uniforms.uWave.value = q.waterAnimation ? 1 : 0;
    this.clouds.visible = this.cloudsLow.visible = !!q.clouds;
    this.setEffects(this.quality.effects);
    this.resize();
  }

  /** 'off' | 'standard' | 'ultra': offscreen target + bloom/grading (ultra adds MSAA). */
  setEffects(mode) {
    this.post.setMode(mode);
    const hdr = this.post.enabled && this.post.hdr;
    // Bright sky bodies exceed 1.0 in the half-float target so they bloom.
    this.sun.material.color.setScalar(hdr ? 1.9 : 1);
    this.moon.material.color.setScalar(hdr ? 1.15 : 1);
    this.starUniforms.uBoost.value = hdr ? 2 : 1;
  }

  /** Per-frame screen effects: damage, under, portal, flash, speed (0..1), tint [r,g,b], sat. */
  setScreenFx(fx) {
    Object.assign(this.fx, fx);
  }

  setFov(fov) {
    this.baseFov = fov;
    this.setFovKick(this.fovKick || 0);
  }

  /** Extra degrees on top of the user's FOV (sprint rush). */
  setFovKick(deg) {
    this.fovKick = deg;
    const fov = (this.baseFov || 70) + deg;
    if (Math.abs(fov - this.camera.fov) < 0.02) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const w = this.canvas.clientWidth || window.innerWidth, h = this.canvas.clientHeight || window.innerHeight;
    const pr = Math.min(window.devicePixelRatio || 1, 2) * (this.quality.pixelRatio || 1);
    this.gl.setPixelRatio(Math.max(0.5, Math.min(pr, 2.5)));
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.handCamera.aspect = w / h;
    this.handCamera.updateProjectionMatrix();
    this.pPoints.material.uniforms.uScale.value = h * this.gl.getPixelRatio();
    this.post.resize();
  }

  /** Render one frame. pose: {x, y, z, yaw, pitch}; walking: 0..1 bob intensity. */
  render(pose, dt, { showHand = true, walking = 0 } = {}) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    this.skyUniforms.uTime.value = this.time;
    this.starUniforms.uTime.value = this.time;
    this.starUniforms.uPx.value = this.gl.getPixelRatio();
    this.updateMeteor(dt);
    this.updateBolt(dt);
    const cam = this.camera;
    cam.position.set(pose.x, pose.y, pose.z);
    cam.rotation.set(pose.pitch, pose.yaw, pose.roll || 0);
    this.clouds.position.set(Math.floor(pose.x / 12) * 12, 112, Math.floor(pose.z / 12) * 12);
    this.cloudsLow.position.set(this.clouds.position.x, 110.4, this.clouds.position.z);
    this.cloudTex.offset.set((this.time * 0.4 + this.clouds.position.x) / (64 * 12), -this.clouds.position.z / (64 * 12));
    const post = this.post.enabled;
    if (post) {
      // Sun position on screen for the light-shaft pass (only when it is in front of the camera).
      this.sunScreen.copy(this.sunWorld).multiplyScalar(100).add(cam.position);
      cam.updateMatrixWorld();
      this.sunScreen.project(cam);
      const front = this.sunScreen.z < 1 && this.sunScreen.z > -1 ? 1 : 0;
      const edge = 1 - clamp((Math.max(Math.abs(this.sunScreen.x), Math.abs(this.sunScreen.y)) - 0.9) / 1.2, 0, 1);
      this.fx.rays = [this.sunScreen.x * 0.5 + 0.5, this.sunScreen.y * 0.5 + 0.5, front * edge * this.rayPower];
    }
    if (post) this.post.begin();
    else this.gl.clear();
    this.skyCamera.rotation.copy(cam.rotation);
    this.skyCamera.fov = cam.fov;
    this.skyCamera.aspect = cam.aspect;
    this.skyCamera.updateProjectionMatrix();
    this.gl.render(this.skyScene, this.skyCamera);
    this.gl.clearDepth();
    this.gl.render(this.scene, cam);
    if (showHand && (this.hands.main.mesh || this.hands.off.mesh)) {
      this.bob += dt * walking * 9;
      if (this.swing > 0) this.swing = Math.max(0, this.swing - dt * 4);
      const s = Math.sin((1 - this.swing) * Math.PI);
      const bobX = Math.sin(this.bob) * 0.02 * walking, bobY = Math.abs(Math.cos(this.bob)) * 0.02 * walking;
      this.hands.main.group.position.set(bobX - s * 0.12, bobY - s * 0.1, -s * 0.15);
      this.hands.main.group.rotation.set(-s * 0.7, s * 0.2, 0);
      this.hands.off.group.position.set(-bobX, bobY, 0);
      this.gl.clearDepth();
      this.gl.render(this.handScene, this.handCamera);
    }
    if (post) this.post.end(this.time, this.fx);
  }

  setHandBrightness(b) {
    for (const h of Object.values(this.hands)) if (h.mesh) h.mesh.material.color.setScalar(b);
  }

  dispose() {
    this.clearChunks();
    this.gl.dispose();
  }
}
