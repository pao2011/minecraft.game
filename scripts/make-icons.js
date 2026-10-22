// Generates app icons (web + Android launcher) by rasterizing the isometric grass block
// from the procedural atlas. No external image assets are involved.
import { mkdirSync, writeFileSync } from 'node:fs';
import { paintTile } from '../src/rendering/textures.js';
import { encodePNG } from './atlas-preview.js';

const top = paintTile('grass_top');
const side = paintTile('grass_side');
const TINT = [0.52, 0.74, 0.36];

function texel(tile, a, b, shade) {
  const x = Math.min(15, Math.max(0, Math.floor(a * 16)));
  const y = Math.min(15, Math.max(0, Math.floor(b * 16)));
  const i = (y * 16 + x) * 4;
  const al = tile[i + 3];
  const t = al > 150 && al < 230 ? TINT : [1, 1, 1];
  return [tile[i] * t[0] * shade, tile[i + 1] * t[1] * shade, tile[i + 2] * t[2] * shade];
}

/** Solve p = o + a*u + b*v for (a, b). */
function solve(p, o, u, v) {
  const det = u[0] * v[1] - u[1] * v[0];
  const dx = p[0] - o[0], dy = p[1] - o[1];
  return [(dx * v[1] - dy * v[0]) / det, (u[0] * dy - u[1] * dx) / det];
}

function render(N, { background, cubeScale }) {
  const px = new Uint8Array(N * N * 4);
  const s = (N / 32) * cubeScale;
  const off = (N - 32 * s) / 2;
  const P = (x, y) => [off + x * s, off + y * s + s * 0.3];
  const L = P(2, 8), T = P(16, 1), R = P(30, 8), Bm = P(16, 15);
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
  const down = [0, 16 * s];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 4;
      let c = null;
      // Supersample 3x3 for smooth edges.
      let acc = [0, 0, 0], hits = 0;
      for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) {
        const p = [x + (sx + 0.5) / 3, y + (sy + 0.5) / 3];
        let col = null;
        let [a, b] = solve(p, L, sub(T, L), sub(Bm, L));
        if (a >= 0 && a <= 1 && b >= 0 && b <= 1) col = texel(top, a, b, 1);
        else {
          [a, b] = solve(p, L, sub(Bm, L), down);
          if (a >= 0 && a <= 1 && b >= 0 && b <= 1) col = texel(side, a, b, 0.82);
          else {
            [a, b] = solve(p, Bm, sub(R, Bm), down);
            if (a >= 0 && a <= 1 && b >= 0 && b <= 1) col = texel(side, a, b, 0.64);
          }
        }
        if (col) {
          acc = acc.map((v, k) => v + col[k]);
          hits++;
        }
      }
      if (hits) c = acc.map((v) => v / hits);
      let bg = [0, 0, 0, 0];
      if (background) {
        const r = N * 0.18, m = 0;
        const cx = Math.min(Math.max(x + 0.5, m + r), N - m - r), cy = Math.min(Math.max(y + 0.5, m + r), N - m - r);
        const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r;
        const g = y / N;
        if (inside) bg = [44 - g * 22, 64 - g * 30, 46 - g * 24, 255];
      }
      const cov = hits / 9;
      const base = bg[3] ? bg : [0, 0, 0, 0];
      if (c) {
        for (let k = 0; k < 3; k++) px[i + k] = c[k] * cov + base[k] * (1 - cov);
        px[i + 3] = Math.max(cov * 255, base[3]);
      } else px.set(base, i);
    }
  }
  return px;
}

const out = (path, N, opts) => {
  writeFileSync(path, encodePNG(render(N, opts), N, N));
  console.log('wrote', path);
};

mkdirSync('public', { recursive: true });
out('public/icon.png', 512, { background: true, cubeScale: 0.78 });
const res = 'android/app/src/main/res';
for (const [d, n] of [['mdpi', 48], ['hdpi', 72], ['xhdpi', 96], ['xxhdpi', 144], ['xxxhdpi', 192]]) {
  mkdirSync(`${res}/mipmap-${d}`, { recursive: true });
  out(`${res}/mipmap-${d}/ic_launcher.png`, n, { background: true, cubeScale: 0.78 });
  // Adaptive icon foreground: 108dp canvas, art within the 66dp safe zone.
  out(`${res}/mipmap-${d}/ic_launcher_foreground.png`, Math.round(n * 2.25), { background: false, cubeScale: 0.5 });
}
