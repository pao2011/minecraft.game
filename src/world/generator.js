// Deterministic terrain generation. Everything here is a pure function of (seed, coordinates),
// which lets any chunk independently reproduce features that cross its borders (trees, structures).
import { CHUNK_SIZE, WORLD_HEIGHT, SEA_LEVEL, LAVA_LEVEL, CHUNK_VOLUME } from '../config/constants.js';
import { SimplexNoise, hashSeed, hash4, hashFloat, makeRng, clamp, lerp, smoothstep } from '../util/noise.js';
import { B } from './blocks.js';
import { BIOMES, BIOME } from './biomes.js';
import { localIndex } from './coords.js';
import { structuresIn, surfaceStructureAt, buildStructure } from './structures.js';

const CAVE_STEP = 4;
const CAVE_GRID_Y = WORLD_HEIGHT / CAVE_STEP + 1;
const TREE_CELL = 5;

export class WorldGenerator {
  constructor(seed) {
    this.seed = hashSeed(seed);
    const n = (k) => new SimplexNoise(hash4(this.seed, k, 7919));
    this.nCont = n(1);
    this.nMount = n(2);
    this.nRidge = n(3);
    this.nHills = n(4);
    this.nDetail = n(5);
    this.nTemp = n(6);
    this.nHumid = n(7);
    this.nJitter = n(8);
    this.nRiver = n(9);
    this.nCave1 = n(10);
    this.nCave2 = n(11);
    this.nCave3 = n(12);
    this.nSurf = n(13);
    this.nFlood = n(14);
    this.structCache = new Map();
  }

  cachedStructure(fn, rx, rz) {
    const key = `${fn.name}:${rx}:${rz}`;
    if (!this.structCache.has(key)) {
      if (this.structCache.size > 512) this.structCache.clear();
      this.structCache.set(key, fn(this, rx, rz));
    }
    return this.structCache.get(key);
  }

  /** Temperature and humidity in [-1, 1]. */
  climate(x, z) {
    const j = this.nJitter.noise2(x / 23, z / 23) * 0.04;
    const t = clamp(this.nTemp.fbm2(x / 1000, z / 1000, 3) * 1.7 + j, -1, 1);
    const h = clamp(this.nHumid.fbm2(x / 900 + 31.7, z / 900 - 11.3, 3) * 1.8 - j, -1, 1);
    return [t, h];
  }

  /** Terrain height, biome and climate for a column. */
  column(x, z) {
    const [t, hu] = this.climate(x, z);
    const c = this.nCont.fbm2(x / 900, z / 900, 4) * 2;
    const m = this.nMount.fbm2(x / 520 + 100, z / 520, 3) * 2;
    const mountAmt = smoothstep(0.45, 0.85, m);
    const ridge = 1 - Math.abs(this.nRidge.fbm2(x / 170, z / 170, 3) * 1.7);
    const hills = this.nHills.fbm2(x / 120, z / 120, 3) * 1.8;
    const detail = this.nDetail.fbm2(x / 30, z / 30, 2);

    const hot = smoothstep(0.32, 0.42, t);
    const swampW = smoothstep(0.55, 0.7, hu) * smoothstep(0.37, 0.27, t) * smoothstep(-0.4, -0.3, t);
    const rockyW = hot * smoothstep(-0.15, -0.05, hu) * smoothstep(0.45, 0.35, hu);
    const desertW = hot * smoothstep(-0.05, -0.15, hu);

    let h = SEA_LEVEL + 6 + c * 11;
    if (c < -0.55) h -= (-0.55 - c) * 30; // lakes and seas in continental lows
    h += hills * lerp(lerp(7, 2, swampW), 3.5, desertW) + detail * 1.6;
    h = lerp(h, SEA_LEVEL + 0.4 + detail * 1.4, swampW * 0.85);
    if (rockyW > 0) {
      const step = 6;
      const terr = Math.floor(h / step) * step + smoothstep(0.7, 1, (h / step) % 1) * step;
      h = lerp(h, terr + 3 + Math.max(0, hills) * 8, rockyW);
    }
    h += mountAmt * (16 + 46 * ridge * ridge);

    // Rivers: a narrow band where low-frequency noise crosses zero.
    const r = Math.abs(this.nRiver.fbm2(x / 650, z / 650, 3) * 2);
    const riverK = smoothstep(0.08, 0.02, r) * (1 - smoothstep(0.3, 0.6, mountAmt));
    if (riverK > 0) h = lerp(h, Math.min(h, SEA_LEVEL - 3 + r * 20), riverK);

    const height = clamp(Math.floor(h), 6, WORLD_HEIGHT - 12);

    let biome;
    if (height < SEA_LEVEL - 2) biome = t < -0.62 ? BIOME.snowy : BIOME.lake;
    else if (mountAmt > 0.5 && height > SEA_LEVEL + 24) biome = BIOME.mountains;
    else if (height <= SEA_LEVEL + 1 && swampW < 0.5 && t > -0.62 && riverK < 0.5) biome = BIOME.beach;
    else if (t < -0.62) biome = BIOME.snowy;
    else if (t < -0.35) biome = hu > -0.3 ? BIOME.taiga : BIOME.plains;
    else if (hot > 0.5) biome = desertW > 0.5 ? BIOME.desert : rockyW > 0.5 ? BIOME.rocky : hu > 0.4 ? BIOME.dense_forest : BIOME.plains;
    else if (swampW > 0.5) biome = BIOME.swamp;
    else if (hu > 0.2) biome = BIOME.dense_forest;
    else if (hu > -0.28) biome = BIOME.forest;
    else biome = BIOME.plains;
    return { h: height, biome, t, hu, mountAmt, detail };
  }

  biomeAt(x, z) {
    return BIOMES[this.column(x, z).biome];
  }

  caveCorner(x, y, z) {
    const n1 = this.nCave1.noise3(x / 52, y / 30, z / 52);
    const n2 = this.nCave2.noise3(x / 52, y / 30, z / 52);
    const cheese = this.nCave3.fbm3(x / 80, y / 34, z / 80, 2);
    return [n1 * n1 + n2 * n2, cheese];
  }

  /** Carve test using the same corner lattice as chunk generation, so single-point queries match. */
  isCave(x, y, z, surfaceH) {
    if (y < 3) return false;
    const gx = Math.floor(x / CAVE_STEP) * CAVE_STEP, gy = Math.floor(y / CAVE_STEP) * CAVE_STEP, gz = Math.floor(z / CAVE_STEP) * CAVE_STEP;
    const fx = (x - gx) / CAVE_STEP, fy = (y - gy) / CAVE_STEP, fz = (z - gz) / CAVE_STEP;
    let tun = 0, che = 0;
    for (let i = 0; i < 8; i++) {
      const ox = i & 1, oy = (i >> 1) & 1, oz = (i >> 2) & 1;
      const w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * (oz ? fz : 1 - fz);
      const [a, b] = this.caveCorner(gx + ox * CAVE_STEP, gy + oy * CAVE_STEP, gz + oz * CAVE_STEP);
      tun += a * w;
      che += b * w;
    }
    return this.carveRule(tun, che, y, surfaceH);
  }

  carveRule(tun, che, y, surfaceH) {
    if (y < 3) return false;
    if (surfaceH <= SEA_LEVEL + 1 && y > surfaceH - 6) return false; // keep seabeds and riverbeds sealed
    const width = y < 32 ? 0.016 : 0.011;
    if (tun < width) return true;
    return che > 0.5 && y < surfaceH - 10 && y < 52;
  }

  treeInCell(cellX, cellZ) {
    const s = this.seed;
    const hsh = hash4(s, cellX, cellZ, 101);
    const x = cellX * TREE_CELL + (hsh % TREE_CELL);
    const z = cellZ * TREE_CELL + ((hsh >>> 8) % TREE_CELL);
    const col = this.column(x, z);
    const biome = BIOMES[col.biome];
    if (!biome.trees.density || hashFloat(s, cellX, cellZ, 102) >= biome.trees.density) return null;
    if (col.h < SEA_LEVEL) return null;
    if (col.biome === BIOME.mountains && col.h > 90) return null;
    if (this.isCave(x, col.h, z, col.h) || this.isCave(x, col.h - 1, z, col.h)) return null;
    if (surfaceStructureAt(this, x, z)) return null;
    const types = biome.trees.types;
    const type = types[(hsh >>> 16) % types.length];
    return { x, z, y: col.h + 1, type, hash: hsh };
  }

  /** True if a tree trunk stands within `r` blocks of (x, z) (spawn must not be under a canopy). */
  treeNear(x, z, r) {
    for (let cx = Math.floor((x - r) / TREE_CELL); cx <= Math.floor((x + r) / TREE_CELL); cx++) {
      for (let cz = Math.floor((z - r) / TREE_CELL); cz <= Math.floor((z + r) / TREE_CELL); cz++) {
        const t = this.treeInCell(cx, cz);
        if (t && Math.abs(t.x - x) <= r && Math.abs(t.z - z) <= r) return true;
      }
    }
    return false;
  }

  /** Generate a full chunk column. Returns typed arrays ready for a Chunk. */
  generateChunk(cx, cz) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const meta = new Uint8Array(CHUNK_VOLUME);
    const climate = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 2);
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const cols = new Array(CHUNK_SIZE * CHUNK_SIZE);
    let maxH = 0;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = this.column(x0 + lx, z0 + lz);
        cols[lz * CHUNK_SIZE + lx] = col;
        maxH = Math.max(maxH, col.h);
        const ci = (lz * CHUNK_SIZE + lx) * 2;
        climate[ci] = Math.round((col.t + 1) * 127.5);
        climate[ci + 1] = Math.round((col.hu + 1) * 127.5);
        this.fillColumn(blocks, lx, lz, x0 + lx, z0 + lz, col);
      }
    }
    this.carveCaves(blocks, x0, z0, cols, maxH);
    this.placeOres(blocks, cx, cz, cols);

    const ctx = makeCtx(blocks, meta, x0, z0);
    this.placeTrees(ctx, x0, z0);
    for (const st of structuresIn(this, x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE)) buildStructure(ctx, this, st);
    this.decorate(blocks, meta, x0, z0, cols);
    return { blocks, meta, climate };
  }

  fillColumn(blocks, lx, lz, x, z, col) {
    const { h, biome } = col;
    const b = BIOMES[biome];
    const s = this.seed;
    const bedrockTop = 1 + (hash4(s, x, z, 11) % 3);
    let top = B[b.surface];
    let sub = B[b.sub];
    let subDepth = 3 + (col.detail > 0.2 ? 1 : 0);
    let deep = b.deep ? B[b.deep] : B.stone;
    if (biome === BIOME.mountains) {
      if (h > 100) {
        top = B.snow;
        sub = B.stone;
      } else if (h > 88) top = sub = B.stone;
    } else if (biome === BIOME.rocky) {
      const d = this.nSurf.noise2(x / 9, z / 9);
      top = d > 0.45 ? B.stone : d < -0.5 ? B.gravel : col.hu > 0.15 && d < -0.1 ? B.grass : B.coarse_dirt;
    }
    if (h < SEA_LEVEL) {
      const d = this.nSurf.noise2(x / 14, z / 14);
      top = d > 0.4 && h > SEA_LEVEL - 7 ? B.clay : d < -0.35 ? B.gravel : B.sand;
      sub = top === B.clay ? B.clay : B.sand;
      subDepth = 2;
      deep = B.stone;
    }
    if (b.deep) subDepth = 4;
    for (let y = 0; y <= h; y++) {
      let id;
      if (y <= bedrockTop) id = B.bedrock;
      else if (y === h) id = top;
      else if (y > h - subDepth) id = sub;
      else if (b.deep && y > h - subDepth - 4) id = deep;
      else id = B.stone;
      blocks[localIndex(lx, y, lz)] = id;
    }
    if (h < SEA_LEVEL) {
      const frozen = col.t < -0.62;
      for (let y = h + 1; y <= SEA_LEVEL; y++) blocks[localIndex(lx, y, lz)] = frozen && y === SEA_LEVEL ? B.ice : B.water;
    }
  }

  carveCaves(blocks, x0, z0, cols, maxH) {
    const gx = CHUNK_SIZE / CAVE_STEP + 1;
    const gyMax = Math.min(CAVE_GRID_Y, Math.ceil((maxH + 2) / CAVE_STEP) + 1);
    const tun = new Float32Array(gx * gx * gyMax);
    const che = new Float32Array(gx * gx * gyMax);
    for (let iy = 0; iy < gyMax; iy++) {
      for (let iz = 0; iz < gx; iz++) {
        for (let ix = 0; ix < gx; ix++) {
          const [a, b] = this.caveCorner(x0 + ix * CAVE_STEP, iy * CAVE_STEP, z0 + iz * CAVE_STEP);
          const gi = (iy * gx + iz) * gx + ix;
          tun[gi] = a;
          che[gi] = b;
        }
      }
    }
    const S = CAVE_STEP;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const col = cols[lz * CHUNK_SIZE + lx];
        const ix = Math.floor(lx / S), iz = Math.floor(lz / S);
        const fx = (lx % S) / S, fz = (lz % S) / S;
        const flooded = this.nFlood.noise2((x0 + lx) / 90, (z0 + lz) / 90) > 0.35;
        for (let y = 3; y <= col.h; y++) {
          const iy = Math.floor(y / S);
          const fy = (y % S) / S;
          let t = 0, c = 0;
          for (let i = 0; i < 8; i++) {
            const ox = i & 1, oy = (i >> 1) & 1, oz = (i >> 2) & 1;
            const w = (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * (oz ? fz : 1 - fz);
            if (w === 0) continue;
            const gi = ((iy + oy) * gx + iz + oz) * gx + ix + ox;
            t += tun[gi] * w;
            c += che[gi] * w;
          }
          if (!this.carveRule(t, c, y, col.h)) continue;
          const idx = localIndex(lx, y, lz);
          if (blocks[idx] === B.water || blocks[idx] === B.bedrock) continue;
          blocks[idx] = y <= LAVA_LEVEL ? (flooded ? B.water : B.lava) : B.air;
        }
      }
    }
  }

  placeOres(blocks, cx, cz, cols) {
    const rng = makeRng(hash4(this.seed, cx, cz, 301));
    const mountain = cols[136].biome === BIOME.mountains;
    const veins = [
      [B.coal_ore, 16 + (mountain ? 8 : 0), 5, 14, 5, 100],
      [B.copper_ore, 9 + (mountain ? 5 : 0), 4, 10, 10, 72],
      [B.iron_ore, 8 + (mountain ? 4 : 0), 3, 8, 5, 64],
      [B.gold_ore, 2.5, 3, 7, 4, 32],
      [B.ember_ore, 3.5, 3, 7, 3, 20],
      [B.crystal_ore, 0.6, 2, 5, 3, 36],
      [B.starstone_ore, 0.45, 1, 4, 3, 16],
      [B.dirt, 4, 10, 24, 10, 90],
      [B.gravel, 4, 10, 24, 5, 90],
    ];
    for (const [ore, count, smin, smax, ymin, ymax] of veins) {
      // Fractional counts become a probability of one extra vein: keeps rare ores rare.
      const n = Math.floor(count) + (rng() < count % 1 ? 1 : 0);
      for (let v = 0; v < n; v++) {
        let x = rng.int(0, 15), y = rng.int(ymin, ymax), z = rng.int(0, 15);
        const size = rng.int(smin, smax);
        for (let i = 0; i < size; i++) {
          if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < WORLD_HEIGHT) {
            const idx = localIndex(x, y, z);
            if (blocks[idx] === B.stone) blocks[idx] = ore;
          }
          const d = rng.int(0, 5);
          if (d === 0) x++; else if (d === 1) x--; else if (d === 2) z++; else if (d === 3) z--; else if (d === 4) y++; else y--;
        }
      }
    }
  }

  placeTrees(ctx, x0, z0) {
    const c0x = Math.floor((x0 - 3) / TREE_CELL), c1x = Math.floor((x0 + CHUNK_SIZE + 3) / TREE_CELL);
    const c0z = Math.floor((z0 - 3) / TREE_CELL), c1z = Math.floor((z0 + CHUNK_SIZE + 3) / TREE_CELL);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        const tree = this.treeInCell(cx, cz);
        if (tree) growTree(ctx, tree);
      }
    }
  }

  decorate(blocks, meta, x0, z0, cols) {
    const s = this.seed;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = x0 + lx, z = z0 + lz;
        const col = cols[lz * CHUNK_SIZE + lx];
        const b = BIOMES[col.biome];
        const y = col.h;
        const ground = blocks[localIndex(lx, y, lz)];
        // Cave floors: rare glowing fungi in the dark.
        for (let cy = 4; cy < Math.min(y - 4, 50); cy++) {
          const i = localIndex(lx, cy, lz);
          if (blocks[i] === B.air && blocks[i - 256] === B.stone && hashFloat(s, x, cy, z + 9901) < 0.006) blocks[i] = B.glowcap;
        }
        if (y + 1 >= WORLD_HEIGHT || blocks[localIndex(lx, y + 1, lz)] !== B.air) continue;
        const r = hashFloat(s, x, z, 401);
        const above = localIndex(lx, y + 1, lz);
        if (ground === B.grass || ground === B.snow_grass) {
          if (r < b.flowers) {
            const cold = col.biome === BIOME.taiga || col.biome === BIOME.snowy || col.biome === BIOME.mountains;
            blocks[above] = cold ? B.flower_blue : hashFloat(s, x, z, 402) < 0.5 ? B.flower_red : B.flower_yellow;
          } else if (r < b.flowers + b.grass) blocks[above] = B.tall_grass;
          else if (col.biome === BIOME.swamp && r > 0.996) blocks[above] = B.glowcap;
        } else if (ground === B.sand && col.biome === BIOME.desert) {
          if (r < 0.005) {
            const hgt = 1 + (hash4(s, x, z, 403) % 3);
            for (let k = 1; k <= hgt && y + k < WORLD_HEIGHT; k++) blocks[localIndex(lx, y + k, lz)] = B.cactus;
          } else if (r < 0.012) blocks[above] = B.dead_bush;
        } else if (ground === B.coarse_dirt && r < 0.01) blocks[above] = B.dead_bush;
      }
    }
  }

  /** A safe spawn column near the origin: dry land, open sky, no tree trunk. */
  findSpawn() {
    for (let radius = 0; radius < 512; radius += 8) {
      const steps = Math.max(1, radius / 2);
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const x = Math.round(Math.cos(a) * radius), z = Math.round(Math.sin(a) * radius);
        const col = this.column(x, z);
        if (col.h < SEA_LEVEL + 1 || col.h > SEA_LEVEL + 30) continue;
        if (col.biome === BIOME.lake || col.biome === BIOME.mountains) continue;
        if (this.isCave(x, col.h, z, col.h) || this.isCave(x, col.h + 1, z, col.h)) continue;
        if (surfaceStructureAt(this, x, z)) continue;
        if (this.treeNear(x, z, 3)) continue;
        return { x: x + 0.5, y: col.h + 1, z: z + 0.5 };
      }
    }
    return { x: 0.5, y: this.column(0, 0).h + 1, z: 0.5 };
  }
}

function makeCtx(blocks, meta, x0, z0) {
  return {
    set(x, y, z, id, m = 0) {
      const lx = x - x0, lz = z - z0;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 1 || y >= WORLD_HEIGHT) return;
      const i = localIndex(lx, y, lz);
      blocks[i] = id;
      meta[i] = m;
    },
    /** Write only into air or replaceable vegetation (used by trees). */
    soft(x, y, z, id, m = 0) {
      const lx = x - x0, lz = z - z0;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE || y < 1 || y >= WORLD_HEIGHT) return;
      const i = localIndex(lx, y, lz);
      const cur = blocks[i];
      if (cur === B.air || cur === B.tall_grass || cur === B.flower_red || cur === B.flower_yellow || cur === B.flower_blue) {
        blocks[i] = id;
        meta[i] = m;
      }
    },
  };
}

/** Grow a tree into the chunk context. Also used at runtime for saplings via the same shapes. */
export function growTree(ctx, tree) {
  const { x, y, z, type, hash } = tree;
  const rnd = (a, b, c) => hashFloat(hash, a, b, c);
  const logId = B[`${type}_log`];
  const leafId = B[`${type}_leaves`];
  let trunk;
  const leaf = (lx, ly, lz) => ctx.soft(lx, ly, lz, leafId);
  if (type === 'pine') {
    trunk = 6 + (hash % 4);
    const top = y + trunk;
    leaf(x, top, z);
    leaf(x, top + 1, z);
    for (let ly = top - 1, i = 1; ly >= y + 2; ly--, i++) {
      // Alternate wide and narrow rings, widening toward the base.
      const r = i % 2 === 1 ? Math.min(3, 1 + Math.floor(i / 3)) : 1;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) if (dx * dx + dz * dz <= r * r + 0.5) leaf(x + dx, ly, z + dz);
      }
    }
  } else if (type === 'dark') {
    trunk = 4 + (hash % 3);
    const top = y + trunk;
    for (let ly = top - 2; ly <= top + 1; ly++) {
      const r = ly >= top + 1 ? 2 : 3;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const d = dx * dx + dz * dz;
          if (d > r * r + 1 || (d > r * r - 2 && rnd(dx, ly, dz) < 0.4)) continue;
          leaf(x + dx, ly, z + dz);
        }
      }
    }
  } else {
    const birch = type === 'birch';
    trunk = (birch ? 5 : 4) + (hash % 3);
    const top = y + trunk;
    for (let ly = top - 2; ly <= top + 1; ly++) {
      const r = ly >= top ? 1 : birch ? 1 + (ly === top - 2 ? 1 : 0) : 2;
      for (let dx = -r; dx <= r; dx++) {
        for (let dz = -r; dz <= r; dz++) {
          const corner = Math.abs(dx) === r && Math.abs(dz) === r;
          if (corner && (ly === top + 1 || rnd(dx, ly, dz) < 0.5)) continue;
          leaf(x + dx, ly, z + dz);
        }
      }
    }
  }
  for (let ly = y; ly < y + trunk; ly++) ctx.set(x, ly, z, logId, 0);
  ctx.set(x, y - 1, z, B.dirt);
}
