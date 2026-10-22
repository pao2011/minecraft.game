// Loads and unloads chunk columns around the player. Saved chunks come from storage, others
// from a pool of generation workers (or synchronously when workers are unavailable).
import { CHUNK_SIZE } from '../config/constants.js';
import { chunkKey } from './coords.js';
import { Chunk } from './chunk.js';
import { log } from '../util/log.js';

export class ChunkStreamer {
  /**
   * opts.loadSaved(cx, cz): Promise<{blocks, meta}> | null  (null = not saved, generate instead)
   * opts.onUnload(chunk): called before a chunk is dropped (save hook)
   * opts.useWorkers: false forces synchronous generation (tests)
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.opts = opts;
    this.pending = new Set();
    this.ready = [];
    this.wanted = [];
    this.center = null;
    this.radius = 0;
    this.workers = [];
    this.nextWorker = 0;
    this.inFlight = 0;
    this.failed = 0;
    if (opts.useWorkers !== false && typeof Worker !== 'undefined') {
      const n = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
      try {
        for (let i = 0; i < n; i++) {
          const w = new Worker(new URL('./genWorker.js', import.meta.url), { type: 'module' });
          w.onmessage = (e) => this.onWorkerMessage(e.data);
          w.onerror = (e) => {
            log.warn('Generation worker failed; falling back to main thread', e.message);
            this.disableWorkers();
          };
          w.postMessage({ type: 'init', seed: world.seed });
          this.workers.push(w);
        }
      } catch (err) {
        log.warn('Workers unavailable, generating on main thread', err);
        this.disableWorkers();
      }
    }
  }

  disableWorkers() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    // Anything that was in flight gets requested again synchronously.
    this.pending.clear();
    this.inFlight = 0;
  }

  onWorkerMessage(m) {
    this.inFlight = Math.max(0, this.inFlight - 1);
    if (m.type === 'error') {
      log.error(`Chunk generation failed at ${m.cx},${m.cz}`, m.message);
      this.pending.delete(chunkKey(m.cx, m.cz));
      this.failed++;
      return;
    }
    this.ready.push(m);
  }

  /** Request a single chunk generation (worker or synchronous). */
  request(cx, cz) {
    const key = chunkKey(cx, cz);
    this.pending.add(key);
    const saved = this.opts.loadSaved ? this.opts.loadSaved(cx, cz) : null;
    if (saved) {
      this.inFlight++;
      saved
        .then((data) => {
          this.inFlight--;
          if (data) this.ready.push({ cx, cz, blocks: data.blocks, meta: data.meta, saved: true });
          else this.generate(cx, cz, true);
        })
        .catch((err) => {
          this.inFlight--;
          log.error(`Saved chunk ${cx},${cz} could not be read; regenerating terrain for it`, err);
          this.generate(cx, cz, true);
        });
      return;
    }
    this.generate(cx, cz, false);
  }

  generate(cx, cz) {
    if (this.workers.length) {
      this.inFlight++;
      this.workers[this.nextWorker++ % this.workers.length].postMessage({ type: 'gen', cx, cz });
    } else {
      const r = this.world.generator.generateChunk(cx, cz);
      this.ready.push({ cx, cz, ...r });
    }
  }

  /** Chunk coordinates wanted for a center, sorted nearest first (circular radius). */
  computeWanted(pcx, pcz, radius) {
    const out = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const d = dx * dx + dz * dz;
        if (d <= (radius + 0.5) * (radius + 0.5)) out.push([pcx + dx, pcz + dz, d]);
      }
    }
    out.sort((a, b) => a[2] - b[2]);
    return out;
  }

  /**
   * Per-frame update. radius = render distance in chunks. budgetMs bounds main-thread work
   * spent integrating chunks (lighting).
   */
  update(px, pz, radius, budgetMs = 4) {
    const pcx = Math.floor(px / CHUNK_SIZE), pcz = Math.floor(pz / CHUNK_SIZE);
    const loadRadius = radius + 1; // one extra ring so edge chunks can mesh seamlessly
    if (!this.center || this.center[0] !== pcx || this.center[1] !== pcz || this.radius !== loadRadius) {
      this.center = [pcx, pcz];
      this.radius = loadRadius;
      this.wanted = this.computeWanted(pcx, pcz, loadRadius);
      this.unloadFar(pcx, pcz, loadRadius + 2);
    }
    const maxInFlight = this.workers.length ? this.workers.length * 3 : 1;
    for (const [cx, cz] of this.wanted) {
      if (this.inFlight >= maxInFlight && this.workers.length) break;
      const key = chunkKey(cx, cz);
      if (this.pending.has(key) || this.world.chunks.has(key)) continue;
      this.request(cx, cz);
      if (!this.workers.length) break; // synchronous: one per frame, integrated below
    }
    const t0 = performance.now();
    // Integrate nearest-first so the area around the player fills in before the horizon.
    if (this.ready.length > 1) this.ready.sort((a, b) => Math.hypot(a.cx - pcx, a.cz - pcz) - Math.hypot(b.cx - pcx, b.cz - pcz));
    while (this.ready.length && (performance.now() - t0 < budgetMs)) {
      const m = this.ready.shift();
      const key = chunkKey(m.cx, m.cz);
      this.pending.delete(key);
      if (this.world.chunks.has(key)) continue;
      if (Math.max(Math.abs(m.cx - pcx), Math.abs(m.cz - pcz)) > loadRadius + 2) continue;
      const chunk = new Chunk(m.cx, m.cz, m.blocks, m.meta);
      if (m.climate) chunk.climate = m.climate;
      else this.fillClimate(chunk);
      if (m.saved) chunk.modified = true;
      this.world.addChunk(chunk);
    }
  }

  fillClimate(chunk) {
    const g = this.world.generator;
    for (let lz = 0; lz < CHUNK_SIZE; lz++) {
      for (let lx = 0; lx < CHUNK_SIZE; lx++) {
        const [t, h] = g.climate(chunk.cx * CHUNK_SIZE + lx, chunk.cz * CHUNK_SIZE + lz);
        chunk.climate[(lz * CHUNK_SIZE + lx) * 2] = Math.round((t + 1) * 127.5);
        chunk.climate[(lz * CHUNK_SIZE + lx) * 2 + 1] = Math.round((h + 1) * 127.5);
      }
    }
  }

  unloadFar(pcx, pcz, maxDist) {
    for (const c of [...this.world.chunks.values()]) {
      if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) <= maxDist) continue;
      this.opts.onUnload?.(c);
      this.world.removeChunk(c.cx, c.cz);
    }
  }

  /** Fraction of wanted chunks that are loaded within `radius` (loading screen progress). */
  progress(radius) {
    if (!this.center) return 0;
    const [pcx, pcz] = this.center;
    let have = 0, total = 0;
    for (const [cx, cz] of this.wanted) {
      if (Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz)) > radius) continue;
      total++;
      if (this.world.chunks.has(chunkKey(cx, cz))) have++;
    }
    return total ? have / total : 0;
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}
