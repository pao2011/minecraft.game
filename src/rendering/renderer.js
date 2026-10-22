// Three.js scene management: chunk section meshes, atmosphere (sky, sun, moon, stars, clouds,
// fog), block selection outline, mining crack overlay, first-person held item and particles.
import * as THREE from 'three';
import { buildAtlasPixels } from './textures.js';
import { chunkVertex, chunkFragment, translucentFragment, skyVertex, skyFragment } from './shaders.js';
import { CHUNK_SIZE, SECTION_SIZE } from '../config/constants.js';
import { ATLAS_COLS, ATLAS_ROWS, TILE } from '../world/tiles.js';
import { clamp, lerp, smoothstep, makeRng } from '../util/noise.js';

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
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 1, 0.05, 400);
    this.camera.rotation.order = 'YXZ';
    this.scene.add(this.camera);
    this.scene.fog = new THREE.Fog(0xaaccee, 40, 80);
    this.sections = new Map();
    this.time = 0;
    this.quality = { pixelRatio: 1, clouds: true, waterAnimation: true, particles: 1 };

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
      uGamma: { value: 0.25 },
    };
    this.opaqueMat = new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: chunkVertex, fragmentShader: chunkFragment });
    this.transMat = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: chunkVertex, fragmentShader: translucentFragment, transparent: true, depthWrite: false,
    });
    this.buildSky();
    this.buildClouds();
    this.buildSelection();
    this.buildParticles();
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
    const disc = (color, glowColor, size) => {
      const c = document.createElement('canvas');
      c.width = c.height = 32;
      const g = c.getContext('2d');
      g.fillStyle = glowColor;
      g.fillRect(4, 4, 24, 24);
      g.fillStyle = color;
      g.fillRect(8, 8, 16, 16);
      const tex = new THREE.CanvasTexture(c);
      tex.magFilter = THREE.NearestFilter;
      tex.minFilter = THREE.NearestFilter;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, fog: false }));
      m.renderOrder = 2;
      m.frustumCulled = false;
      this.skyScene.add(m);
      return m;
    };
    this.sun = disc('#fff6c8', 'rgba(255,230,140,0.35)', 2.2);
    this.moon = disc('#dfe6f2', 'rgba(200,215,240,0.18)', 1.6);

    const rng = makeRng(7);
    const starPos = [];
    for (let i = 0; i < 600; i++) {
      const u = rng() * 2 - 1, a = rng() * Math.PI * 2;
      const r = Math.sqrt(1 - u * u);
      if (u < -0.1) continue;
      starPos.push(r * Math.cos(a) * 9, u * 9, r * Math.sin(a) * 9);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 1.5, sizeAttenuation: false, transparent: true, depthWrite: false, depthTest: false, fog: false }));
    this.stars.renderOrder = 1;
    this.stars.frustumCulled = false;
    this.skyScene.add(this.stars);
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
    this.handGroup = new THREE.Group();
    this.handScene.add(this.handGroup);
    this.handMesh = null;
    this.handKey = null;
    this.swing = 0;
    this.bob = 0;
  }

  /**
   * Set the held item visual. blockTiles: per-face atlas tiles for a block, or iconTexture for flat items.
   */
  setHeld(key, { blockFaces, iconTexture } = {}) {
    if (key === this.handKey) return;
    this.handKey = key;
    if (this.handMesh) {
      this.handGroup.remove(this.handMesh);
      this.handMesh.geometry.dispose();
      this.handMesh.material.dispose();
      this.handMesh = null;
    }
    if (!key) return;
    let mesh;
    if (blockFaces) {
      const g = new THREE.BoxGeometry(0.4, 0.4, 0.4);
      const uv = g.attributes.uv;
      // BoxGeometry face order: +x, -x, +y, -y, +z, -z (4 verts each).
      for (let f = 0; f < 6; f++) {
        const tile = blockFaces[f];
        const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
        for (let k = 0; k < 4; k++) {
          const i = f * 4 + k;
          const u = uv.getX(i), v = uv.getY(i);
          uv.setXY(i, (col + 0.001 + u * 0.998) / ATLAS_COLS, (row + 0.999 - v * 0.998) / ATLAS_ROWS);
        }
      }
      mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: this.atlas, alphaTest: 0.5 }));
      mesh.position.set(0.42, -0.42, -0.75);
      mesh.rotation.set(0.15, 0.75, 0);
    } else {
      mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.55), new THREE.MeshBasicMaterial({ map: iconTexture, alphaTest: 0.5, side: THREE.DoubleSide }));
      mesh.position.set(0.45, -0.36, -0.7);
      mesh.rotation.set(0.1, -0.5, 0.35);
    }
    this.handMesh = mesh;
    this.handGroup.add(mesh);
  }

  triggerSwing() {
    if (this.swing <= 0) this.swing = 1;
  }

  // ---- Environment --------------------------------------------------------------------------

  /**
   * timeOfDay in [0,1): 0 sunrise, 0.25 noon, 0.5 sunset, 0.75 midnight.
   */
  setEnvironment({ timeOfDay, rain = 0, underwater = false, inLava = false, renderDistance = 5, brightness = 0.5 }) {
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
    this.skyUniforms.uTop.value.copy(top);
    this.skyUniforms.uHorizon.value.copy(horizon);
    const sunDir = new THREE.Vector3(Math.cos(angle), sunH, 0.25).normalize();
    this.skyUniforms.uSunDir.value.copy(sunDir);
    this.skyUniforms.uGlow.value.set(0.9, 0.45, 0.2).multiplyScalar(sunset * 0.6);

    const daylight = lerp(0.16, 1, day) * (1 - rain * 0.3);
    this.uniforms.uDaylight.value = daylight;
    const skyLight = v3(0.55, 0.62, 0.9).lerp(v3(1, 1, 1), day).lerp(v3(1, 0.86, 0.72), sunset * 0.5);
    this.uniforms.uSkyLight.value.copy(skyLight);
    this.uniforms.uGamma.value = brightness * 0.9;
    this.uniforms.uMinLight.value = 0.025 + brightness * 0.07;

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
    } else if (rain > 0) {
      near *= 1 - rain * 0.45;
      fogFar *= 1 - rain * 0.25;
    }
    this.uniforms.uFogColor.value.copy(fogColor);
    this.uniforms.uFogNear.value = near;
    this.uniforms.uFogFar.value = fogFar;
    this.scene.fog.color.setRGB(fogColor.x, fogColor.y, fogColor.z);
    this.scene.fog.near = near;
    this.scene.fog.far = fogFar;
    this.camera.far = far + 48;
    this.camera.updateProjectionMatrix();

    this.sun.position.copy(sunDir).multiplyScalar(8);
    this.moon.position.copy(sunDir).multiplyScalar(-8);
    this.sun.lookAt(0, 0, 0);
    this.moon.lookAt(0, 0, 0);
    this.stars.material.opacity = clamp((1 - day) * 1.4 - rain, 0, 1);
    this.clouds.material.color.setRGB(lerp(0.18, 1, day), lerp(0.2, 1, day), lerp(0.28, 1, day)).multiplyScalar(1 - rain * 0.35);
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
    this.clouds.visible = !!q.clouds;
    this.resize();
  }

  setFov(fov) {
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
  }

  /** Render one frame. pose: {x, y, z, yaw, pitch}; walking: 0..1 bob intensity. */
  render(pose, dt, { showHand = true, walking = 0 } = {}) {
    this.time += dt;
    this.uniforms.uTime.value = this.time;
    const cam = this.camera;
    cam.position.set(pose.x, pose.y, pose.z);
    cam.rotation.set(pose.pitch, pose.yaw, 0);
    this.clouds.position.set(Math.floor(pose.x / 12) * 12, 112, Math.floor(pose.z / 12) * 12);
    this.cloudTex.offset.set((this.time * 0.4 + this.clouds.position.x) / (64 * 12), -this.clouds.position.z / (64 * 12));
    this.gl.clear();
    this.skyCamera.rotation.copy(cam.rotation);
    this.skyCamera.fov = cam.fov;
    this.skyCamera.aspect = cam.aspect;
    this.skyCamera.updateProjectionMatrix();
    this.gl.render(this.skyScene, this.skyCamera);
    this.gl.clearDepth();
    this.gl.render(this.scene, cam);
    if (showHand && this.handMesh) {
      this.bob += dt * walking * 9;
      if (this.swing > 0) this.swing = Math.max(0, this.swing - dt * 4);
      const s = Math.sin((1 - this.swing) * Math.PI);
      this.handGroup.position.set(Math.sin(this.bob) * 0.02 * walking - s * 0.12, Math.abs(Math.cos(this.bob)) * 0.02 * walking - s * 0.1, -s * 0.15);
      this.handGroup.rotation.set(-s * 0.7, s * 0.2, 0);
      this.gl.clearDepth();
      this.gl.render(this.handScene, this.handCamera);
    }
  }

  setHandBrightness(b) {
    if (this.handMesh) this.handMesh.material.color.setScalar(b);
  }

  dispose() {
    this.clearChunks();
    this.gl.dispose();
  }
}
