// The Cinder Wastes: a bedrock-capped cavern world with a lava sea. Carved from one 3D noise
// field sampled on a 4-block lattice (same trick as overworld caves), then ores, glow clusters
// and the occasional ruined keep. Pure function of (seed, x, y, z) like the overworld.
import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME } from '../config/constants.js';
import { SimplexNoise, hashSeed, hash4, hashFloat, makeRng, clamp } from '../util/noise.js';
import { B } from './blocks.js';
import { BIOMES, BIOME } from './biomes.js';
import { localIndex } from './coords.js';
import { structuresIn, buildStructure, NETHER_STRUCTURES } from './structures.js';
import { makeCtx } from './generator.js';

export const NETHER_LAVA = 31;
const STEP = 4;
const GY = WORLD_HEIGHT / STEP + 1;

export class NetherGenerator {
  constructor(seed) {
    this.dimension = 'nether';
    this.seed = hash4(hashSeed(seed), 0x4e45, 3);
    this.structureFns = NETHER_STRUCTURES;
    this.nA = new SimplexNoise(hash4(this.seed, 1));
    this.nB = new SimplexNoise(hash4(this.seed, 2));
    this.structCache = new Map();
  }

  cachedStructure(fn, rx, rz) {
    const key = `${fn.name}:${rx}:${rz}`;
    if (!this.structCache.has(key)) {
      if (this.structCache.size > 256) this.structCache.clear();
      this.structCache.set(key, fn(this, rx, rz));
    }
    return this.structCache.get(key);
  }

  /** Raw noise lattice value in about [-1, 1]. */
  noiseAt(x, y, z) {
    return this.nA.fbm3(x / 46, y / 26, z / 46, 2) * 0.8 + this.nB.noise3(x / 14, y / 10, z / 14) * 0.2;
  }

  /** Blocks are open where noise plus a bias that favors the middle heights is high enough. */
  isOpen(n, y) {
    if (y < 8 || y > 120) return false;
    const vert = 1 - Math.pow(Math.min(1, Math.abs(y - 64) / 58), 1.2);
    return n * 0.9 + vert * 0.6 > 0.22;
  }

  climate() {
    return [0, 0];
  }

  column() {
    return { h: 64, biome: BIOME.nether, t: 0, hu: 0, mountAmt: 0, detail: 0 };
  }

  biomeAt() {
    return BIOMES[BIOME.nether];
  }

  findSpawn() {
    return { x: 0.5, y: 64, z: 0.5 };
  }

  generateChunk(cx, cz) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const meta = new Uint8Array(CHUNK_VOLUME);
    const climate = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 2).fill(128);
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    const gx = CHUNK_SIZE / STEP + 1;
    const grid = new Float32Array(gx * gx * GY);
    for (let iy = 0; iy < GY; iy++) {
      for (let iz = 0; iz < gx; iz++) {
        for (let ix = 0; ix < gx; ix++) grid[(iy * gx + iz) * gx + ix] = this.noiseAt(x0 + ix * STEP, iy * STEP, z0 + iz * STEP);
      }
    }
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const fx = (lx % STEP) / STEP, fz = (lz % STEP) / STEP;
        const ix = Math.floor(lx / STEP), iz = Math.floor(lz / STEP);
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const idx = localIndex(lx, y, lz);
          let id;
          if (y === 0 || y === WORLD_HEIGHT - 1) id = B.bedrock;
          else if ((y <= 2 && hashFloat(this.seed, x0 + lx, y, z0 + lz) < 0.6 - y * 0.2) || (y >= WORLD_HEIGHT - 3 && hashFloat(this.seed, x0 + lx, y, z0 + lz) < 0.7)) id = B.bedrock;
          else {
            const iy = Math.floor(y / STEP), fy = (y % STEP) / STEP;
            let n = 0;
            for (let i = 0; i < 8; i++) {
              const ox = i & 1, oy = (i >> 1) & 1, oz = (i >> 2) & 1;
              n += grid[((iy + oy) * gx + iz + oz) * gx + ix + ox] * (ox ? fx : 1 - fx) * (oy ? fy : 1 - fy) * (oz ? fz : 1 - fz);
            }
            if (this.isOpen(n, y)) id = y <= NETHER_LAVA ? B.lava : B.air;
            else id = B.cinderrock;
          }
          blocks[idx] = id;
        }
      }
    }
    this.decorate(blocks, x0, z0);
    this.placeOres(blocks, cx, cz);
    const ctx = makeCtx(blocks, meta, x0, z0);
    for (const st of structuresIn(this, x0, z0, x0 + CHUNK_SIZE, z0 + CHUNK_SIZE)) buildStructure(ctx, this, st);
    return { blocks, meta, climate };
  }

  /** Glowing lumenstone clusters on ceilings and magma around the lava shore. */
  decorate(blocks, x0, z0) {
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        for (let y = 4; y < WORLD_HEIGHT - 4; y++) {
          const i = localIndex(lx, y, lz);
          if (blocks[i] !== B.cinderrock) continue;
          const r = hashFloat(this.seed, x0 + lx, y, z0 + lz + 5000);
          const below = blocks[i - 256];
          if (below === B.air && r < 0.012) blocks[i] = B.lumen_stone;
          else if (y >= NETHER_LAVA - 1 && y <= NETHER_LAVA + 1 && r < 0.3 && (blocks[i + 256] === B.air || blocks[i + 256] === B.lava || below === B.lava)) blocks[i] = B.magma_block;
        }
      }
    }
  }

  placeOres(blocks, cx, cz) {
    const rng = makeRng(hash4(this.seed, cx, cz, 901));
    const veins = [
      [B.quartz_ore, 18, 5, 9, 10, 118],
      [B.nether_gold_ore, 10, 4, 8, 10, 117],
      [B.abyssal_ore, 1.3, 1, 3, 8, 22],
      [B.magma_block, 3, 4, 8, 24, 40],
    ];
    for (const [ore, count, smin, smax, ymin, ymax] of veins) {
      const n = Math.floor(count) + (rng() < count % 1 ? 1 : 0);
      for (let v = 0; v < n; v++) {
        let x = rng.int(0, 15), y = rng.int(ymin, ymax), z = rng.int(0, 15);
        const size = rng.int(smin, smax);
        for (let i = 0; i < size; i++) {
          if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 2 && y < WORLD_HEIGHT - 3) {
            const idx = localIndex(x, y, z);
            if (blocks[idx] === B.cinderrock) blocks[idx] = ore;
          }
          const d = rng.int(0, 5);
          if (d === 0) x++; else if (d === 1) x--; else if (d === 2) z++; else if (d === 3) z--; else if (d === 4) y++; else y--;
        }
      }
    }
  }
}

export { clamp };
