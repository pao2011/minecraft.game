// Pure save-format logic: chunk compression, world record validation and version migration.
// Kept free of browser APIs so it is fully unit-tested in Node.
import { CHUNK_VOLUME, SAVE_VERSION, GEN_VERSION, PLAYER, WORLD_HEIGHT, WORLD_BORDER } from '../config/constants.js';
import { BLOCKS } from '../world/blocks.js';
import { isValidItem, maxStack } from '../items/items.js';

/** Run-length encode bytes as (runLength 1..255, value) pairs. */
export function rleEncode(src) {
  const out = new Uint8Array(src.length * 2);
  let o = 0;
  for (let i = 0; i < src.length;) {
    const v = src[i];
    let n = 1;
    while (n < 255 && i + n < src.length && src[i + n] === v) n++;
    out[o++] = n;
    out[o++] = v;
    i += n;
  }
  return out.slice(0, o);
}

export function rleDecode(src, expectedLength) {
  const out = new Uint8Array(expectedLength);
  let o = 0;
  for (let i = 0; i + 1 < src.length; i += 2) {
    const n = src[i], v = src[i + 1];
    if (n === 0 || o + n > expectedLength) throw new Error('Corrupt run-length data');
    out.fill(v, o, o + n);
    o += n;
  }
  if (o !== expectedLength) throw new Error(`Chunk data has ${o} cells, expected ${expectedLength}`);
  return out;
}

export const currentPalette = () => BLOCKS.map((d) => (d ? d.key : null));

export function encodeChunk(blocks, meta) {
  return { v: 1, blocks: rleEncode(blocks), meta: rleEncode(meta) };
}

/**
 * Decode a stored chunk. `palette` is the block key list saved with the world; ids are
 * remapped to the current registry and unknown blocks become air.
 */
export function decodeChunk(rec, palette) {
  if (!rec || rec.v !== 1) throw new Error('Unsupported chunk record');
  const blocks = rleDecode(toBytes(rec.blocks), CHUNK_VOLUME);
  const meta = rleDecode(toBytes(rec.meta), CHUNK_VOLUME);
  const remap = buildRemap(palette);
  if (remap) for (let i = 0; i < blocks.length; i++) blocks[i] = remap[blocks[i]];
  else for (let i = 0; i < blocks.length; i++) if (!BLOCKS[blocks[i]]) blocks[i] = 0;
  return { blocks, meta };
}

function toBytes(x) {
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (Array.isArray(x)) return Uint8Array.from(x);
  throw new Error('Chunk bytes missing');
}

function buildRemap(palette) {
  if (!Array.isArray(palette)) return null;
  const cur = currentPalette();
  if (palette.length === cur.length && palette.every((k, i) => k === cur[i])) return null;
  const byKey = new Map(cur.map((k, i) => [k, i]));
  const remap = new Uint8Array(256);
  for (let i = 0; i < 256; i++) remap[i] = byKey.get(palette[i]) ?? 0;
  return remap;
}

// ---- World records ------------------------------------------------------------------------

const finite = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clampNum = (v, lo, hi, d) => Math.min(hi, Math.max(lo, finite(v, d)));

function cleanSlots(arr, size) {
  const out = new Array(size).fill(null);
  if (!Array.isArray(arr)) return out;
  for (let i = 0; i < Math.min(size, arr.length); i++) {
    const s = arr[i];
    if (!s || !isValidItem(s.id)) continue;
    const count = Math.floor(finite(s.count, 0));
    if (count <= 0) continue;
    out[i] = { id: s.id, count: Math.min(count, maxStack(s.id)) };
    const dmg = Math.floor(finite(s.damage, 0));
    if (dmg > 0) out[i].damage = dmg;
  }
  return out;
}

function cleanPos(p, fallback) {
  if (!p || typeof p !== 'object') return fallback;
  const x = finite(p.x, NaN), y = finite(p.y, NaN), z = finite(p.z, NaN);
  if (![x, y, z].every(Number.isFinite)) return fallback;
  return { x: clampNum(x, -WORLD_BORDER, WORLD_BORDER, 0), y: clampNum(y, 1, WORLD_HEIGHT + 64, 80), z: clampNum(z, -WORLD_BORDER, WORLD_BORDER, 0) };
}

/** Upgrade older records in place, one version step at a time. */
export function migrate(rec) {
  const r = { ...rec };
  let v = Number(r.saveVersion) || 1;
  if (v < 2) {
    // v1 -> v2: weather + game rules were added; inventory moved under player.
    r.weather = r.weather || { state: 'clear', timer: 600 };
    r.rules = { keepInventory: false, daylightCycle: true, mobSpawning: true, dayLength: 'normal', ...(r.rules || {}) };
    if (r.inventory && r.player && !r.player.inventory) r.player = { ...r.player, inventory: r.inventory };
    delete r.inventory;
    v = 2;
  }
  r.saveVersion = v;
  return r;
}

/**
 * Validate and normalize a world record. Throws only when the record is unusable
 * (no id/seed); recoverable problems are repaired and listed in `warnings`.
 */
export function normalizeWorld(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('World record is missing');
  if (Number(raw.saveVersion) > SAVE_VERSION) throw new Error(`World was saved by a newer version (save v${raw.saveVersion})`);
  const r = migrate(raw);
  const warnings = [];
  if (typeof r.id !== 'string' || !r.id) throw new Error('World has no id');
  if (r.seed === undefined || r.seed === null || String(r.seed) === '') throw new Error('World has no seed');
  const p = r.player && typeof r.player === 'object' ? r.player : {};
  if (!r.player) warnings.push('Player data missing; starting at spawn');
  const spawn = cleanPos(r.worldSpawn, null);
  const world = {
    id: r.id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.slice(0, 40) : 'Unnamed World',
    seed: String(r.seed),
    genVersion: finite(r.genVersion, GEN_VERSION),
    saveVersion: SAVE_VERSION,
    mode: r.mode === 'creative' ? 'creative' : 'survival',
    difficulty: ['peaceful', 'easy', 'normal', 'hard'].includes(r.difficulty) ? r.difficulty : 'normal',
    created: finite(r.created, Date.now()),
    lastPlayed: finite(r.lastPlayed, Date.now()),
    playtime: Math.max(0, finite(r.playtime, 0)),
    time: { tod: ((finite(r.time?.tod, 0.05) % 1) + 1) % 1, day: Math.max(0, Math.floor(finite(r.time?.day, 0))) },
    weather: { state: ['clear', 'rain'].includes(r.weather?.state) ? r.weather.state : 'clear', timer: clampNum(r.weather?.timer, 0, 100000, 600) },
    rules: {
      keepInventory: !!r.rules?.keepInventory,
      daylightCycle: r.rules?.daylightCycle !== false,
      mobSpawning: r.rules?.mobSpawning !== false,
      dayLength: ['short', 'normal', 'long'].includes(r.rules?.dayLength) ? r.rules.dayLength : 'normal',
    },
    worldSpawn: spawn,
    starterBonus: !!r.starterBonus,
    palette: Array.isArray(r.palette) ? r.palette.map((k) => (typeof k === 'string' ? k : null)) : currentPalette(),
    thumbnail: typeof r.thumbnail === 'string' && r.thumbnail.startsWith('data:image/') ? r.thumbnail : null,
    containers: {},
    entities: [],
    player: {
      pos: cleanPos(p.pos, null),
      yaw: finite(p.yaw, 0),
      pitch: clampNum(p.pitch, -1.57, 1.57, 0),
      health: clampNum(p.health, 0, PLAYER.maxHealth, PLAYER.maxHealth),
      hunger: clampNum(p.hunger, 0, PLAYER.maxHunger, PLAYER.maxHunger),
      saturation: clampNum(p.saturation, 0, 20, 5),
      exhaustion: clampNum(p.exhaustion, 0, 4, 0),
      air: clampNum(p.air, 0, 10, 10),
      inventory: cleanSlots(p.inventory, 36),
      armor: cleanSlots(p.armor, 4),
      selected: Math.floor(clampNum(p.selected, 0, 8, 0)),
      spawn: cleanPos(p.spawn, null),
      flying: !!p.flying,
      dead: !!p.dead,
    },
    warnings,
  };
  if (p.pos && !world.player.pos) warnings.push('Player position was invalid; moved to spawn');
  if (r.containers && typeof r.containers === 'object') {
    for (const [key, c] of Object.entries(r.containers)) {
      if (!/^-?\d+,-?\d+,-?\d+$/.test(key) || !c || typeof c !== 'object') continue;
      if (c.type === 'chest') world.containers[key] = { type: 'chest', slots: cleanSlots(c.slots, 27) };
      else if (c.type === 'furnace') {
        world.containers[key] = {
          type: 'furnace', slots: cleanSlots(c.slots, 3), burn: clampNum(c.burn, 0, 1000, 0), burnMax: clampNum(c.burnMax, 0, 1000, 0), progress: clampNum(c.progress, 0, 100, 0),
        };
      }
    }
  }
  if (Array.isArray(r.entities)) {
    for (const e of r.entities.slice(0, 64)) {
      const pos = cleanPos(e?.pos, null);
      if (pos && typeof e.type === 'string') world.entities.push({ type: e.type, pos, health: clampNum(e.health, 1, 100, 10), baby: !!e.baby });
    }
  }
  return world;
}

export function newWorldRecord({ id, name, seed, mode, difficulty, starterBonus = false, rules = {} }) {
  return normalizeWorld({
    id, name, seed, mode, difficulty, starterBonus,
    genVersion: GEN_VERSION,
    saveVersion: SAVE_VERSION,
    created: Date.now(),
    lastPlayed: Date.now(),
    rules,
    player: {},
  });
}
