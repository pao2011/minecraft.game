// Voxel light propagation (sky light + block light, 0..15) using breadth-first flood fill
// across chunk borders. Light is never saved; it is recomputed when chunks load.
import { CHUNK_SIZE, WORLD_HEIGHT } from '../config/constants.js';
import { OPACITY, EMIT } from './blocks.js';
import { chunkKey } from './coords.js';

const SKY = 0;
const BLK = 1;
const DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

class Queue {
  constructor() {
    this.data = new Int32Array(4096 * 4);
    this.head = 0;
    this.tail = 0;
  }
  push(x, y, z, v = 0) {
    if (this.tail + 4 > this.data.length) {
      if (this.head > 0) {
        this.data.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      }
      if (this.tail + 4 > this.data.length) {
        const n = new Int32Array(this.data.length * 2);
        n.set(this.data.subarray(0, this.tail));
        this.data = n;
      }
    }
    const d = this.data;
    d[this.tail++] = x;
    d[this.tail++] = y;
    d[this.tail++] = z;
    d[this.tail++] = v;
  }
  get empty() {
    return this.head >= this.tail;
  }
  reset() {
    this.head = this.tail = 0;
  }
}

export class LightEngine {
  constructor(world) {
    this.world = world;
    this.addQ = [new Queue(), new Queue()];
    this.remQ = [new Queue(), new Queue()];
    this._ck = null;
    this._cKey = -1;
  }

  chunkAt(x, z) {
    const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
    const key = chunkKey(cx, cz);
    if (key !== this._cKey) {
      this._cKey = key;
      this._ck = this.world.getChunk(cx, cz);
    }
    return this._ck;
  }

  invalidateCache() {
    this._cKey = -1;
    this._ck = null;
  }

  /** Light value of a channel; unloaded chunks read as 0 (block) / 15 above ground is not assumed. */
  get(ch, x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return ch === SKY && y >= WORLD_HEIGHT ? 15 : 0;
    const c = this.chunkAt(x, z);
    if (!c || !c.lit) return -1;
    const i = (y * CHUNK_SIZE + (z - c.cz * CHUNK_SIZE)) * CHUNK_SIZE + (x - c.cx * CHUNK_SIZE);
    return ch === SKY ? c.light[i] >> 4 : c.light[i] & 15;
  }

  set(ch, c, i, v, lx, y, lz) {
    c.light[i] = ch === SKY ? (c.light[i] & 15) | (v << 4) : (c.light[i] & 0xf0) | v;
    this.world.markLightDirty(c, lx, y, lz);
  }

  /** Initial light for a freshly generated or loaded chunk, then exchange light with loaded neighbors. */
  initChunk(chunk) {
    const { blocks, light } = chunk;
    light.fill(0);
    const S = CHUNK_SIZE;
    // Sky light straight down each column.
    for (let lz = 0; lz < S; lz++) {
      for (let lx = 0; lx < S; lx++) {
        let level = 15;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const i = (y * S + lz) * S + lx;
          const op = OPACITY[blocks[i]];
          if (level > 0) level = op >= 15 ? 0 : Math.max(0, level - op);
          light[i] = (level << 4) | EMIT[blocks[i]];
        }
      }
    }
    chunk.lit = true;
    this.invalidateCache();
    const x0 = chunk.cx * S, z0 = chunk.cz * S;
    const sq = this.addQ[SKY], bq = this.addQ[BLK];
    // Seed cells that can spread light sideways or into dimmer cells.
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      for (let lz = 0; lz < S; lz++) {
        for (let lx = 0; lx < S; lx++) {
          const i = (y * S + lz) * S + lx;
          const l = light[i];
          const sky = l >> 4, blk = l & 15;
          if (blk > 1) bq.push(x0 + lx, y, z0 + lz);
          if (sky <= 1) continue;
          // Only cells next to a dimmer transparent neighbor need to spread.
          if (
            (lx > 0 && (light[i - 1] >> 4) < sky - 1 && OPACITY[blocks[i - 1]] < 15) ||
            (lx < S - 1 && (light[i + 1] >> 4) < sky - 1 && OPACITY[blocks[i + 1]] < 15) ||
            (lz > 0 && (light[i - S] >> 4) < sky - 1 && OPACITY[blocks[i - S]] < 15) ||
            (lz < S - 1 && (light[i + S] >> 4) < sky - 1 && OPACITY[blocks[i + S]] < 15) ||
            (y > 0 && (light[i - S * S] >> 4) < sky - 1 && OPACITY[blocks[i - S * S]] < 15) ||
            lx === 0 || lx === S - 1 || lz === 0 || lz === S - 1
          ) {
            sq.push(x0 + lx, y, z0 + lz);
          }
        }
      }
    }
    // Pull light from already-lit neighbors across the shared borders.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = this.world.getChunk(chunk.cx + dx, chunk.cz + dz);
      if (!n || !n.lit) continue;
      const bx = dx === 1 ? S : dx === -1 ? -1 : null;
      const bz = dz === 1 ? S : dz === -1 ? -1 : null;
      for (let k = 0; k < S; k++) {
        const wx = x0 + (bx === null ? k : bx), wz = z0 + (bz === null ? k : bz);
        const li = ((wz - n.cz * S) * S) + (wx - n.cx * S);
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          const l = n.light[y * S * S + li];
          if (l >> 4 > 1) sq.push(wx, y, wz);
          if ((l & 15) > 1) bq.push(wx, y, wz);
        }
      }
    }
    this.propagate(SKY);
    this.propagate(BLK);
  }

  propagate(ch) {
    const q = this.addQ[ch];
    const d = q.data;
    while (q.head < q.tail) {
      const x = q.data[q.head], y = q.data[q.head + 1], z = q.data[q.head + 2];
      q.head += 4;
      const level = this.get(ch, x, y, z);
      if (level <= 1) continue;
      for (let k = 0; k < 6; k++) {
        const dir = DIRS[k];
        const nx = x + dir[0], ny = y + dir[1], nz = z + dir[2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const c = this.chunkAt(nx, nz);
        if (!c || !c.lit) continue;
        const lx = nx - c.cx * CHUNK_SIZE, lz = nz - c.cz * CHUNK_SIZE;
        const i = (ny * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
        const op = OPACITY[c.blocks[i]];
        if (op >= 15) continue;
        let nl = level - Math.max(1, op);
        if (ch === SKY && k === 3 && level === 15 && op === 0) nl = 15; // direct sunlight falls without loss
        const cur = ch === SKY ? c.light[i] >> 4 : c.light[i] & 15;
        if (nl > cur) {
          this.set(ch, c, i, nl, lx, ny, lz);
          q.push(nx, ny, nz);
        }
      }
    }
    q.reset();
    void d;
  }

  /** Recompute light around a single changed block (placement, removal, emitter change). */
  update(x, y, z) {
    this.invalidateCache();
    for (const ch of [SKY, BLK]) {
      const c = this.chunkAt(x, z);
      if (!c || !c.lit) return;
      const lx = x - c.cx * CHUNK_SIZE, lz = z - c.cz * CHUNK_SIZE;
      const i = (y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
      const old = ch === SKY ? c.light[i] >> 4 : c.light[i] & 15;
      const rq = this.remQ[ch];
      const aq = this.addQ[ch];
      this.set(ch, c, i, 0, lx, y, lz);
      if (old > 0) rq.push(x, y, z, old);
      this.unpropagate(ch);
      const id = c.blocks[i];
      if (ch === BLK && EMIT[id] > 0) {
        this.set(ch, c, i, EMIT[id], lx, y, lz);
        aq.push(x, y, z);
      }
      for (const [dx, dy, dz] of DIRS) {
        const ny = y + dy;
        if (ny >= 0 && ny < WORLD_HEIGHT && this.get(ch, x + dx, ny, z + dz) > 0) aq.push(x + dx, ny, z + dz);
      }
      if (ch === SKY && y === WORLD_HEIGHT - 1 && OPACITY[id] < 15) {
        this.set(ch, c, i, 15 - OPACITY[id], lx, y, lz);
        aq.push(x, y, z);
      }
      this.propagate(ch);
    }
  }

  unpropagate(ch) {
    const q = this.remQ[ch];
    const aq = this.addQ[ch];
    while (q.head < q.tail) {
      const x = q.data[q.head], y = q.data[q.head + 1], z = q.data[q.head + 2], level = q.data[q.head + 3];
      q.head += 4;
      for (let k = 0; k < 6; k++) {
        const dir = DIRS[k];
        const nx = x + dir[0], ny = y + dir[1], nz = z + dir[2];
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        const c = this.chunkAt(nx, nz);
        if (!c || !c.lit) continue;
        const lx = nx - c.cx * CHUNK_SIZE, lz = nz - c.cz * CHUNK_SIZE;
        const i = (ny * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
        const nl = ch === SKY ? c.light[i] >> 4 : c.light[i] & 15;
        if (nl === 0) continue;
        if (nl < level || (ch === SKY && k === 3 && level === 15 && nl === 15)) {
          this.set(ch, c, i, 0, lx, ny, lz);
          q.push(nx, ny, nz, nl);
          // An emitter inside the removed region relights itself.
          if (ch === BLK && EMIT[c.blocks[i]] > 0) {
            this.set(ch, c, i, EMIT[c.blocks[i]], lx, ny, lz);
            aq.push(nx, ny, nz);
          }
        } else {
          aq.push(nx, ny, nz);
        }
      }
    }
    q.reset();
  }
}
