// The Void Isles: a large main island ringed by obsidian pillars topped with void crystals,
// plus sparse floating islands far out. Everything else is void.
import { CHUNK_SIZE, CHUNK_VOLUME } from '../config/constants.js';
import { SimplexNoise, hashSeed, hash4 } from '../util/noise.js';
import { B } from './blocks.js';
import { BIOMES, BIOME } from './biomes.js';
import { localIndex } from './coords.js';

export const END_TOP = 64;
export const END_ARRIVAL = { x: 0, z: 36 }; // where players land (obsidian platform)
const PILLAR_RING = 32;

export class EndGenerator {
  constructor(seed) {
    this.dimension = 'end';
    this.seed = hash4(hashSeed(seed), 0x454e, 5);
    this.structureFns = [];
    this.nShape = new SimplexNoise(hash4(this.seed, 1));
    this.nIsle = new SimplexNoise(hash4(this.seed, 2));
    this.structCache = new Map();
    this.pillars = Array.from({ length: 10 }, (_, i) => {
      const a = (i / 10) * Math.PI * 2;
      return { x: Math.round(Math.cos(a) * PILLAR_RING), z: Math.round(Math.sin(a) * PILLAR_RING), r: 2 + (i % 3), h: 18 + ((i * 7) % 5) * 4, cage: i % 3 === 0 };
    });
  }

  cachedStructure() {
    return null;
  }

  /** Surface {top, bottom} of the island under (x, z), or null over the void. */
  island(x, z) {
    const d = Math.hypot(x, z);
    const R = 52 + this.nShape.noise2(x / 22, z / 22) * 6;
    if (d < R) {
      const top = END_TOP + Math.round(this.nShape.noise2(x / 9, z / 9) * 1.4);
      return { top, bottom: top - (2 + Math.floor((1 - (d / R) ** 2) * 22)) };
    }
    if (d > 130) {
      const m = this.nIsle.fbm2(x / 70, z / 70, 2);
      if (m > 0.32) {
        const top = 56 + Math.round(this.nIsle.noise2(x / 14, z / 14) * 6);
        return { top, bottom: top - Math.floor(3 + (m - 0.32) * 40) };
      }
    }
    return null;
  }

  climate() {
    return [0, 0];
  }

  column(x, z) {
    const i = this.island(x, z);
    return { h: i ? i.top : 0, biome: BIOME.end, t: 0, hu: 0, mountAmt: 0, detail: 0 };
  }

  biomeAt() {
    return BIOMES[BIOME.end];
  }

  findSpawn() {
    return { x: END_ARRIVAL.x + 0.5, y: this.column(END_ARRIVAL.x, END_ARRIVAL.z).h + 1, z: END_ARRIVAL.z + 0.5 };
  }

  generateChunk(cx, cz) {
    const blocks = new Uint8Array(CHUNK_VOLUME);
    const meta = new Uint8Array(CHUNK_VOLUME);
    const climate = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 2).fill(128);
    const x0 = cx * CHUNK_SIZE, z0 = cz * CHUNK_SIZE;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const x = x0 + lx, z = z0 + lz;
        const isle = this.island(x, z);
        if (isle) for (let y = Math.max(1, isle.bottom); y <= isle.top; y++) blocks[localIndex(lx, y, lz)] = B.void_stone;
        for (const p of this.pillars) {
          const dx = x - p.x, dz = z - p.z;
          if (dx * dx + dz * dz > (p.r + 0.35) * (p.r + 0.35) - 0.5) {
            // Cage of glass panes around the crystal on some pillars.
            if (p.cage && Math.max(Math.abs(dx), Math.abs(dz)) === 2 && Math.abs(dx) <= 2 && Math.abs(dz) <= 2) {
              const top = END_TOP + p.h;
              for (let y = top + 1; y <= top + 3; y++) blocks[localIndex(lx, y, lz)] = B.glass_pane;
            }
            continue;
          }
          const base = isle ? isle.top : END_TOP;
          for (let y = base - 5; y <= END_TOP + p.h; y++) blocks[localIndex(lx, y, lz)] = B.obsidian;
          if (dx === 0 && dz === 0) blocks[localIndex(lx, END_TOP + p.h + 1, lz)] = B.void_crystal;
        }
      }
    }
    return { blocks, meta, climate };
  }
}
