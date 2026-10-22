// Procedurally painted, original 16x16 pixel-art tiles. Generated at startup into one RGBA
// atlas (no image downloads). Alpha encodes two things for opaque-pass tiles:
//   0        -> transparent (cutout, discarded)
//   ~204     -> pixel receives the biome tint (grass, leaves)
//   255      -> plain opaque pixel
import { TILE_NAMES, ATLAS_COLS, ATLAS_ROWS, TILE_PX } from '../world/tiles.js';
import { makeRng, hash4, SimplexNoise } from '../util/noise.js';

const S = TILE_PX;
const TINT_A = 204;

class Tile {
  constructor(seed) {
    this.d = new Uint8ClampedArray(S * S * 4);
    this.rng = makeRng(seed);
    this.noise = new SimplexNoise(seed);
  }
  set(x, y, c, a = 255) {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    this.d[i] = c[0];
    this.d[i + 1] = c[1];
    this.d[i + 2] = c[2];
    this.d[i + 3] = a;
  }
  get(x, y) {
    const i = (y * S + x) * 4;
    return [this.d[i], this.d[i + 1], this.d[i + 2], this.d[i + 3]];
  }
  alpha(x, y) {
    return this.d[(y * S + x) * 4 + 3];
  }
  /** Fill with a base color plus per-pixel jitter. */
  fill(c, jitter = 0, a = 255) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) this.set(x, y, vary(c, jitter, this.rng), a);
  }
  /** Fill using smooth noise to pick between two colors (clumpy, natural look). */
  blend(c1, c2, scale = 4, jitter = 6, a = 255) {
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const n = (this.noise.noise2(x / scale, y / scale) + 1) / 2;
        this.set(x, y, vary(mix(c1, c2, n), jitter, this.rng), a);
      }
    }
  }
  speckle(c, chance, a = 255) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (this.rng() < chance) this.set(x, y, vary(c, 8, this.rng), a);
  }
  rect(x0, y0, w, h, c, a = 255) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c, a);
  }
  /** Draw from a string template; chars map to colors via `pal`. '.' = transparent. */
  sprite(rows, pal, ox = 0, oy = 0) {
    rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === '.' || ch === ' ') continue;
        const c = pal[ch];
        if (!c) continue;
        this.set(ox + x, oy + y, c.length > 3 ? c.slice(0, 3) : c, c.length > 3 ? c[3] : 255);
      }
    });
  }
  clear() {
    this.d.fill(0);
  }
  shadeAll(f) {
    for (let i = 0; i < this.d.length; i += 4) {
      this.d[i] *= f;
      this.d[i + 1] *= f;
      this.d[i + 2] *= f;
    }
  }
}

export const vary = (c, amt, rng) => {
  const k = (rng() * 2 - 1) * amt;
  return [c[0] + k, c[1] + k, c[2] + k];
};
export const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mul = (c, f) => [c[0] * f, c[1] * f, c[2] * f];

// ---- Material painters ---------------------------------------------------------------------

function stone(t, base = [124, 124, 128]) {
  t.blend(base, mul(base, 0.86), 3, 7);
  // Short dark fissures.
  for (let k = 0; k < 4; k++) {
    let x = t.rng.int(0, 15), y = t.rng.int(0, 15);
    for (let s = 0; s < t.rng.int(2, 4); s++) {
      t.set(x, y, mul(base, 0.68));
      x += t.rng.int(-1, 1);
      y += 1;
    }
  }
  t.speckle(mul(base, 1.15), 0.05);
}

function dirt(t, base = [128, 90, 60]) {
  t.blend(base, mul(base, 0.82), 2.5, 8);
  t.speckle(mul(base, 0.65), 0.06);
  t.speckle([150, 120, 92], 0.04);
}

function cobble(t, base = [118, 118, 120], moss = false) {
  t.fill(mul(base, 0.55), 4);
  // Irregular stones on a staggered grid, each with a highlight and shadow edge.
  const centers = [];
  for (let gy = 0; gy < 4; gy++) for (let gx = 0; gx < 4; gx++) centers.push([gx * 4 + (gy % 2) * 2 + t.rng.int(0, 1), gy * 4 + t.rng.int(0, 1)]);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let best = 99, second = 99, bi = 0;
      centers.forEach(([cx, cy], i) => {
        for (const ox of [-16, 0, 16]) {
          for (const oy of [-16, 0, 16]) {
            const d = Math.hypot(x - cx - ox, (y - cy - oy) * 1.1);
            if (d < best) { second = best; best = d; bi = i; } else if (d < second) second = d;
          }
        }
      });
      if (second - best < 0.9) continue; // mortar gap
      const shade = 0.85 + ((bi * 37) % 7) / 30;
      let c = mul(base, shade);
      if (second - best < 1.8) c = mul(c, 0.85);
      t.set(x, y, vary(c, 6, t.rng));
    }
  }
  if (moss) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (t.noise.noise2(x / 4 + 9, y / 4) > 0.25) t.set(x, y, vary([78, 112, 52], 10, t.rng));
  }
}

function planks(t, base) {
  for (let y = 0; y < S; y++) {
    const board = Math.floor(y / 4);
    for (let x = 0; x < S; x++) {
      const grain = Math.sin((x + board * 5) * 0.9 + t.noise.noise2(x / 6, y) * 2) * 0.05;
      let c = mul(base, 0.95 + grain + (board % 2) * 0.05);
      if (y % 4 === 3) c = mul(base, 0.62);
      t.set(x, y, vary(c, 4, t.rng));
    }
    // Board end seams alternate positions per row.
    const seam = (Math.floor(y / 4) * 7 + 3) % 16;
    if (y % 4 !== 3) t.set(seam, y, mul(base, 0.68));
  }
  for (let b = 0; b < 4; b++) t.set((b * 7 + 1) % 16, b * 4 + 1, mul(base, 0.5));
}

function logSide(t, bark, dark) {
  for (let x = 0; x < S; x++) {
    const stripe = t.noise.noise2(x * 0.7, 0.5) > 0.1 ? 0.82 : 1;
    for (let y = 0; y < S; y++) {
      const n = t.noise.noise2(x * 0.9, y / 5);
      t.set(x, y, vary(mul(bark, stripe * (n > 0.45 ? 0.75 : 1)), 6, t.rng));
    }
  }
  if (dark) t.speckle(dark, 0.08);
}

function logTop(t, inner, bark) {
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const d = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
      if (d > 6.5) t.set(x, y, vary(bark, 6, t.rng));
      else {
        const ring = Math.floor(Math.hypot(x - 7.5, y - 7.5) + t.noise.noise2(x / 3, y / 3) * 0.6) % 2;
        t.set(x, y, vary(mul(inner, ring ? 0.86 : 1), 4, t.rng));
      }
    }
  }
}

function leaves(t, tinted, color) {
  t.clear();
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const n = t.noise.noise2(x / 2.2, y / 2.2);
      if (n < -0.35 && t.rng() < 0.85) continue; // gaps between leaf clusters
      const shade = n > 0.3 ? 1.12 : n < -0.1 ? 0.78 : 0.95;
      if (tinted) t.set(x, y, vary([200 * shade, 200 * shade, 200 * shade], 10, t.rng), TINT_A);
      else t.set(x, y, vary(mul(color, shade), 10, t.rng));
    }
  }
}

function ore(t, colors, count = 5, size = 3) {
  stone(t);
  for (let k = 0; k < count; k++) {
    const cx = t.rng.int(2, 13), cy = t.rng.int(2, 13);
    for (let s = 0; s < size + t.rng.int(0, 2); s++) {
      const x = cx + t.rng.int(-1, 1), y = cy + t.rng.int(-1, 1);
      const c = colors[t.rng.int(0, colors.length - 1)];
      t.set(x, y, vary(c, 8, t.rng));
      t.set(x + 1, y + 1, mul(c, 0.55));
    }
    t.set(cx, cy, mix(colors[0], [255, 255, 255], 0.45));
  }
}

function bricks(t, brick, mortar, rowH = 4, w = 8) {
  for (let y = 0; y < S; y++) {
    const row = Math.floor(y / rowH);
    const off = (row % 2) * (w / 2);
    for (let x = 0; x < S; x++) {
      const isMortar = y % rowH === rowH - 1 || (x + off) % w === w - 1;
      const brickIdx = Math.floor((x + off) / w) + row * 3;
      const c = isMortar ? mortar : mul(brick, 0.9 + ((brickIdx * 13) % 5) / 25);
      t.set(x, y, vary(c, isMortar ? 3 : 7, t.rng));
    }
  }
}

function frame(t, c, inset = 0) {
  for (let i = inset; i < S - inset; i++) {
    t.set(i, inset, c);
    t.set(i, S - 1 - inset, c);
    t.set(inset, i, c);
    t.set(S - 1 - inset, i, c);
  }
}

function cropStage(t, stage, kind) {
  t.clear();
  const h = [4, 7, 11, 14][stage];
  const green = [70, 140, 50];
  for (let k = 0; k < 6; k++) {
    const x = 1 + k * 2 + (k % 2);
    for (let y = S - 1; y >= S - h + (k % 3); y--) t.set(x, y, vary(kind === 'wheat' && stage === 3 ? [200, 170, 70] : green, 10, t.rng));
    if (kind === 'wheat' && stage >= 2) {
      const top = S - h + (k % 3);
      const c = stage === 3 ? [222, 190, 90] : [150, 170, 70];
      t.set(x, top, c);
      t.set(x - 1, top + 1, c);
      t.set(x + 1, top + 1, c);
      t.set(x, top + 2, c);
    }
    if (kind === 'carrots' && stage === 3) {
      t.set(x, S - 1, [235, 120, 30]);
      t.set(x, S - 2, [245, 140, 40]);
    }
  }
}

function crack(t, stage) {
  t.clear();
  const rng = makeRng(99);
  const lines = 2 + stage * 2;
  for (let k = 0; k < lines; k++) {
    let x = 7 + rng.int(-1, 1), y = 7 + rng.int(-1, 1);
    const dx = rng() * 2 - 1, dy = rng() * 2 - 1;
    const len = 3 + stage + rng.int(0, 3);
    let fx = x, fy = y;
    for (let s = 0; s < len; s++) {
      t.set(Math.round(fx), Math.round(fy), [20, 20, 20], 200);
      fx += dx + (rng() - 0.5) * 0.8;
      fy += dy + (rng() - 0.5) * 0.8;
    }
    x = fx;
    y = fy;
  }
}

const P = {
  grass_top(t) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = t.noise.noise2(x / 2, y / 3);
      const v = 175 + n * 22 + (t.rng() - 0.5) * 22;
      t.set(x, y, [v, v, v], TINT_A);
    }
  },
  grass_side(t) {
    dirt(t);
    for (let x = 0; x < S; x++) {
      const depth = 3 + Math.floor((t.noise.noise2(x * 0.8, 3) + 1) * 1.5) + (t.rng() < 0.2 ? 1 : 0);
      for (let y = 0; y < depth; y++) {
        const v = 170 + (t.rng() - 0.5) * 30 - y * 6;
        t.set(x, y, [v, v, v], TINT_A);
      }
    }
  },
  snow_grass_top(t) {
    t.blend([238, 244, 250], [214, 226, 240], 3, 4);
  },
  snow_grass_side(t) {
    dirt(t);
    for (let x = 0; x < S; x++) {
      const depth = 3 + Math.floor((t.noise.noise2(x * 0.8, 3) + 1) * 1.4);
      for (let y = 0; y < depth; y++) t.set(x, y, vary([236, 242, 250], 6, t.rng));
    }
  },
  dirt: (t) => dirt(t),
  coarse_dirt(t) {
    dirt(t, [118, 86, 60]);
    t.speckle([120, 116, 112], 0.12);
    t.speckle([88, 64, 44], 0.08);
  },
  stone: (t) => stone(t),
  cobblestone: (t) => cobble(t),
  mossy_cobblestone: (t) => cobble(t, [118, 118, 120], true),
  sand(t) {
    t.blend([222, 210, 160], [206, 190, 138], 3, 6);
    t.speckle([190, 170, 120], 0.06);
    t.speckle([240, 232, 196], 0.05);
  },
  sandstone_side(t) {
    for (let y = 0; y < S; y++) {
      const band = y < 4 ? 1.02 : y < 7 ? 0.93 : y < 12 ? 0.98 : 0.9;
      for (let x = 0; x < S; x++) t.set(x, y, vary(mul([214, 198, 146], band), 5, t.rng));
    }
    for (let x = 0; x < S; x++) t.set(x, 3, [188, 168, 116]);
  },
  sandstone_top(t) {
    t.blend([220, 205, 152], [208, 190, 140], 4, 4);
    frame(t, [194, 176, 124]);
  },
  gravel(t) {
    t.fill([112, 104, 100], 6);
    for (let k = 0; k < 22; k++) {
      const x = t.rng.int(0, 15), y = t.rng.int(0, 15);
      const c = t.rng.pick([[140, 134, 130], [96, 90, 88], [128, 112, 98], [160, 156, 150]]);
      t.set(x, y, c);
      t.set(x + 1, y, c);
      t.set(x, y + 1, mul(c, 0.8));
    }
  },
  clay(t) {
    t.blend([162, 168, 184], [148, 154, 170], 4, 4);
    t.speckle([176, 182, 196], 0.04);
  },
  snow(t) {
    t.blend([242, 248, 255], [222, 232, 246], 3, 3);
  },
  ice(t) {
    t.fill([150, 196, 240], 6, 180);
    for (let k = 0; k < 4; k++) {
      const x0 = t.rng.int(0, 15), y0 = t.rng.int(0, 15);
      for (let s = 0; s < 5; s++) t.set((x0 + s) % 16, (y0 + s) % 16, [225, 240, 255], 210);
    }
  },
  water(t) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = t.noise.noise2(x / 3, y / 1.6);
      const v = 200 + n * 30;
      t.set(x, y, [v, v, v], 175);
    }
  },
  lava(t) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const n = t.noise.noise2(x / 3, y / 3);
      const c = n > 0.35 ? [255, 222, 90] : n > -0.2 ? [240, 120, 30] : [176, 58, 20];
      t.set(x, y, vary(c, 10, t.rng));
    }
  },
  bedrock(t) {
    t.fill([60, 60, 62], 10);
    for (let k = 0; k < 30; k++) t.set(t.rng.int(0, 15), t.rng.int(0, 15), t.rng() < 0.5 ? [24, 24, 26] : [104, 104, 108]);
  },
  oak_log: (t) => logSide(t, [104, 80, 50]),
  oak_log_top: (t) => logTop(t, [178, 142, 92], [96, 74, 46]),
  pine_log: (t) => logSide(t, [72, 52, 36]),
  pine_log_top: (t) => logTop(t, [150, 112, 70], [64, 46, 32]),
  birch_log(t) {
    t.blend([226, 222, 210], [204, 200, 190], 4, 5);
    for (let k = 0; k < 7; k++) {
      const x = t.rng.int(0, 13), y = t.rng.int(0, 15);
      for (let w = 0; w < t.rng.int(2, 4); w++) t.set(x + w, y, [40, 38, 36]);
    }
  },
  birch_log_top: (t) => logTop(t, [206, 190, 140], [218, 214, 202]),
  dark_log: (t) => logSide(t, [62, 46, 42], [40, 30, 30]),
  dark_log_top: (t) => logTop(t, [112, 82, 62], [54, 40, 38]),
  oak_planks: (t) => planks(t, [172, 136, 86]),
  pine_planks: (t) => planks(t, [124, 92, 60]),
  birch_planks: (t) => planks(t, [206, 186, 136]),
  dark_planks: (t) => planks(t, [86, 62, 46]),
  oak_leaves: (t) => leaves(t, true),
  pine_leaves: (t) => leaves(t, false, [48, 92, 60]),
  birch_leaves: (t) => leaves(t, false, [118, 160, 72]),
  dark_leaves: (t) => leaves(t, true),
  oak_sapling(t) {
    t.clear();
    t.sprite(['......LL........', '....LLLLL.......', '...LLLGLLL......', '....LLGLL.LL....', '......G..LLLL...', '......G.LLGL....', '.LL...G...G.....', 'LLLL..G..G......', '.LLLL.G.G.......', '...LGGGG........', '......G.........', '......G.........', '......G.........', '.....GG.........', '......G.........', '......G.........'], { L: [70, 140, 50], G: [96, 72, 40] }, 2, 0);
  },
  pine_sapling(t) {
    t.clear();
    t.sprite(['.......L........', '......LLL.......', '.....LLLLL......', '.......G........', '....LLLLLLL.....', '...LLLLGLLLL....', '.......G........', '..LLLLLGLLLLL...', '.......G........', '.......G........', '.......G........', '.......G........'], { L: [44, 90, 58], G: [80, 58, 38] }, 0, 4);
  },
  birch_sapling(t) {
    t.clear();
    t.sprite(['.....LL..LL.....', '....LLLLLLLL....', '.....LLGGLL.....', '...LL..W..LL....', '..LLLL.W.LLLL...', '...LL..W..LL....', '.......W........', '.......W........', '.......W........', '.......W........'], { L: [118, 168, 72], G: [100, 140, 60], W: [220, 216, 204] }, 0, 6);
  },
  dark_sapling(t) {
    t.clear();
    t.sprite(['...LLLLLLLLL....', '..LLLLLLLLLLL...', '...LLLLGLLLL....', '.......G........', '.......G........', '......GG........', '.......G........', '.......G........'], { L: [52, 96, 40], G: [62, 46, 40] }, 0, 8);
  },
  tall_grass(t) {
    t.clear();
    for (let k = 0; k < 9; k++) {
      let x = 1 + k * 1.6 + t.rng() * 1.2;
      const h = 6 + t.rng.int(0, 8);
      const lean = (t.rng() - 0.5) * 0.25;
      for (let y = 15; y > 15 - h; y--) {
        const v = 122 + (15 - y) * 5 + t.rng() * 18;
        t.set(Math.round(x), y, [v, v, v], TINT_A);
        x += lean;
      }
    }
  },
  flower_red(t) {
    t.clear();
    t.sprite(['.....R.R......', '....RRYRR.....', '...RRYYYRR....', '....RRYRR.....', '.....R.R......', '.......G......', '......GG.LL...', '..LL...G.L....', '...L...G......', '.......G......', '.......G......'], { R: [212, 46, 52], Y: [250, 210, 80], G: [60, 120, 40], L: [80, 150, 50] }, 1, 4);
  },
  flower_yellow(t) {
    t.clear();
    t.sprite(['.....YYY......', '....YYOYY.....', '....YOOOY.....', '....YYOYY.....', '.....YYY......', '.......G......', '...LL..G......', '....L..G.LL...', '.......GLL....', '.......G......', '.......G......'], { Y: [248, 214, 52], O: [222, 140, 30], G: [60, 120, 40], L: [80, 150, 50] }, 1, 4);
  },
  flower_blue(t) {
    t.clear();
    t.sprite(['......G.......', '.....GGG......', '....BBGBB.....', '...BBBBBBB....', '...BWBBBWB....', '....B.G.B.....', '......G.......', '..LL..G.......', '...LL.G..LL...', '......G.LL....', '......G.......', '......G.......'], { B: [84, 130, 230], W: [220, 236, 255], G: [60, 120, 40], L: [80, 150, 50] }, 1, 3);
  },
  dead_bush(t) {
    t.clear();
    const c = [140, 100, 56];
    const branches = [[7, 15, 0, -1, 9], [7, 10, -1, -1, 5], [7, 8, 1, -1, 5], [7, 12, 1, -1, 4], [6, 9, -1, 0, 3]];
    for (const [x0, y0, dx, dy, n] of branches) for (let s = 0; s < n; s++) t.set(x0 + dx * s, y0 + dy * s, vary(c, 12, t.rng));
  },
  cactus_side(t) {
    t.clear();
    for (let y = 0; y < S; y++) for (let x = 1; x < 15; x++) {
      const rib = x % 4 === 1 ? 0.78 : 1;
      t.set(x, y, vary(mul([70, 140, 60], rib), 8, t.rng));
    }
    for (let k = 0; k < 10; k++) t.set(1 + t.rng.int(0, 13), t.rng.int(0, 15), [226, 224, 180]);
  },
  cactus_top(t) {
    t.clear();
    t.rect(1, 1, 14, 14, [80, 150, 66]);
    frame(t, [56, 110, 48], 1);
    t.rect(6, 6, 4, 4, [104, 170, 80]);
  },
  glowcap(t) {
    t.clear();
    t.sprite(['....CCCCCC......', '...CCWCCCWC.....', '..CCCCCCCCCC....', '..DDDDDDDDDD....', '......SS........', '......SS........', '......SS........', '.....SSSS.......'], { C: [70, 230, 220], W: [210, 255, 250], D: [40, 150, 160], S: [210, 200, 180] }, 1, 7);
  },
  stone_bricks(t) {
    bricks(t, [128, 128, 132], [76, 76, 80], 8, 16);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) if (t.noise.noise2(x / 3, y / 3) > 0.6) t.set(x, y, [104, 104, 108]);
  },
  bricks: (t) => bricks(t, [160, 72, 56], [186, 176, 160], 4, 8),
  glass(t) {
    t.clear();
    frame(t, [210, 230, 236]);
    for (let s = 0; s < 4; s++) t.set(3 + s, 4 - s + 0, [240, 250, 255], 255);
    for (let s = 0; s < 3; s++) t.set(9 + s, 12 - s, [240, 250, 255], 255);
  },
  pane_top(t) {
    t.fill([200, 222, 230], 4);
  },
  chiseled_stone(t) {
    stone(t, [132, 132, 136]);
    frame(t, [96, 96, 100], 1);
    frame(t, [150, 150, 154], 3);
    frame(t, [96, 96, 100], 5);
  },
  smooth_stone(t) {
    t.blend([168, 168, 170], [156, 156, 160], 5, 3);
    frame(t, [124, 124, 128]);
  },
  door_bottom(t) {
    planks(t, [150, 112, 68]);
    frame(t, [104, 76, 46]);
    t.rect(11, 6, 2, 2, [60, 60, 64]);
  },
  door_top(t) {
    planks(t, [150, 112, 68]);
    frame(t, [104, 76, 46]);
    for (const [x, y] of [[3, 3], [9, 3], [3, 9], [9, 9]]) t.rect(x, y, 4, 4, [0, 0, 0], 0);
  },
  trapdoor(t) {
    planks(t, [150, 112, 68]);
    frame(t, [104, 76, 46]);
    for (const [x, y] of [[3, 3], [9, 3], [3, 9], [9, 9]]) t.rect(x, y, 3, 3, [0, 0, 0], 0);
  },
  ladder(t) {
    t.clear();
    for (let y = 0; y < S; y++) {
      t.set(2, y, vary([132, 98, 60], 8, t.rng));
      t.set(3, y, vary([112, 82, 50], 8, t.rng));
      t.set(12, y, vary([132, 98, 60], 8, t.rng));
      t.set(13, y, vary([112, 82, 50], 8, t.rng));
    }
    for (const y of [2, 6, 10, 14]) for (let x = 4; x < 12; x++) t.set(x, y, vary([150, 112, 68], 6, t.rng));
  },
  torch(t) {
    t.clear();
    for (let y = 6; y < S; y++) {
      t.set(7, y, [120, 88, 52]);
      t.set(8, y, [96, 70, 40]);
    }
    t.sprite(['.Y.', 'YWY', 'OYO', '.O.'], { Y: [255, 220, 90], W: [255, 255, 220], O: [240, 140, 40] }, 6, 2);
    t.set(7, 6, [80, 60, 40]);
    t.set(8, 6, [80, 60, 40]);
  },
  lantern(t) {
    t.clear();
    t.rect(5, 6, 6, 9, [60, 60, 70]);
    t.rect(6, 8, 4, 6, [255, 210, 110]);
    t.rect(7, 9, 2, 3, [255, 245, 200]);
    t.rect(6, 5, 4, 1, [80, 80, 90]);
    t.set(7, 4, [80, 80, 90]);
    t.set(8, 4, [80, 80, 90]);
  },
  workbench_top(t) {
    planks(t, [172, 136, 86]);
    frame(t, [110, 82, 50]);
    for (let i = 1; i < 15; i++) {
      t.set(i, 5, [124, 92, 56]);
      t.set(i, 10, [124, 92, 56]);
      t.set(5, i, [124, 92, 56]);
      t.set(10, i, [124, 92, 56]);
    }
  },
  workbench_side(t) {
    planks(t, [150, 116, 72]);
    t.rect(0, 0, 16, 3, [110, 82, 50]);
    t.sprite(['.MMM.', '..W..', '..W..', '..W..'], { M: [150, 150, 156], W: [96, 70, 42] }, 2, 5);
    t.sprite(['MMMMM', 'M...M', 'MMMMM'], { M: [170, 170, 176] }, 9, 6);
  },
  workbench_front(t) {
    planks(t, [150, 116, 72]);
    t.rect(0, 0, 16, 3, [110, 82, 50]);
    t.sprite(['WW.......', 'WWW......', '.WWW.....', '..WWW....', '...WWWW..', '....W.MMM', '......MMM'], { W: [96, 70, 42], M: [160, 160, 166] }, 3, 5);
  },
  furnace_side(t) {
    stone(t, [118, 118, 122]);
    frame(t, [90, 90, 94]);
  },
  furnace_top(t) {
    t.blend([130, 130, 134], [116, 116, 120], 4, 4);
    frame(t, [90, 90, 94]);
  },
  furnace_front(t) {
    P.furnace_side(t);
    t.rect(4, 8, 8, 5, [26, 24, 24]);
    t.rect(4, 7, 8, 1, [70, 70, 74]);
    t.rect(5, 3, 6, 2, [70, 70, 74]);
  },
  furnace_front_lit(t) {
    P.furnace_front(t);
    for (let x = 5; x < 11; x++) {
      const h = 2 + t.rng.int(0, 2);
      for (let y = 12; y > 12 - h; y--) t.set(x, y, y > 10 ? [255, 160, 50] : [255, 220, 100]);
    }
  },
  chest_front(t) {
    planks(t, [156, 112, 58]);
    frame(t, [92, 64, 34]);
    t.rect(1, 6, 14, 1, [92, 64, 34]);
    t.rect(7, 5, 2, 4, [200, 196, 180]);
    t.set(7, 7, [60, 60, 64]);
  },
  chest_side(t) {
    planks(t, [156, 112, 58]);
    frame(t, [92, 64, 34]);
    t.rect(1, 6, 14, 1, [92, 64, 34]);
  },
  chest_top(t) {
    planks(t, [156, 112, 58]);
    frame(t, [92, 64, 34]);
  },
  bed_head_top(t) {
    t.fill([176, 40, 48], 6);
    t.rect(2, 1, 12, 5, [236, 236, 230]);
    frame(t, [130, 30, 36]);
  },
  bed_foot_top(t) {
    t.fill([176, 40, 48], 6);
    for (let y = 2; y < S; y += 4) for (let x = 0; x < S; x++) t.set(x, y, [150, 30, 40]);
    frame(t, [130, 30, 36]);
  },
  bed_side(t) {
    t.clear();
    t.rect(0, 0, 16, 5, [176, 40, 48]);
    t.rect(0, 5, 16, 4, [150, 112, 68]);
    t.rect(0, 9, 2, 7, [120, 88, 52]);
    t.rect(14, 9, 2, 7, [120, 88, 52]);
  },
  coal_ore: (t) => ore(t, [[40, 40, 42], [24, 24, 26]], 6, 3),
  copper_ore: (t) => ore(t, [[214, 124, 74], [96, 170, 140], [180, 96, 60]], 5, 3),
  iron_ore: (t) => ore(t, [[214, 176, 150], [190, 150, 126]], 5, 3),
  gold_ore: (t) => ore(t, [[250, 214, 60], [230, 180, 40]], 4, 3),
  ember_ore: (t) => ore(t, [[240, 60, 40], [255, 120, 60]], 6, 2),
  crystal_ore: (t) => ore(t, [[90, 200, 250], [160, 230, 255]], 4, 3),
  starstone_ore: (t) => ore(t, [[230, 220, 255], [170, 140, 250]], 3, 2),
  farmland(t) {
    dirt(t, [104, 72, 48]);
    for (let y = 1; y < S; y += 4) for (let x = 0; x < S; x++) t.set(x, y, [76, 52, 34]);
  },
  farmland_wet(t) {
    dirt(t, [74, 50, 34]);
    for (let y = 1; y < S; y += 4) for (let x = 0; x < S; x++) t.set(x, y, [52, 36, 24]);
  },
  wheat_0: (t) => cropStage(t, 0, 'wheat'),
  wheat_1: (t) => cropStage(t, 1, 'wheat'),
  wheat_2: (t) => cropStage(t, 2, 'wheat'),
  wheat_3: (t) => cropStage(t, 3, 'wheat'),
  carrots_0: (t) => cropStage(t, 0, 'carrots'),
  carrots_1: (t) => cropStage(t, 1, 'carrots'),
  carrots_2: (t) => cropStage(t, 2, 'carrots'),
  carrots_3: (t) => cropStage(t, 3, 'carrots'),
  wool(t) {
    t.blend([236, 234, 228], [214, 212, 206], 2, 6);
  },
  hay_side(t) {
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) t.set(x, y, vary(x % 3 === 0 ? [190, 156, 54] : [214, 182, 70], 10, t.rng));
    for (const y of [3, 12]) for (let x = 0; x < S; x++) t.set(x, y, [130, 90, 40]);
  },
  hay_top(t) {
    t.fill([206, 172, 64], 14);
    frame(t, [160, 124, 44]);
  },
  iron_block(t) {
    t.blend([214, 214, 220], [196, 196, 204], 5, 3);
    frame(t, [150, 150, 158]);
    t.rect(1, 1, 14, 1, [236, 236, 242]);
  },
  gold_block(t) {
    t.blend([250, 214, 70], [236, 190, 50], 5, 3);
    frame(t, [190, 140, 30]);
    t.rect(1, 1, 14, 1, [255, 240, 150]);
  },
  crystal_lamp(t) {
    t.fill([70, 150, 200], 6);
    frame(t, [60, 80, 96]);
    t.rect(4, 4, 8, 8, [170, 236, 255]);
    t.rect(6, 6, 4, 4, [240, 255, 255]);
  },
  totem_side(t) {
    t.blend([40, 30, 52], [28, 22, 36], 3, 5);
    t.sprite(['..P..', '.PPP.', 'P.P.P', '..P..', '.P.P.'], { P: [190, 90, 255] }, 5, 5);
    frame(t, [20, 16, 26]);
  },
  totem_top(t) {
    t.blend([40, 30, 52], [28, 22, 36], 3, 5);
    t.rect(6, 6, 4, 4, [170, 70, 240]);
  },
  crack_0: (t) => crack(t, 0),
  crack_1: (t) => crack(t, 1),
  crack_2: (t) => crack(t, 2),
  crack_3: (t) => crack(t, 3),
  crack_4: (t) => crack(t, 4),
  crack_5: (t) => crack(t, 5),
  crack_6: (t) => crack(t, 6),
  crack_7: (t) => crack(t, 7),
  crystal_block(t) {
    // Faceted crystal: Voronoi facets, each shaded as if lit from the top-left, with glints.
    const seeds = Array.from({ length: 7 }, () => [t.rng() * 16, t.rng() * 16, 0.7 + t.rng() * 0.5]);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        let best = 99, second = 99, bi = 0;
        seeds.forEach(([sx, sy], i) => {
          for (const ox of [-16, 0, 16]) for (const oy of [-16, 0, 16]) {
            const d = Math.hypot(x - sx - ox, y - sy - oy);
            if (d < best) { second = best; best = d; bi = i; } else if (d < second) second = d;
          }
        });
        const edge = second - best < 1;
        const f = seeds[bi][2];
        t.set(x, y, vary(edge ? [170, 230, 255] : mul([70, 160, 225], f), 6, t.rng));
      }
    }
    for (let k = 0; k < 5; k++) t.set(t.rng.int(1, 14), t.rng.int(1, 14), [235, 250, 255]);
  },
  bookshelf(t) {
    planks(t, [160, 124, 76]);
    for (const row of [1, 9]) {
      let x = 1;
      while (x < 15) {
        const w = t.rng.int(1, 2);
        const c = t.rng.pick([[150, 40, 40], [40, 80, 150], [60, 120, 60], [170, 140, 60], [110, 60, 120]]);
        t.rect(x, row, w, 6, c);
        x += w + (t.rng() < 0.2 ? 1 : 0);
      }
    }
  },
  fence_post: (t) => planks(t, [172, 136, 86]),
};

/** Paint one tile by name into a fresh Tile. */
export function paintTile(name) {
  const t = new Tile(hash4(TILE_NAMES.indexOf(name) + 1, 1234));
  const painter = P[name];
  if (!painter) throw new Error(`No painter for tile ${name}`);
  painter(t);
  return t.d;
}

/** Build the full block atlas as RGBA pixels (width = ATLAS_COLS*16, height = ATLAS_ROWS*16). */
export function buildAtlasPixels() {
  const W = ATLAS_COLS * S, H = ATLAS_ROWS * S;
  const out = new Uint8Array(W * H * 4);
  TILE_NAMES.forEach((name, idx) => {
    const px = paintTile(name);
    const ox = (idx % ATLAS_COLS) * S, oy = Math.floor(idx / ATLAS_COLS) * S;
    for (let y = 0; y < S; y++) out.set(px.subarray(y * S * 4, (y + 1) * S * 4), ((oy + y) * W + ox) * 4);
  });
  return { pixels: out, width: W, height: H };
}

export { Tile, TINT_A };
