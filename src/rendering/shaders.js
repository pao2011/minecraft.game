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
void main() {
  vUv = uv;
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  vLight = light.xyz;
  vTint = tint;
  vec3 p = position;
  float anim = floor(light.w * 255.0 + 0.5);
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
uniform float uGamma;
uniform vec4 uHeld; // xyz = held light position, w = emitted level (0 = none)
varying vec3 vWorld;
float curve(float x) {
  float c = x / (4.0 - 3.0 * x);
  return mix(c, x, uGamma);
}
vec3 voxelLight(vec3 l, vec3 wp) {
  l.y = max(l.y, max(0.0, uHeld.w - distance(wp, uHeld.xyz)) / 15.0);
  float sky = curve(l.x) * uDaylight;
  float blk = curve(l.y);
  vec3 c = max(uSkyLight * sky, vec3(1.0, 0.86, 0.66) * blk);
  return max(c, vec3(uMinLight)) * l.z;
}
`;

export const chunkFragment = /* glsl */ `
uniform sampler2D map;
${lightFn}
varying vec2 vUv;
varying vec3 vLight;
varying vec3 vTint;
varying float vFogDepth;
void main() {
  vec4 tex = texture2D(map, vUv);
  if (tex.a < 0.5) discard;
  vec3 base = tex.rgb;
  if (tex.a < 0.9) base *= vTint;
  vec3 col = base * voxelLight(vLight, vWorld);
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
void main() {
  vec4 tex = texture2D(map, vUv);
  if (tex.a < 0.02) discard;
  vec3 col = tex.rgb * vTint * voxelLight(vLight, vWorld);
  float fog = smoothstep(uFogNear, uFogFar, vFogDepth);
  gl_FragColor = vec4(mix(col, uFogColor, fog), mix(tex.a, 1.0, fog));
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
varying vec3 vDir;
void main() {
  float h = clamp(vDir.y, -1.0, 1.0);
  vec3 c = mix(uHorizon, uTop, smoothstep(-0.05, 0.6, h));
  float sun = max(dot(normalize(vDir), uSunDir), 0.0);
  c += uGlow * pow(sun, 6.0) * smoothstep(-0.3, 0.2, h);
  gl_FragColor = vec4(c, 1.0);
}
`;
