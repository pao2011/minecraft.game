// A 16 x WORLD_HEIGHT x 16 column of blocks. Compact typed arrays only: no per-block objects.
import { CHUNK_SIZE, CHUNK_VOLUME, SECTIONS_PER_CHUNK, SECTION_SIZE } from '../config/constants.js';
import { localIndex } from './coords.js';

export class Chunk {
  constructor(cx, cz, blocks, meta) {
    this.cx = cx;
    this.cz = cz;
    this.blocks = blocks || new Uint8Array(CHUNK_VOLUME);
    this.meta = meta || new Uint8Array(CHUNK_VOLUME);
    this.light = new Uint8Array(CHUNK_VOLUME); // high nibble: sky, low nibble: block
    // Per-column climate (temperature, humidity) for biome tinting; filled by the generator.
    this.climate = new Uint8Array(CHUNK_SIZE * CHUNK_SIZE * 2);
    this.lit = false; // initial light pass done
    this.modified = false; // differs from generated terrain -> must be persisted
    this.dirtySave = false; // has unsaved changes
    this.sectionDirty = new Uint8Array(SECTIONS_PER_CHUNK).fill(1);
    this.meshed = false;
  }

  get(lx, y, lz) {
    return this.blocks[localIndex(lx, y, lz)];
  }

  getMeta(lx, y, lz) {
    return this.meta[localIndex(lx, y, lz)];
  }

  set(lx, y, lz, id, meta = 0) {
    const i = localIndex(lx, y, lz);
    this.blocks[i] = id;
    this.meta[i] = meta;
  }

  markSectionDirty(y) {
    const s = Math.floor(y / SECTION_SIZE);
    if (s >= 0 && s < SECTIONS_PER_CHUNK) this.sectionDirty[s] = 1;
  }

  /** Highest non-air y in the column, or -1. */
  topY(lx, lz) {
    for (let y = this.blocks.length / (CHUNK_SIZE * CHUNK_SIZE) - 1; y >= 0; y--) {
      if (this.blocks[localIndex(lx, y, lz)] !== 0) return y;
    }
    return -1;
  }
}
