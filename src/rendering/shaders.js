// GLSL for voxel chunks. Light arrives per vertex as normalized sky/block levels plus a
// baked shade (face direction x ambient occlusion); day/night only changes uniforms.

export const chunkVertex = /* glsl */ `
attribute vec4 light;
attribute vec3 tint;
uniform float uTime;
uniform float uWave;
varying vec2 vUv;
varying vec3 vLight;
varying vec3 vTint;
varying vec3 vWorld;
varying float vFogDepth;
varying float vAnim;
void main() {
  vUv = uv;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vLight = light.xyz;
  vTint = tint;
  vec3 p = position;
  float anim = floor(light.w * 255.0 + 0.5);
  vAnim = mod(anim, 128.0);
  if (uWave > 0.5 && anim > 0.5) {
    vec3 wp = (modelMatrix * vec4(p, 1.0)).xyz;
    if (anim < 1.5) {
      // Plants: sway the top vertices only, roots stay planted.
      float top = step(0.01, fract(p.y));
      p.x += sin(uTime * 1.9 + wp.x * 0.7 + wp.z * 0.5) * 0.05 * top;
      p.z += cos(uTime * 1.5 + wp.z * 0.6 + wp.x * 0.4) * 0.05 * top;
    } else if (anim < 2.5) {
      p.y += sin(uTime * 1.6 + wp.x * 0.9 + wp.z * 0.7) * 0.035 - 0.035;
    } else if (anim > 3.5) {
      p.x += sin(uTime * 1.2 + wp.y * 0.8 + wp.z * 0.3) * 0.02;
    }
  }
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFogDepth = length(mv.xyz);
  gl_Position = projectionMatrix * mv;
}
`;

const lightFn = /* glsl */ `
uniform float uDaylight;
uniform vec3 uSkyLight;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uMinLight;
uniform vec3 uMinTint;
uniform float uGamma;
uniform vec4 uHeld; // xyz = held light position, w = emitted level (0 = none)
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uUnder;
varying vec3 vWorld;
float curve(float x) {
  float c = x / (4.0 - 3.0 * x);
  return mix(c, x, uGamma);
}
// Light sources themselves (torch flame, lava, lanterns) get a boost >1 that the bloom pass picks up.
float glowOf(vec3 l) {
  return smoothstep(0.85, 0.95, l.y);
}
vec3 voxelLight(vec3 l, vec3 wp) {
  l.y = max(l.y, max(0.0, uHeld.w - distance(wp, uHeld.xyz)) / 15.0);
  float sky = curve(l.x) * uDaylight;
  float blk = curve(l.y);
  // Fire light flickers gently; the pattern drifts across space so neighbouring torches differ.
  blk *= 1.0 + 0.05 * (sin(uTime * 9.0 + wp.x * 1.3 + wp.z * 0.9) + 0.6 * sin(uTime * 23.0 + wp.y * 2.1 + wp.x));
  vec3 c = max(uSkyLight * sky, vec3(1.25, 1.0, 0.65) * blk);
  return max(c, uMinLight * uMinTint) * l.z;
}
`;

export const chunkFragment = /* glsl */ `
uniform sampler2D map;
${lightFn}
varying vec2 vUv;
varying vec3 vLight;
varying vec3 vTint;
varying float vFogDepth;
varying float vAnim;
void main() {
  vec4 tex = texture2D(map, vUv);
  if (tex.a < 0.5) discard;
  vec3 base = tex.rgb;
  if (tex.a < 0.9) base *= vTint;
  vec3 col = base * voxelLight(vLight, vWorld) * (1.0 + 0.9 * glowOf(vLight));
  if (uUnder > 0.5) {
    vec3 w = vWorld;
    float cx = sin(w.x * 1.7 + w.y * 0.6 + uTime * 1.3) * sin(w.z * 1.9 - w.y * 0.5 + uTime * 1.1);
    float cz = sin((w.x + w.z) * 2.6 - uTime * 1.7) * sin((w.x - w.z) * 2.2 + uTime * 1.2);
    col *= 1.0 + pow(max(0.0, cx * 0.5 + cz * 0.5), 3.0) * 1.6 * vLight.x;
  }
  float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
  gl_FragColor = vec4(mix(col, uFogColor, fog), 1.0);
}
`;

export const translucentFragment = /* glsl */ `
uniform sampler2D map;
${lightFn}
varying vec2 vUv;
varying vec3 vLight;
varying vec3 vTint;
varying float vFogDepth;
varying float vAnim;
void main() {
  vec4 tex = texture2D(map, vUv);
  if (tex.a < 0.02) discard;
  vec3 col = tex.rgb * vTint * voxelLight(vLight, vWorld) * (1.0 + 0.9 * glowOf(vLight));
  float alpha = tex.a;
  if (vAnim > 1.5 && vAnim < 2.5) {
    // Water: rolling ripples, horizon reflection at grazing angles and a sun/moon glitter path.
    vec3 gn = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (abs(gn.y) > 0.7) {
      vec2 q = vWorld.xz;
      float a1 = q.x * 2.3 + uTime * 1.4, a2 = q.y * 2.9 - uTime * 1.1, a3 = (q.x + q.y) * 4.1 + uTime * 2.3;
      float h = sin(a1) + sin(a2) + 0.6 * sin(a3);
      vec3 N = normalize(vec3(-(cos(a1) * 2.3 + cos(a3) * 1.5) * 0.025, 1.0, -(cos(a2) * 2.9 + cos(a3) * 1.5) * 0.025));
      vec3 V = normalize(cameraPosition - vWorld);
      float fres = pow(1.0 - clamp(dot(N, V), 0.0, 1.0), 3.0);
      float lit = 0.3 + 0.7 * uDaylight;
      col *= 1.0 + h * 0.03;
      col = mix(col, uFogColor * lit, clamp(fres * 0.65 + 0.05, 0.0, 0.75));
      float spec = pow(max(dot(reflect(-V, N), uSunDir), 0.0), 120.0);
      col += uSunColor * spec * 3.5;
      alpha = mix(alpha, 1.0, fres * 0.55);
    }
  }
  float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
  gl_FragColor = vec4(mix(col, uFogColor, fog), mix(alpha, 1.0, fog));
}
`;

export const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`;

export const skyFragment = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSunDir;
uniform vec3 uGlow;
uniform float uTime;
uniform float uAurora;
uniform float uFlash;
uniform float uRealm; // 0 overworld, 1 nether, 2 end
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, -1.0, 1.0);
  vec3 c = mix(uHorizon, uTop, pow(smoothstep(-0.05, 0.75, h), 0.8));
  c = mix(c, uHorizon * 1.08, exp(-abs(h) * 9.0) * 0.5); // horizon haze
  float sun = max(dot(normalize(vDir), uSunDir), 0.0);
  c += uGlow * (pow(sun, 6.0) + 0.5 * pow(sun, 40.0)) * smoothstep(-0.3, 0.2, h);
  if (uAurora > 0.01 && h > 0.04) {
    // Aurora: slow curtains projected onto a high plane, green low, violet high.
    vec2 ap = vDir.xz / (h + 0.3);
    float wave = sin(ap.x * 2.6 + sin(ap.y * 1.4 + uTime * 0.12) * 1.8 + uTime * 0.17);
    float band = pow(smoothstep(0.1, 1.0, wave * 0.5 + 0.5), 2.0);
    float shimmer = 0.55 + 0.45 * sin(ap.x * 9.0 - uTime * 0.6 + ap.y * 3.0);
    float mask = smoothstep(0.04, 0.3, h) * smoothstep(1.0, 0.45, h);
    vec3 ac = mix(vec3(0.15, 1.0, 0.55), vec3(0.55, 0.25, 1.0), smoothstep(0.25, 0.75, h));
    c += ac * band * shimmer * mask * uAurora * 1.1;
  }
  if (uRealm > 0.5 && uRealm < 1.5) {
    // Cinder Realm: the sky glows from the lava seas far below the horizon.
    float glow = smoothstep(0.35, -0.7, h);
    c += vec3(0.95, 0.28, 0.06) * glow * (0.55 + 0.15 * sin(uTime * 0.7 + vDir.x * 5.0 + vDir.z * 3.0));
    c += vec3(0.25, 0.05, 0.02) * smoothstep(0.1, 0.8, h) * (0.5 + 0.5 * sin(vDir.x * 7.0 + uTime * 0.2) * sin(vDir.z * 6.0 - uTime * 0.15));
  } else if (uRealm > 1.5) {
    // Void Isles: drifting nebula ribbons.
    vec3 d = normalize(vDir);
    float n1 = sin(d.x * 5.0 + sin(d.y * 4.0 + uTime * 0.04) * 2.0) * sin(d.z * 4.0 + d.y * 3.0 - uTime * 0.03);
    float n2 = sin(d.x * 9.0 - d.z * 6.0 + sin(d.y * 7.0) * 1.5 + uTime * 0.05);
    float band = smoothstep(0.1, 0.9, n1 * 0.5 + 0.5) * smoothstep(-0.2, 0.6, n2);
    c += mix(vec3(0.35, 0.1, 0.65), vec3(0.1, 0.55, 0.6), n2 * 0.5 + 0.5) * band * 0.55;
    c += vec3(0.5, 0.2, 0.9) * exp(-abs(h) * 6.0) * 0.18;
  }
  c += vec3(0.75, 0.82, 1.0) * uFlash * (0.5 + 0.5 * smoothstep(-0.2, 0.6, h));
  gl_FragColor = vec4(c, 1.0);
}
`;
