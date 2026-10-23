// Screen-space finishing: the scene renders into an offscreen target, then a bloom chain (1/4
// resolution) and one composite pass add glow, grading, vignette and gameplay effects (damage,
// underwater, portal, speed, lightning). Mode 'off' bypasses all of it.
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const BRIGHT = /* glsl */ `
uniform sampler2D tex;
uniform vec2 px;
uniform float thr;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tex, vUv + px * vec2(-1.0, -1.0)).rgb + texture2D(tex, vUv + px * vec2(1.0, -1.0)).rgb
         + texture2D(tex, vUv + px * vec2(-1.0, 1.0)).rgb + texture2D(tex, vUv + px * vec2(1.0, 1.0)).rgb;
  c *= 0.25;
  float m = max(c.r, max(c.g, c.b));
  gl_FragColor = vec4(c * smoothstep(thr, thr + 0.5, m), 1.0);
}`;

const BLUR = /* glsl */ `
uniform sampler2D tex;
uniform vec2 dir;
varying vec2 vUv;
void main() {
  vec3 s = texture2D(tex, vUv).rgb * 0.2270270;
  s += (texture2D(tex, vUv + dir * 1.3846).rgb + texture2D(tex, vUv - dir * 1.3846).rgb) * 0.3162162;
  s += (texture2D(tex, vUv + dir * 3.2308).rgb + texture2D(tex, vUv - dir * 3.2308).rgb) * 0.0702703;
  gl_FragColor = vec4(s, 1.0);
}`;

const COMPOSITE = /* glsl */ `
uniform sampler2D scene;
uniform sampler2D bloom;
uniform float uHeat;
uniform float uTime, uBloom, uVignette, uDamage, uUnder, uPortal, uFlash, uSpeed, uSat;
uniform vec3 uTint;
uniform vec3 uRays; // xy = sun position in screen uv, z = strength
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 shoulder(vec3 x) {
  vec3 over = max(x - 0.8, 0.0);
  return min(x, vec3(0.8)) + 0.2 * (1.0 - exp(-over / 0.2));
}
void main() {
  vec2 uv = vUv;
  vec2 c = uv - 0.5;
  float wob = uUnder * 0.005 + uPortal * 0.014;
  uv += uHeat * 0.0016 * vec2(sin(uv.y * 38.0 + uTime * 2.6), cos(uv.x * 31.0 + uTime * 2.1));
  uv += wob * vec2(sin(uv.y * 20.0 + uTime * 2.4), cos(uv.x * 24.0 + uTime * 2.0));
  vec3 col = texture2D(scene, uv).rgb;
  float ca = uDamage * 0.014 + uSpeed * 0.003;
  if (ca > 0.0005) {
    col.r = texture2D(scene, uv - c * ca).r;
    col.b = texture2D(scene, uv + c * ca).b;
  }
  if (uSpeed > 0.02) {
    vec3 acc = col;
    for (int i = 1; i < 5; i++) acc += texture2D(scene, uv - c * uSpeed * 0.03 * float(i)).rgb;
    col = acc / 5.0;
  }
  col += texture2D(bloom, uv).rgb * uBloom;
  if (uRays.z > 0.01) {
    // Crepuscular rays: smear the glow buffer toward the sun, so gaps in foliage become shafts.
    vec2 stepv = (uRays.xy - uv) / 16.0;
    vec2 s = uv + stepv * hash(gl_FragCoord.xy);
    float w = 1.0;
    vec3 acc = vec3(0.0);
    for (int i = 0; i < 16; i++) { s += stepv; acc += texture2D(bloom, s).rgb * w; w *= 0.94; }
    col += acc * 0.02 * uRays.z * vec3(1.0, 0.88, 0.65);
  }
  col = shoulder(col) * uTint;
  float l = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(l), col, uSat);
  col = (col - 0.5) * 1.05 + 0.5;
  float r = length(c * vec2(1.0, 0.9)) * 1.45;
  col *= 1.0 - uVignette * smoothstep(0.45, 1.05, r);
  col = mix(col, col * vec3(1.35, 0.25, 0.25), uDamage * smoothstep(0.25, 1.0, r));
  col = mix(col, col * vec3(0.55, 0.82, 1.15) + vec3(0.0, 0.03, 0.07), uUnder);
  col = mix(col, col * vec3(0.8, 0.4, 1.3) + vec3(0.08, 0.0, 0.14), uPortal);
  col += uFlash;
  col += (hash(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export const FX_DEFAULTS = { damage: 0, under: 0, portal: 0, flash: 0, speed: 0, tint: [1, 1, 1], sat: 1.06, rays: [0.5, 0.5, 0], heat: 0 };

export class PostFX {
  constructor(gl) {
    this.gl = gl;
    this.mode = 'off';
    const ext = gl.extensions;
    // Half-float targets keep values above 1.0 (lava, torches, sun) so only those bloom.
    this.hdr = gl.capabilities.isWebGL2 && (ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float'));
    this.msaaOk = gl.capabilities.isWebGL2 && (!this.hdr || ext.has('EXT_color_buffer_float'));
    this.size = new THREE.Vector2(1, 1);
    this.rt = null;
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const mk = (fragmentShader, uniforms) => new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
    this.bright = mk(BRIGHT, { tex: { value: null }, px: { value: new THREE.Vector2() }, thr: { value: 1 } });
    this.blur = mk(BLUR, { tex: { value: null }, dir: { value: new THREE.Vector2() } });
    this.comp = mk(COMPOSITE, {
      scene: { value: null }, bloom: { value: null }, uTime: { value: 0 }, uBloom: { value: 0.6 }, uVignette: { value: 0.35 },
      uDamage: { value: 0 }, uUnder: { value: 0 }, uPortal: { value: 0 }, uFlash: { value: 0 }, uSpeed: { value: 0 }, uSat: { value: 1.06 }, uTint: { value: new THREE.Vector3(1, 1, 1) }, uRays: { value: new THREE.Vector3(0.5, 0.5, 0) }, uHeat: { value: 0 },
    });
    this.quad = new THREE.Mesh(tri, this.bright);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  }

  get enabled() {
    return this.mode !== 'off';
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this.rt?.dispose();
    this.rt = null;
    this.bloomA?.dispose();
    this.bloomB?.dispose();
    this.bloomA = this.bloomB = null;
    if (this.enabled) this.allocate();
  }

  allocate() {
    const { x: w, y: h } = this.size;
    const type = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType;
    const opts = { type, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: true, generateMipmaps: false };
    this.rt = new THREE.WebGLRenderTarget(w, h, { ...opts, samples: this.mode === 'ultra' && this.msaaOk ? 4 : 0 });
    const bw = Math.max(2, Math.round(w / 4)), bh = Math.max(2, Math.round(h / 4));
    const small = { ...opts, depthBuffer: false };
    this.bloomA = new THREE.WebGLRenderTarget(bw, bh, small);
    this.bloomB = new THREE.WebGLRenderTarget(bw, bh, small);
  }

  /** Match the drawing buffer (call after the renderer resizes). */
  resize() {
    this.gl.getDrawingBufferSize(this.size);
    if (this.enabled) {
      this.rt?.dispose();
      this.bloomA?.dispose();
      this.bloomB?.dispose();
      this.allocate();
    }
  }

  begin() {
    this.gl.setRenderTarget(this.rt);
    this.gl.clear();
  }

  pass(material, target) {
    this.quad.material = material;
    this.gl.setRenderTarget(target);
    this.gl.render(this.scene, this.camera);
  }

  /** Bloom chain + composite onto the canvas. fx: see FX_DEFAULTS. */
  end(time, fx) {
    const ultra = this.mode === 'ultra';
    const bw = this.bloomA.width, bh = this.bloomA.height;
    this.bright.uniforms.tex.value = this.rt.texture;
    this.bright.uniforms.px.value.set(1 / this.size.x, 1 / this.size.y);
    this.bright.uniforms.thr.value = this.hdr ? 1.0 : 0.92;
    this.pass(this.bright, this.bloomA);
    const rounds = ultra ? 3 : 2;
    for (let i = 0; i < rounds; i++) {
      this.blur.uniforms.tex.value = this.bloomA.texture;
      this.blur.uniforms.dir.value.set(1 / bw, 0);
      this.pass(this.blur, this.bloomB);
      this.blur.uniforms.tex.value = this.bloomB.texture;
      this.blur.uniforms.dir.value.set(0, 1 / bh);
      this.pass(this.blur, this.bloomA);
    }
    const u = this.comp.uniforms;
    u.scene.value = this.rt.texture;
    u.bloom.value = this.bloomA.texture;
    u.uTime.value = time % 1000;
    u.uBloom.value = this.hdr ? (ultra ? 0.7 : 0.55) : 0.3;
    u.uVignette.value = ultra ? 0.42 : 0.32;
    u.uDamage.value = fx.damage;
    u.uUnder.value = fx.under;
    u.uPortal.value = fx.portal;
    u.uFlash.value = fx.flash;
    u.uSpeed.value = fx.speed;
    u.uSat.value = fx.sat;
    u.uHeat.value = fx.heat || 0;
    u.uTint.value.set(fx.tint[0], fx.tint[1], fx.tint[2]);
    u.uRays.value.set(fx.rays[0], fx.rays[1], ultra && this.hdr ? fx.rays[2] : 0);
    this.pass(this.comp, null);
  }

  dispose() {
    this.rt?.dispose();
    this.bloomA?.dispose();
    this.bloomB?.dispose();
  }
}
