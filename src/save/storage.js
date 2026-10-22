// IndexedDB persistence. A save writes the world record and every dirty chunk in a single
// readwrite transaction, so a crash mid-save leaves the previous save intact (atomic).
// Falls back to an in-memory store when IndexedDB is unavailable and reports that.
import { chunkKey } from '../world/coords.js';
import { log } from '../util/log.js';

const DB_NAME = 'blockwild';
const DB_VERSION = 1;

const req = (r) => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error || new Error('Transaction failed'));
  tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
});

const ckey = (worldId, cx, cz) => `${worldId}/${cx},${cz}`;

export class Storage {
  constructor() {
    this.db = null;
    this.memory = null;
    this.persistent = false;
  }

  async open() {
    try {
      if (!globalThis.indexedDB) throw new Error('IndexedDB not available');
      const open = indexedDB.open(DB_NAME, DB_VERSION);
      open.onupgradeneeded = () => {
        const db = open.result;
        if (!db.objectStoreNames.contains('worlds')) db.createObjectStore('worlds', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks');
      };
      this.db = await req(open);
      this.persistent = true;
      // Ask the browser not to evict our data under storage pressure (best effort).
      navigator.storage?.persist?.().catch(() => {});
    } catch (err) {
      log.warn('Persistent storage unavailable; worlds will only last for this session', err);
      this.memory = { worlds: new Map(), chunks: new Map() };
    }
    return this;
  }

  async listWorlds() {
    if (this.memory) return [...this.memory.worlds.values()].map((w) => structuredClone(w));
    const tx = this.db.transaction('worlds', 'readonly');
    return req(tx.objectStore('worlds').getAll());
  }

  async getWorld(id) {
    if (this.memory) return structuredClone(this.memory.worlds.get(id) ?? null);
    const tx = this.db.transaction('worlds', 'readonly');
    return (await req(tx.objectStore('worlds').get(id))) ?? null;
  }

  /** Atomically save a world record plus a list of {cx, cz, data} chunk records. */
  async saveWorld(record, chunks = []) {
    if (this.memory) {
      this.memory.worlds.set(record.id, structuredClone(record));
      for (const c of chunks) this.memory.chunks.set(ckey(record.id, c.cx, c.cz), structuredClone(c.data));
      return;
    }
    const tx = this.db.transaction(['worlds', 'chunks'], 'readwrite');
    tx.objectStore('worlds').put(record);
    const cs = tx.objectStore('chunks');
    for (const c of chunks) cs.put(c.data, ckey(record.id, c.cx, c.cz));
    await done(tx);
  }

  async loadChunk(worldId, cx, cz) {
    if (this.memory) return structuredClone(this.memory.chunks.get(ckey(worldId, cx, cz)) ?? null);
    const tx = this.db.transaction('chunks', 'readonly');
    return (await req(tx.objectStore('chunks').get(ckey(worldId, cx, cz)))) ?? null;
  }

  /** Numeric chunk keys of every saved chunk in a world. */
  async savedChunkKeys(worldId) {
    const keys = this.memory
      ? [...this.memory.chunks.keys()].filter((k) => k.startsWith(`${worldId}/`))
      : await req(this.db.transaction('chunks', 'readonly').objectStore('chunks').getAllKeys(IDBKeyRange.bound(`${worldId}/`, `${worldId}/￿`)));
    const out = new Set();
    for (const k of keys) {
      const [cx, cz] = k.slice(worldId.length + 1).split(',').map(Number);
      if (Number.isInteger(cx) && Number.isInteger(cz)) out.add(chunkKey(cx, cz));
    }
    return out;
  }

  async deleteWorld(id) {
    if (this.memory) {
      this.memory.worlds.delete(id);
      for (const k of [...this.memory.chunks.keys()]) if (k.startsWith(`${id}/`)) this.memory.chunks.delete(k);
      return;
    }
    const tx = this.db.transaction(['worlds', 'chunks'], 'readwrite');
    tx.objectStore('worlds').delete(id);
    tx.objectStore('chunks').delete(IDBKeyRange.bound(`${id}/`, `${id}/￿`));
    await done(tx);
  }

  /** Copy a world and all its chunks under a new id in one transaction. */
  async duplicateWorld(id, newId, newName) {
    const rec = await this.getWorld(id);
    if (!rec) throw new Error('World not found');
    const copy = { ...rec, id: newId, name: newName, created: Date.now() };
    if (this.memory) {
      this.memory.worlds.set(newId, structuredClone(copy));
      for (const [k, v] of [...this.memory.chunks]) if (k.startsWith(`${id}/`)) this.memory.chunks.set(`${newId}/${k.slice(id.length + 1)}`, structuredClone(v));
      return copy;
    }
    const readTx = this.db.transaction('chunks', 'readonly');
    const range = IDBKeyRange.bound(`${id}/`, `${id}/￿`);
    const store = readTx.objectStore('chunks');
    const [keys, values] = await Promise.all([req(store.getAllKeys(range)), req(store.getAll(range))]);
    const tx = this.db.transaction(['worlds', 'chunks'], 'readwrite');
    tx.objectStore('worlds').put(copy);
    const cs = tx.objectStore('chunks');
    keys.forEach((k, i) => cs.put(values[i], `${newId}/${k.slice(id.length + 1)}`));
    await done(tx);
    return copy;
  }

  async renameWorld(id, name) {
    const rec = await this.getWorld(id);
    if (!rec) throw new Error('World not found');
    rec.name = name;
    await this.saveWorld(rec);
  }
}
