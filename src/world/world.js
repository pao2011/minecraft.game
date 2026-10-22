// The World owns loaded chunks and every rule that changes blocks: edits, light, neighbor
// support, fluids and random ticks. It has no rendering dependency so it is unit-testable.
import { CHUNK_SIZE, WORLD_HEIGHT, SECTION_SIZE, SECTIONS_PER_CHUNK, WORLD_BORDER } from '../config/constants.js';
import { BLOCKS, B, EMIT, OPACITY, SOLID, OPAQUE } from './blocks.js';
import { chunkKey, toChunk, posKey } from './coords.js';
import { LightEngine } from './lighting.js';
import { WorldGenerator, growTree } from './generator.js';
import { getBoxes } from './shapes.js';
import { hash4 } from '../util/noise.js';

const NEIGHBORS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

export class World {
  constructor(seed) {
    this.seed = seed;
    this.generator = new WorldGenerator(seed);
    this.chunks = new Map();
    this.light = new LightEngine(this);
    this.dirtySections = new Set(); // section keys needing a mesh rebuild
    this.blockData = new Map(); // posKey -> container/furnace state
    this.unloadedModified = new Map(); // chunkKey -> {cx, cz, blocks, meta} awaiting save
    this.fluidQueue = new Map(); // posKey -> due time
    this.time = 0; // simulation clock in seconds (for fluid scheduling)
    this.listeners = { blockBroken: [], blockChanged: [] };
    this.randomTickRate = 3;
    this.tickAccum = 0;
  }

  on(evt, fn) {
    this.listeners[evt].push(fn);
  }

  emit(evt, ...args) {
    for (const fn of this.listeners[evt]) fn(...args);
  }

  getChunk(cx, cz) {
    return this.chunks.get(chunkKey(cx, cz));
  }

  chunkAtBlock(x, z) {
    return this.chunks.get(chunkKey(toChunk(x), toChunk(z)));
  }

  isLoaded(x, z) {
    const c = this.chunkAtBlock(Math.floor(x), Math.floor(z));
    return !!(c && c.lit);
  }

  addChunk(chunk) {
    this.chunks.set(chunkKey(chunk.cx, chunk.cz), chunk);
    this.unloadedModified.delete(chunkKey(chunk.cx, chunk.cz));
    this.light.invalidateCache();
    this.light.initChunk(chunk);
    for (let s = 0; s < SECTIONS_PER_CHUNK; s++) this.markSection(chunk.cx, s, chunk.cz);
    // Neighbors' border faces depend on this chunk.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const n = this.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (n) for (let s = 0; s < SECTIONS_PER_CHUNK; s++) this.markSection(n.cx, s, n.cz);
    }
  }

  removeChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const c = this.chunks.get(key);
    if (!c) return null;
    if (c.modified && c.dirtySave) this.unloadedModified.set(key, { cx, cz, blocks: c.blocks, meta: c.meta });
    this.chunks.delete(key);
    this.light.invalidateCache();
    return c;
  }

  /** True when the chunk and all 8 neighbors are lit, so its mesh will be seamless. */
  neighborsReady(cx, cz) {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        const c = this.getChunk(cx + dx, cz + dz);
        if (!c || !c.lit) return false;
      }
    }
    return true;
  }

  markSection(cx, sy, cz) {
    if (sy < 0 || sy >= SECTIONS_PER_CHUNK) return;
    this.dirtySections.add(((cx + 32768) * 65536 + (cz + 32768)) * 16 + sy);
  }

  /** Mark the section containing a block plus any section whose mesh samples it. */
  markBlockDirty(x, y, z) {
    const cx = toChunk(x), cz = toChunk(z), sy = Math.floor(y / SECTION_SIZE);
    const lx = x - cx * CHUNK_SIZE, lz = z - cz * CHUNK_SIZE, ly = y - sy * SECTION_SIZE;
    const xs = lx === 0 ? [0, -1] : lx === CHUNK_SIZE - 1 ? [0, 1] : [0];
    const zs = lz === 0 ? [0, -1] : lz === CHUNK_SIZE - 1 ? [0, 1] : [0];
    const ys = ly === 0 ? [0, -1] : ly === SECTION_SIZE - 1 ? [0, 1] : [0];
    for (const dx of xs) for (const dz of zs) for (const dy of ys) this.markSection(cx + dx, sy + dy, cz + dz);
  }

  markLightDirty(chunk, lx, y, lz) {
    this.markBlockDirty(chunk.cx * CHUNK_SIZE + lx, y, chunk.cz * CHUNK_SIZE + lz);
  }

  takeDirtySections() {
    const s = this.dirtySections;
    this.dirtySections = new Set();
    return s;
  }

  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const c = this.chunkAtBlock(x, z);
    if (!c) return 0;
    return c.blocks[(y * CHUNK_SIZE + (z - c.cz * CHUNK_SIZE)) * CHUNK_SIZE + (x - c.cx * CHUNK_SIZE)];
  }

  getMeta(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const c = this.chunkAtBlock(x, z);
    if (!c) return 0;
    return c.meta[(y * CHUNK_SIZE + (z - c.cz * CHUNK_SIZE)) * CHUNK_SIZE + (x - c.cx * CHUNK_SIZE)];
  }

  /** Returns [sky, block] light levels at a block (sky above the world is 15). */
  getLight(x, y, z) {
    if (y >= WORLD_HEIGHT) return [15, 0];
    if (y < 0) return [0, 0];
    const c = this.chunkAtBlock(x, z);
    if (!c) return [15, 0];
    const l = c.light[(y * CHUNK_SIZE + (z - c.cz * CHUNK_SIZE)) * CHUNK_SIZE + (x - c.cx * CHUNK_SIZE)];
    return [l >> 4, l & 15];
  }

  /** True if the block can be modified (loaded, inside world bounds, not bedrock-protected). */
  canModify(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    if (Math.abs(x) > WORLD_BORDER || Math.abs(z) > WORLD_BORDER) return false;
    return !!this.chunkAtBlock(x, z);
  }

  /**
   * Change a block. Updates light, meshes, save state and neighbor rules.
   * Returns false if the position is not modifiable.
   */
  setBlock(x, y, z, id, meta = 0, { silent = false } = {}) {
    if (!this.canModify(x, y, z)) return false;
    const c = this.chunkAtBlock(x, z);
    const i = (y * CHUNK_SIZE + (z - c.cz * CHUNK_SIZE)) * CHUNK_SIZE + (x - c.cx * CHUNK_SIZE);
    const oldId = c.blocks[i];
    const oldMeta = c.meta[i];
    if (oldId === id && oldMeta === meta) return true;
    c.blocks[i] = id;
    c.meta[i] = meta;
    c.modified = true;
    c.dirtySave = true;
    this.markBlockDirty(x, y, z);
    if (OPACITY[oldId] !== OPACITY[id] || EMIT[oldId] !== EMIT[id]) this.light.update(x, y, z);
    if (oldId !== id && BLOCKS[oldId].interact && !BLOCKS[id].interact) this.blockData.delete(posKey(x, y, z));
    if (!silent) this.emit('blockChanged', x, y, z, oldId, id);
    this.scheduleFluid(x, y, z);
    for (const [dx, dy, dz] of NEIGHBORS6) this.neighborChanged(x + dx, y + dy, z + dz, x, y, z);
    return true;
  }

  /** Break a block as if mined: emits drops through the blockBroken listeners. */
  breakBlock(x, y, z, cause = 'player') {
    const id = this.getBlock(x, y, z);
    if (!id) return false;
    const meta = this.getMeta(x, y, z);
    const data = this.blockData.get(posKey(x, y, z));
    // Two-block structures break together.
    if (BLOCKS[id].shape === 'door') {
      const oy = meta & 8 ? y - 1 : y + 1;
      if (this.getBlock(x, oy, z) === id) this.setBlock(x, oy, z, B.air, 0, { silent: true });
    } else if (id === B.bed) {
      const [fx, fz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][meta & 3];
      const s = meta & 4 ? -1 : 1;
      if (this.getBlock(x + fx * s, y, z + fz * s) === B.bed) this.setBlock(x + fx * s, y, z + fz * s, B.air, 0, { silent: true });
    }
    this.setBlock(x, y, z, B.air, 0);
    this.emit('blockBroken', x, y, z, id, meta, cause, data);
    return true;
  }

  neighborChanged(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return;
    const id = this.getBlock(x, y, z);
    if (!id) return;
    const d = BLOCKS[id];
    if (d.fluid) {
      this.scheduleFluid(x, y, z);
      return;
    }
    if (d.needsSupport && !this.isSupported(x, y, z, id)) this.breakBlock(x, y, z, 'support');
    else if (id === B.farmland && SOLID[this.getBlock(x, y + 1, z)] && OPAQUE[this.getBlock(x, y + 1, z)]) this.setBlock(x, y, z, B.dirt);
  }

  isSupported(x, y, z, id) {
    const below = this.getBlock(x, y - 1, z);
    const d = BLOCKS[id];
    if (d.shape === 'torch') {
      const w = this.getMeta(x, y, z) & 7;
      if (w === 0) return SOLID[below] && BLOCKS[below].shape !== 'torch' && BLOCKS[below].shape !== 'cross';
      const [dx, dz] = [[0, -1], [1, 0], [0, 1], [-1, 0]][w - 1];
      return !!OPAQUE[this.getBlock(x + dx, y, z + dz)];
    }
    if (id === B.cactus) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (SOLID[this.getBlock(x + dx, y, z + dz)]) return false;
      return below === B.sand || below === B.cactus;
    }
    if (d.shape === 'crop') return below === B.farmland;
    if (id === B.glowcap) return SOLID[below] && below !== B.glowcap;
    if (id === B.dead_bush) return below === B.sand || below === B.coarse_dirt || below === B.dirt || below === B.grass;
    return below === B.grass || below === B.dirt || below === B.snow_grass || below === B.farmland || below === B.coarse_dirt;
  }

  // ---- Fluids -------------------------------------------------------------------------------
  // Simplified voxel fluid: meta bits 0-2 = level (0 = source, 1..7 flowing), bit 3 = falling.
  // Updates are scheduled only around changes, so untouched oceans cost nothing.

  scheduleFluid(x, y, z) {
    for (const [dx, dy, dz] of [[0, 0, 0], ...NEIGHBORS6]) {
      const id = this.getBlock(x + dx, y + dy, z + dz);
      if (BLOCKS[id].fluid) {
        const key = posKey(x + dx, y + dy, z + dz);
        if (!this.fluidQueue.has(key)) this.fluidQueue.set(key, this.time + (id === B.lava ? 1.2 : 0.3));
      }
    }
  }

  canFluidEnter(id) {
    return id === B.air || (BLOCKS[id].replaceable && !BLOCKS[id].fluid) || (BLOCKS[id].shape === 'cross' && !BLOCKS[id].sapling);
  }

  tickFluids(budget = 128) {
    if (!this.fluidQueue.size) return;
    const due = [];
    for (const [key, t] of this.fluidQueue) {
      if (t <= this.time) due.push(key);
      if (due.length >= budget) break;
    }
    for (const key of due) {
      this.fluidQueue.delete(key);
      const [x, y, z] = key.split(',').map(Number);
      this.updateFluid(x, y, z);
    }
  }

  updateFluid(x, y, z) {
    const id = this.getBlock(x, y, z);
    const d = BLOCKS[id];
    if (!d.fluid || !this.isLoaded(x, z)) return;
    const meta = this.getMeta(x, y, z);
    const level = meta & 7;
    const isLava = id === B.lava;
    const step = isLava ? 2 : 1;
    const other = isLava ? B.water : B.lava;
    // Lava meeting water hardens.
    for (const [dx, dy, dz] of NEIGHBORS6) {
      if (this.getBlock(x + dx, y + dy, z + dz) === other) {
        if (isLava) this.setBlock(x, y, z, level === 0 ? B.stone : B.cobblestone);
        else if (dy !== -1 || true) this.setBlock(x + dx, y + dy, z + dz, (this.getMeta(x + dx, y + dy, z + dz) & 7) === 0 ? B.stone : B.cobblestone);
        return;
      }
    }
    if (level !== 0) {
      // Flowing fluid survives only while fed by a stronger neighbor or from above.
      const above = this.getBlock(x, y + 1, z) === id;
      let best = 8;
      let sources = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        if (this.getBlock(x + dx, y, z + dz) !== id) continue;
        const nm = this.getMeta(x + dx, y, z + dz);
        if ((nm & 7) === 0) sources++;
        best = Math.min(best, nm & 8 ? 0 : nm & 7);
      }
      let want = above ? 1 | 8 : best + step < 8 ? best + step : -1;
      if (!isLava && sources >= 2 && SOLID[this.getBlock(x, y - 1, z)]) want = 0;
      if (want === -1) {
        this.setBlock(x, y, z, B.air);
        return;
      }
      if (want !== meta) this.setBlock(x, y, z, id, want);
    }
    const cur = this.getMeta(x, y, z) & 7;
    const below = this.getBlock(x, y - 1, z);
    if (y > 0 && this.canFluidEnter(below)) {
      this.flowInto(x, y - 1, z, id, 1 | 8);
      return;
    }
    if (y > 0 && below === id) return;
    const next = (meta & 8 ? 0 : cur) + step;
    if (next >= 8) return;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nid = this.getBlock(x + dx, y, z + dz);
      if (this.canFluidEnter(nid)) this.flowInto(x + dx, y, z + dz, id, next);
      else if (nid === id) {
        const nm = this.getMeta(x + dx, y, z + dz);
        if ((nm & 7) > next && !(nm & 8)) this.setBlock(x + dx, y, z + dz, id, next);
      }
    }
  }

  flowInto(x, y, z, id, meta) {
    const prev = this.getBlock(x, y, z);
    if (prev !== B.air) this.breakBlock(x, y, z, 'fluid');
    this.setBlock(x, y, z, id, meta);
  }

  // ---- Random ticks: crops, saplings, grass, farmland ----------------------------------------

  randomTick(centerX, centerZ, radiusChunks, rng = Math.random) {
    const pcx = toChunk(Math.floor(centerX)), pcz = toChunk(Math.floor(centerZ));
    for (let dx = -radiusChunks; dx <= radiusChunks; dx++) {
      for (let dz = -radiusChunks; dz <= radiusChunks; dz++) {
        const c = this.getChunk(pcx + dx, pcz + dz);
        if (!c || !c.lit) continue;
        for (let s = 0; s < SECTIONS_PER_CHUNK; s++) {
          for (let k = 0; k < this.randomTickRate; k++) {
            const r = Math.floor(rng() * 4096);
            const lx = r & 15, lz = (r >> 4) & 15, ly = r >> 8;
            const y = s * SECTION_SIZE + ly;
            const id = c.blocks[(y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx];
            if (id === B.air || id === B.stone) continue;
            this.randomTickBlock(c.cx * CHUNK_SIZE + lx, y, c.cz * CHUNK_SIZE + lz, id, rng);
          }
        }
      }
    }
  }

  randomTickBlock(x, y, z, id, rng) {
    const d = BLOCKS[id];
    const [sky, blk] = this.getLight(x, y + 1, z);
    const light = Math.max(sky, blk);
    if (d.crop) {
      const meta = this.getMeta(x, y, z);
      const stage = meta & 7;
      const wet = this.getMeta(x, y - 1, z) & 1;
      if (stage < 7 && light >= 9 && rng() < (wet ? 0.35 : 0.15)) this.setBlock(x, y, z, id, stage + 1);
    } else if (d.sapling) {
      if (light >= 9 && rng() < 0.12) this.growSapling(x, y, z, d.sapling);
    } else if (id === B.dirt) {
      if (light >= 9 && !OPAQUE[this.getBlock(x, y + 1, z)] && !BLOCKS[this.getBlock(x, y + 1, z)].fluid) {
        for (let k = 0; k < 4; k++) {
          const nx = x + Math.floor(rng() * 3) - 1, ny = y + Math.floor(rng() * 3) - 1, nz = z + Math.floor(rng() * 3) - 1;
          if (this.getBlock(nx, ny, nz) === B.grass) {
            this.setBlock(x, y, z, B.grass);
            break;
          }
        }
      }
    } else if (id === B.grass || id === B.snow_grass) {
      const above = this.getBlock(x, y + 1, z);
      if (OPAQUE[above] || BLOCKS[above].fluid) this.setBlock(x, y, z, B.dirt);
    } else if (id === B.farmland) {
      const wet = this.hasWaterNear(x, y, z, 4);
      const meta = this.getMeta(x, y, z);
      if (wet && !(meta & 1)) this.setBlock(x, y, z, B.farmland, 1);
      else if (!wet && meta & 1) this.setBlock(x, y, z, B.farmland, 0);
      else if (!wet && !BLOCKS[this.getBlock(x, y + 1, z)].crop && rng() < 0.2) this.setBlock(x, y, z, B.dirt);
    }
  }

  hasWaterNear(x, y, z, r) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = 0; dy <= 1; dy++) if (this.getBlock(x + dx, y + dy, z + dz) === B.water) return true;
      }
    }
    return false;
  }

  growSapling(x, y, z, type) {
    // Needs headroom: the trunk column must be clear.
    for (let dy = 1; dy <= 6; dy++) if (this.getBlock(x, y + dy, z) !== B.air) return false;
    const writes = [];
    const ctx = {
      set: (wx, wy, wz, id, m = 0) => writes.push([wx, wy, wz, id, m, false]),
      soft: (wx, wy, wz, id, m = 0) => writes.push([wx, wy, wz, id, m, true]),
    };
    growTree(ctx, { x, y, z, type, hash: hash4(x, y, z, 77) });
    for (const [wx, wy, wz, id, m, soft] of writes) {
      if (!this.canModify(wx, wy, wz)) continue;
      const cur = this.getBlock(wx, wy, wz);
      if (soft && cur !== B.air && !BLOCKS[cur].replaceable) continue;
      if (!soft && id !== B.dirt && cur !== B.air && cur !== B[`${type}_sapling`] && !BLOCKS[cur].replaceable && !BLOCKS[cur].leaves) continue;
      this.setBlock(wx, wy, wz, id, m);
    }
    return true;
  }

  /** Copy a section plus a 1-block border into the mesher's padded arrays. */
  fillPad(cx, sy, cz, pad) {
    const { blocks, meta, light } = pad;
    const y0 = sy * SECTION_SIZE;
    for (let pz = -1; pz <= 16; pz++) {
      for (let px = -1; px <= 16; px++) {
        const wx = cx * CHUNK_SIZE + px, wz = cz * CHUNK_SIZE + pz;
        const c = this.chunkAtBlock(wx, wz);
        const ci = c ? (wz - c.cz * CHUNK_SIZE) * CHUNK_SIZE + (wx - c.cx * CHUNK_SIZE) : 0;
        for (let py = -1; py <= 16; py++) {
          const pi = ((py + 1) * 18 + (pz + 1)) * 18 + (px + 1);
          const y = y0 + py;
          if (!c || y < 0) {
            blocks[pi] = B.bedrock;
            meta[pi] = 0;
            light[pi] = 0;
          } else if (y >= WORLD_HEIGHT) {
            blocks[pi] = 0;
            meta[pi] = 0;
            light[pi] = 0xf0;
          } else {
            const i = y * CHUNK_SIZE * CHUNK_SIZE + ci;
            blocks[pi] = c.blocks[i];
            meta[pi] = c.meta[i];
            light[pi] = c.light[i];
          }
        }
      }
    }
  }

  /** Collision boxes in world space for blocks overlapping an AABB. */
  collisionBoxes(minX, minY, minZ, maxX, maxY, maxZ, out = []) {
    out.length = 0;
    const x0 = Math.floor(minX), x1 = Math.floor(maxX);
    const y0 = Math.max(0, Math.floor(minY) - 1), y1 = Math.min(WORLD_HEIGHT - 1, Math.floor(maxY));
    const z0 = Math.floor(minZ), z1 = Math.floor(maxZ);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const c = this.chunkAtBlock(x, z);
        if (!c) {
          // Unloaded terrain is treated as solid so nothing falls into the void.
          for (let y = y0; y <= y1; y++) out.push([x, y, z, x + 1, y + 1, z + 1]);
          continue;
        }
        for (let y = y0; y <= y1; y++) {
          const id = c.blocks[(y * CHUNK_SIZE + (z - c.cz * CHUNK_SIZE)) * CHUNK_SIZE + (x - c.cx * CHUNK_SIZE)];
          if (!SOLID[id]) continue;
          const meta = c.meta[(y * CHUNK_SIZE + (z - c.cz * CHUNK_SIZE)) * CHUNK_SIZE + (x - c.cx * CHUNK_SIZE)];
          for (const b of getBoxes(id, meta, (dx, dy, dz) => this.getBlock(x + dx, y + dy, z + dz), 'collision')) {
            out.push([x + b[0], y + b[1], z + b[2], x + b[3], y + b[4], z + b[5]]);
          }
        }
      }
    }
    return out;
  }
}
