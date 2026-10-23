// Particle effects: two pooled point-sprite layers (additive glow and alpha-blended matter),
// shapes drawn procedurally in the fragment shader, so no textures are needed.
// Colors may exceed 1.0; with the post-processing target that makes glow particles bloom.
import * as THREE from 'three';
import { SOLID } from '../world/blocks.js';

export const SHAPE = { soft: 0, square: 1, spark: 2, leaf: 3, ring: 4 };

const VERT = /* glsl */ `
attribute vec4 pcol;
attribute vec3 misc; // size (world units), shape, rotation
uniform float uScale;
uniform float uFar;
varying vec4 vCol;
varying float vShape;
varying float vRot;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  float d = -mv.z;
  float fade = (1.0 - smoothstep(uFar * 0.7, uFar, d)) * smoothstep(0.25, 0.9, d);
  vCol = vec4(pcol.rgb, pcol.a * fade);
  vShape = misc.y;
  vRot = misc.z;
  gl_PointSize = clamp(misc.x * uScale / max(d, 0.05), 1.0, 56.0);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = /* glsl */ `
uniform float uHdr;
uniform float uAdd;
varying vec4 vCol;
varying float vShape;
varying float vRot;
void main() {
  vec2 p = gl_PointCoord - 0.5;
  float cs = cos(vRot), sn = sin(vRot);
  vec2 q = vec2(cs * p.x - sn * p.y, sn * p.x + cs * p.y);
  float a;
  if (vShape < 0.5) {
    a = smoothstep(0.5, 0.05, length(p));
  } else if (vShape < 1.5) {
    vec2 e = abs(q);
    a = step(max(e.x, e.y), 0.5) * (0.75 + 0.25 * step(max(e.x, e.y), 0.36));
  } else if (vShape < 2.5) {
    vec2 e = abs(q);
    a = max(exp(-e.x * 22.0 - e.y * 4.0), exp(-e.y * 22.0 - e.x * 4.0)) + smoothstep(0.22, 0.0, length(p)) * 0.8;
  } else if (vShape < 3.5) {
    a = smoothstep(1.0, 0.7, length(q * vec2(1.0, 2.3)) * 2.0);
  } else {
    float r = length(p);
    a = smoothstep(0.08, 0.0, abs(r - 0.36)) ;
  }
  if (a < 0.02) discard;
  vec3 rgb = vCol.rgb * mix(1.0, uHdr, uAdd);
  gl_FragColor = vec4(rgb * (uAdd > 0.5 ? a * vCol.a : 1.0), uAdd > 0.5 ? 1.0 : a * vCol.a);
}`;

const DEFAULTS = {
  x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 1, s0: 0.1, s1: 0.1, r: 1, g: 1, b: 1, a0: 1, a1: 0, grav: 0, drag: 0,
  shape: 0, rot: 0, spin: 0, sway: 0, swayF: 2, flick: 0, coll: false, fadeIn: 0.06, seed: 0,
};
const KEYS = Object.keys(DEFAULTS);

class Layer {
  constructor(max, additive) {
    this.max = max;
    this.n = 0;
    this.pool = Array.from({ length: max }, () => ({ ...DEFAULTS, age: 0, max: 1 }));
    this.pos = new Float32Array(max * 3);
    this.col = new Float32Array(max * 4);
    this.misc = new Float32Array(max * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('pcol', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('misc', new THREE.BufferAttribute(this.misc, 3).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    this.uniforms = { uScale: { value: 600 }, uFar: { value: 80 }, uHdr: { value: 1 }, uAdd: { value: additive ? 1 : 0 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 3 : 2;
  }

  emit(o) {
    if (this.n >= this.max) return;
    const q = this.pool[this.n++];
    for (let i = 0; i < KEYS.length; i++) {
      const k = KEYS[i];
      q[k] = o[k] ?? DEFAULTS[k];
    }
    q.age = 0;
    q.max = q.life;
  }

  update(dt, time, world) {
    const ps = this.pool;
    for (let i = this.n - 1; i >= 0; i--) {
      const q = ps[i];
      q.life -= dt;
      q.age += dt;
      if (q.life <= 0) {
        // swap-remove: keep the dead object in the pool past the live range
        const last = --this.n;
        ps[i] = ps[last];
        ps[last] = q;
        continue;
      }
      q.vy -= q.grav * dt;
      if (q.drag) {
        const f = Math.max(0, 1 - q.drag * dt);
        q.vx *= f;
        q.vy *= f;
        q.vz *= f;
      }
      q.x += q.vx * dt;
      q.y += q.vy * dt;
      q.z += q.vz * dt;
      if (q.sway) {
        q.x += Math.sin(time * q.swayF + q.seed) * q.sway * dt;
        q.z += Math.cos(time * q.swayF * 0.83 + q.seed * 1.7) * q.sway * dt;
      }
      q.rot += q.spin * dt;
      if (q.coll && world && SOLID[world.getBlock(Math.floor(q.x), Math.floor(q.y), Math.floor(q.z))]) {
        q.vx = q.vy = q.vz = 0;
        q.grav = 0;
        q.spin = 0;
        q.sway = 0;
        q.life = Math.min(q.life, 0.8);
        q.y = Math.floor(q.y) + 1.03;
      }
    }
    for (let i = 0; i < this.n; i++) {
      const q = ps[i];
      const t = q.age / q.max;
      const sz = q.s0 + (q.s1 - q.s0) * t;
      let a = q.a0 + (q.a1 - q.a0) * t;
      a *= Math.min(1, q.age / q.fadeIn);
      if (q.flick) a *= 0.55 + 0.45 * Math.sin(time * q.flick + q.seed * 6.1);
      this.pos[i * 3] = q.x;
      this.pos[i * 3 + 1] = q.y;
      this.pos[i * 3 + 2] = q.z;
      this.col[i * 4] = q.r;
      this.col[i * 4 + 1] = q.g;
      this.col[i * 4 + 2] = q.b;
      this.col[i * 4 + 3] = Math.max(0, a);
      this.misc[i * 3] = sz;
      this.misc[i * 3 + 1] = q.shape;
      this.misc[i * 3 + 2] = q.rot;
    }
    const g = this.points.geometry;
    g.setDrawRange(0, this.n);
    g.attributes.position.needsUpdate = true;
    g.attributes.pcol.needsUpdate = true;
    g.attributes.misc.needsUpdate = true;
  }

  clear() {
    this.n = 0;
  }
}

export class ParticleSystem {
  constructor(scene) {
    this.glow = new Layer(1400, true);
    this.matter = new Layer(900, false);
    scene.add(this.matter.points, this.glow.points);
    this.density = 1;
    this.time = 0;
    this.rng = Math.random;
  }

  /** layer: 'glow' | 'matter'. Skipped when density throttles it, except for `force`. */
  emit(layer, o) {
    this[layer].emit(o);
  }

  update(dt, world, { height, fov, far, hdr }) {
    this.time += dt;
    const scale = height / (2 * Math.tan((fov * Math.PI) / 360));
    for (const l of [this.glow, this.matter]) {
      l.uniforms.uScale.value = scale;
      l.uniforms.uFar.value = far;
      l.uniforms.uHdr.value = hdr ? 1 : 0.55;
      l.update(dt, this.time, world);
    }
  }

  clear() {
    this.glow.clear();
    this.matter.clear();
  }

  get count() {
    return this.glow.n + this.matter.n;
  }
}
