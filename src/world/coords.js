// Single source of truth for world <-> chunk <-> local coordinate conversions.
// Every conversion uses floor division so negative coordinates map consistently.
import { CHUNK_SIZE, WORLD_HEIGHT, SECTION_SIZE } from '../config/constants.js';

export const floorDiv = (a, b) => Math.floor(a / b);
export const mod = (a, b) => ((a % b) + b) % b;

/** Block coordinate containing a world-space position component. */
export const toBlock = (v) => Math.floor(v);
export const toChunk = (blockCoord) => floorDiv(blockCoord, CHUNK_SIZE);
export const toLocal = (blockCoord) => mod(blockCoord, CHUNK_SIZE);

/** Index into a chunk column array; layout is y-major so a horizontal slice is contiguous. */
export const localIndex = (lx, y, lz) => (y * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;

export const inWorldY = (y) => y >= 0 && y < WORLD_HEIGHT;

// Numeric keys avoid string allocation in hot paths. Valid for |cx|,|cz| < 32768.
export const chunkKey = (cx, cz) => (cx + 32768) * 65536 + (cz + 32768);
export const chunkKeyX = (key) => Math.floor(key / 65536) - 32768;
export const chunkKeyZ = (key) => (key % 65536) - 32768;

export const sectionKey = (cx, sy, cz) => chunkKey(cx, cz) * 16 + sy;
export const toSection = (y) => Math.floor(y / SECTION_SIZE);

/** Stable string key for a block position, used for containers and other per-block state. */
export const posKey = (x, y, z) => `${x},${y},${z}`;
export const parsePosKey = (key) => key.split(',').map(Number);
