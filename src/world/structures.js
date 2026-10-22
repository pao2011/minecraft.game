// Deterministic points of interest. Each region of the world holds at most one structure,
// positioned so footprints never cross region borders, which rules out overlaps.
// A chunk builds every structure whose bounds intersect it, clipped to its own blocks.
import { SEA_LEVEL } from '../config/constants.js';
import { hash4, hashFloat } from '../util/noise.js';
import { B } from './blocks.js';
import { BIOME } from './biomes.js';

const SURFACE_REGION = 80;
const UNDER_REGION = 64;
const MINE_REGION = 128;
const NETHER_REGION = 96;

export const LOOT = { shelter: 1, tower: 2, camp: 3, shrine: 4, dungeon: 5, mineshaft: 6, keep: 7 };

/** Surface structure planned for a region, or null. Pure function of the seed. */
export function surfaceStructure(gen, rx, rz) {
  const s = gen.seed;
  if (hashFloat(s, rx, rz, 501) > 0.6) return null;
  const h = hash4(s, rx, rz, 502);
  const ox = rx * SURFACE_REGION + 8 + (h % 60);
  const oz = rz * SURFACE_REGION + 8 + ((h >>> 8) % 60);
  const center = gen.column(ox + 3, oz + 3);
  const biome = center.biome;
  if (biome === BIOME.beach || biome === BIOME.lake || center.h < SEA_LEVEL + 1) return null;
  const roll = hashFloat(s, rx, rz, 503);
  let type;
  if (biome === BIOME.desert) type = roll < 0.7 ? 'shrine' : 'tower';
  else if (biome === BIOME.rocky || biome === BIOME.mountains) type = roll < 0.7 ? 'tower' : 'camp';
  else type = roll < 0.45 ? 'shelter' : roll < 0.75 ? 'camp' : 'tower';
  const size = type === 'tower' ? 5 : 7;
  // Reject steep sites so buildings do not float or bury themselves.
  let lo = center.h, hi = center.h;
  for (const [dx, dz] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
    const ch = gen.column(ox + dx, oz + dz).h;
    lo = Math.min(lo, ch);
    hi = Math.max(hi, ch);
  }
  if (hi - lo > 5) return null;
  const height = type === 'tower' ? 14 : type === 'shrine' ? 6 : 5;
  return { type, x: ox, y: center.h, z: oz, sx: size, sz: size, height, hash: h, under: false };
}

export function undergroundStructure(gen, rx, rz) {
  const s = gen.seed;
  if (hashFloat(s, rx, rz, 601) > 0.5) return null;
  const h = hash4(s, rx, rz, 602);
  const x = rx * UNDER_REGION + 8 + (h % 44);
  const z = rz * UNDER_REGION + 8 + ((h >>> 8) % 44);
  const y = 14 + ((h >>> 16) % 24);
  const roll = hashFloat(s, rx, rz, 603);
  if (roll < 0.52) return { type: 'dungeon', x, y, z, sx: 9, sz: 9, height: 6, hash: h, under: true };
  if (roll < 0.965) return { type: 'geode', x, y, z, sx: 13, sz: 13, height: 13, hash: h, under: true };
  // Rare: a Void Gate sanctum deep underground (see portals.js for activating it).
  return { type: 'sanctum', x, y: 8 + ((h >>> 16) % 10), z, sx: 11, sz: 11, height: 8, hash: h, under: true };
}

/** Abandoned mine: a main shaft with side tunnels. 48x48 footprint inside a 128-block region. */
export function mineshaftStructure(gen, rx, rz) {
  const s = gen.seed;
  if (hashFloat(s, rx, rz, 701) > 0.5) return null;
  const h = hash4(s, rx, rz, 702);
  return { type: 'mineshaft', x: rx * MINE_REGION + 8 + (h % 70), y: 16 + ((h >>> 16) % 24), z: rz * MINE_REGION + 8 + ((h >>> 8) % 70), sx: 48, sz: 48, height: 5, hash: h, under: true };
}

/** Ruined cinder keep in the Nether. */
export function netherStructure(gen, rx, rz) {
  const s = gen.seed;
  if (hashFloat(s, rx, rz, 801) > 0.55) return null;
  const h = hash4(s, rx, rz, 802);
  return { type: 'keep', x: rx * NETHER_REGION + 8 + (h % 60), y: 36 + ((h >>> 16) % 10), z: rz * NETHER_REGION + 8 + ((h >>> 8) % 60), sx: 17, sz: 17, height: 9, hash: h, under: true };
}

export const OVERWORLD_STRUCTURES = [[SURFACE_REGION, surfaceStructure], [UNDER_REGION, undergroundStructure], [MINE_REGION, mineshaftStructure]];
export const NETHER_STRUCTURES = [[NETHER_REGION, netherStructure]];

/** All structures whose footprint overlaps the box [x0, x1) x [z0, z1). */
export function structuresIn(gen, x0, z0, x1, z1) {
  const out = [];
  for (const [size, fn] of gen.structureFns) {
    const rx0 = Math.floor((x0 - 16) / size), rx1 = Math.floor(x1 / size);
    const rz0 = Math.floor((z0 - 16) / size), rz1 = Math.floor(z1 / size);
    for (let rx = rx0; rx <= rx1; rx++) {
      for (let rz = rz0; rz <= rz1; rz++) {
        const st = gen.cachedStructure(fn, rx, rz);
        if (st && st.x < x1 && st.x + st.sx > x0 && st.z < z1 && st.z + st.sz > z0) out.push(st);
      }
    }
  }
  return out;
}

/** True if a surface structure occupies column (x, z) with a 1-block margin; trees avoid these. */
export function surfaceStructureAt(gen, x, z) {
  return structuresIn(gen, x - 1, z - 1, x + 2, z + 2).some((s) => !s.under);
}

const pick = (st, x, y, z, salt) => hashFloat(st.hash, x, y, z + salt * 1000);

export function buildStructure(ctx, gen, st) {
  ({ shelter: buildShelter, tower: buildTower, camp: buildCamp, shrine: buildShrine, dungeon: buildDungeon, geode: buildGeode, mineshaft: buildMineshaft, sanctum: buildSanctum, keep: buildKeep })[st.type](ctx, gen, st);
}

/** Level the footprint: solid foundation down to terrain, air above the floor. */
function levelSite(ctx, gen, st, floorBlock, foundation) {
  const fy = st.y;
  for (let dx = 0; dx < st.sx; dx++) {
    for (let dz = 0; dz < st.sz; dz++) {
      const x = st.x + dx, z = st.z + dz;
      const th = gen.column(x, z).h;
      for (let y = Math.min(th, fy - 1); y < fy; y++) ctx.set(x, y, z, foundation);
      ctx.set(x, fy, z, floorBlock);
      for (let y = fy + 1; y <= fy + st.height + 2; y++) ctx.set(x, y, z, B.air);
    }
  }
}

function buildShelter(ctx, gen, st) {
  levelSite(ctx, gen, st, B.oak_planks, B.cobblestone);
  const { x, y, z } = st;
  const wallH = 3;
  for (let dx = 0; dx < 7; dx++) {
    for (let dz = 0; dz < 7; dz++) {
      const edge = dx === 0 || dz === 0 || dx === 6 || dz === 6;
      const corner = (dx === 0 || dx === 6) && (dz === 0 || dz === 6);
      for (let h = 1; h <= wallH; h++) {
        if (corner) ctx.set(x + dx, y + h, z + dz, B.oak_log);
        else if (edge) {
          const door = dz === 6 && dx === 3 && h <= 2;
          const window = h === 2 && (dx === 3 || dz === 3) && !(dz === 6);
          // Abandoned: a few planks have rotted away.
          const decayed = pick(st, dx, h, dz, 1) < 0.08;
          if (door) continue;
          ctx.set(x + dx, y + h, z + dz, window ? B.glass_pane : decayed ? B.air : B.oak_planks);
        }
      }
      ctx.set(x + dx, y + wallH + 1, z + dz, edge ? B.oak_planks : B.plank_slab, edge ? 0 : 1);
    }
  }
  ctx.set(x + 1, y + 1, z + 1, B.chest, 2 | (LOOT.shelter << 2));
  ctx.set(x + 5, y + 1, z + 1, B.workbench, 2);
  ctx.set(x + 1, y + 1, z + 4, B.bed, 0);
  ctx.set(x + 1, y + 1, z + 3, B.bed, 0 | 4);
  ctx.set(x + 5, y + 2, z + 5, B.torch, 2);
}

function buildTower(ctx, gen, st) {
  levelSite(ctx, gen, st, B.cobblestone, B.cobblestone);
  const { x, y, z } = st;
  for (let dx = 0; dx < 5; dx++) {
    for (let dz = 0; dz < 5; dz++) {
      const edge = dx === 0 || dz === 0 || dx === 4 || dz === 4;
      if (!edge) continue;
      // Ruined top: each wall column crumbles at its own height.
      const top = st.height - 3 + Math.floor(pick(st, dx, 0, dz, 2) * 4);
      for (let h = 1; h <= top; h++) {
        if (dz === 4 && dx === 2 && h <= 2) continue; // doorway
        const window = h % 5 === 3 && (dx === 2 || dz === 2) && dz !== 4;
        ctx.set(x + dx, y + h, z + dz, window ? B.air : pick(st, dx, h, dz, 3) < 0.35 ? B.mossy_cobblestone : B.cobblestone);
      }
    }
  }
  for (const fh of [5, 10]) {
    for (let dx = 1; dx < 4; dx++) for (let dz = 1; dz < 4; dz++) if (!(dx === 1 && dz === 1)) ctx.set(x + dx, y + fh, z + dz, B.oak_planks);
  }
  for (let h = 1; h <= 10; h++) ctx.set(x + 1, y + h, z + 1, B.ladder, 0);
  ctx.set(x + 3, y + 11, z + 3, B.chest, 3 | (LOOT.tower << 2));
  ctx.set(x + 3, y + 1, z + 1, B.torch, 0);
}

function buildCamp(ctx, gen, st) {
  const { x, y, z } = st;
  // Campsite sits on the existing ground: no levelling, only a cleared clearing.
  for (let dx = 0; dx < 7; dx++) {
    for (let dz = 0; dz < 7; dz++) {
      const th = gen.column(x + dx, z + dz).h;
      for (let yy = th + 1; yy <= th + 6; yy++) ctx.set(x + dx, yy, z + dz, B.air);
    }
  }
  const g = (dx, dz) => gen.column(x + dx, z + dz).h;
  for (const [dx, dz] of [[2, 3], [4, 3], [3, 2], [3, 4]]) ctx.set(x + dx, g(dx, dz) + 1, z + dz, B.cobblestone);
  ctx.set(x + 3, g(3, 3), z + 3, B.cobblestone);
  ctx.set(x + 3, g(3, 3) + 1, z + 3, B.torch, 0);
  ctx.set(x + 1, g(1, 3) + 1, z + 3, B.oak_log, 2);
  ctx.set(x + 5, g(5, 3) + 1, z + 3, B.oak_log, 2);
  ctx.set(x + 3, g(3, 0) + 1, z + 0, B.chest, 2 | (LOOT.camp << 2));
  ctx.set(x + 5, g(5, 5) + 1, z + 5, B.bed, 2);
  ctx.set(x + 5, g(5, 5) + 1, z + 6, B.bed, 2 | 4);
}

function buildShrine(ctx, gen, st) {
  levelSite(ctx, gen, st, B.sandstone, B.sandstone);
  const { x, y, z } = st;
  for (const [dx, dz] of [[0, 0], [6, 0], [0, 6], [6, 6]]) {
    for (let h = 1; h <= 4; h++) ctx.set(x + dx, y + h, z + dz, h === 4 ? B.chiseled_stone : B.sandstone);
  }
  for (let dx = 0; dx < 7; dx++) for (let dz = 0; dz < 7; dz++) ctx.set(x + dx, y + 5, z + dz, dx % 6 === 0 || dz % 6 === 0 ? B.sandstone : B.stone_slab, 0);
  for (let dx = 2; dx <= 4; dx++) for (let dz = 2; dz <= 4; dz++) ctx.set(x + dx, y, z + dz, B.smooth_stone);
  ctx.set(x + 3, y + 1, z + 3, B.chest, 2 | (LOOT.shrine << 2));
  ctx.set(x + 3, y + 3, z + 3, B.lantern);
  ctx.set(x + 3, y + 4, z + 3, B.fence);
}

function buildDungeon(ctx, gen, st) {
  const { x, y, z } = st;
  for (let dx = 0; dx < 9; dx++) {
    for (let dz = 0; dz < 9; dz++) {
      for (let h = 0; h < 6; h++) {
        const shell = dx === 0 || dz === 0 || dx === 8 || dz === 8 || h === 0 || h === 5;
        const doorway = h >= 1 && h <= 2 && ((dx === 4 && (dz === 0 || dz === 8)) || (dz === 4 && dx === 0));
        const id = !shell || doorway ? B.air : pick(st, dx, h, dz, 4) < 0.5 ? B.mossy_cobblestone : B.cobblestone;
        ctx.set(x + dx, y + h, z + dz, id);
      }
    }
  }
  ctx.set(x + 4, y + 1, z + 4, B.totem);
  ctx.set(x + 1, y + 1, z + 4, B.chest, 1 | (LOOT.dungeon << 2));
  if (pick(st, 0, 0, 0, 5) < 0.6) ctx.set(x + 7, y + 1, z + 4, B.chest, 3 | (LOOT.dungeon << 2));
  ctx.set(x + 4, y + 4, z + 1, B.torch, 1);
}

function buildGeode(ctx, gen, st) {
  const cx = st.x + 6, cy = st.y + 6, cz = st.z + 6;
  const R = 5.6;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dz = -6; dz <= 6; dz++) {
        const d = Math.sqrt(dx * dx + dy * dy * 1.1 + dz * dz);
        if (d > R) continue;
        const X = cx + dx, Y = cy + dy, Z = cz + dz;
        if (d <= R - 2.2) ctx.set(X, Y, Z, B.air);
        else if (d <= R - 1.1) ctx.set(X, Y, Z, pick(st, dx, dy, dz, 6) < 0.18 ? B.crystal_ore : B.crystal_block);
        else ctx.set(X, Y, Z, B.smooth_stone);
      }
    }
  }
}

/** Corridors with timber supports, cobwebs, lanterns and loot chests at the ends of side tunnels. */
function buildMineshaft(ctx, gen, st) {
  const alongX = (st.hash & 1) === 0;
  const at = (a, b) => (alongX ? [st.x + a, st.z + b] : [st.x + b, st.z + a]);
  const y = st.y;
  const b0 = 20 + (st.hash % 8);
  const floor = (x, z, a, b) => ctx.set(x, y, z, pick(st, a, b, 0, 11) < 0.12 ? B.gravel : B.cobblestone);
  // One tunnel cell: carve 3 high, lay a floor, sometimes hang a cobweb.
  const carve = (a, b) => {
    const [x, z] = at(a, b);
    floor(x, z, a, b);
    for (let h = 1; h <= 3; h++) ctx.set(x, y + h, z, B.air);
    if (pick(st, a, b, 0, 12) < 0.07) ctx.set(x, y + 3, z, B.cobweb);
  };
  const support = (a, b, edge0, edge1) => {
    // Posts on both edges and a plank beam above, every 4th cell.
    for (const e of [edge0, edge1]) {
      const [x, z] = at(a, e);
      ctx.set(x, y + 1, z, B.fence);
      ctx.set(x, y + 2, z, B.fence);
      ctx.set(x, y + 3, z, B.oak_planks);
    }
    const [mx, mz] = at(a, (edge0 + edge1) >> 1);
    ctx.set(mx, y + 3, mz, B.oak_planks);
  };
  for (let a = 2; a <= 45; a++) {
    for (let b = b0; b < b0 + 3; b++) carve(a, b);
    if (a % 4 === 0) support(a, b0, b0, b0 + 2);
    else if (a % 8 === 2) {
      const [x, z] = at(a, a % 16 === 2 ? b0 : b0 + 2);
      ctx.set(x, y + 1, z, B.torch, 0);
    }
  }
  const starts = [10 + (st.hash >>> 4) % 4, 22 + (st.hash >>> 7) % 4, 34 + (st.hash >>> 10) % 4];
  starts.forEach((a0, i) => {
    const len = 13 + ((st.hash >>> (12 + i * 3)) % 5);
    const dir = i % 2 === 0 ? 1 : -1; // alternate sides
    for (let k = 1; k <= len; k++) {
      const b = dir > 0 ? b0 + 2 + k : b0 - k;
      for (let a = a0; a < a0 + 3; a++) carve(a, b);
      if (k % 4 === 0) {
        for (const e of [a0, a0 + 2]) {
          const [x, z] = at(e, b);
          ctx.set(x, y + 1, z, B.fence);
          ctx.set(x, y + 2, z, B.fence);
          ctx.set(x, y + 3, z, B.oak_planks);
        }
        const [mx, mz] = at(a0 + 1, b);
        ctx.set(mx, y + 3, mz, B.oak_planks);
      }
    }
    if (i !== 1) {
      const [cx, cz] = at(a0 + 1, dir > 0 ? b0 + 2 + len : b0 - len);
      ctx.set(cx, y + 1, cz, B.chest, 2 | (LOOT.mineshaft << 2));
      const [tx, tz] = at(a0, dir > 0 ? b0 + 2 + len : b0 - len);
      ctx.set(tx, y + 1, tz, B.lantern);
    }
  });
}

/** A sealed room holding 12 Void Gate frames around a lava-floored 3x3 well. */
function buildSanctum(ctx, gen, st) {
  const { x, y, z } = st;
  const cx = x + 5, cz = z + 5;
  for (let dx = 0; dx < 11; dx++) {
    for (let dz = 0; dz < 11; dz++) {
      const edge = dx === 0 || dz === 0 || dx === 10 || dz === 10;
      for (let h = 0; h <= 7; h++) {
        const shell = edge || h === 0 || h === 7;
        const mossy = pick(st, dx, h, dz, 21) < 0.3;
        ctx.set(x + dx, y + h, z + dz, shell ? (mossy ? B.mossy_cobblestone : B.stone_bricks) : B.air);
      }
    }
  }
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) ctx.set(cx + dx, y, cz + dz, B.lava);
  for (let i = -1; i <= 1; i++) {
    for (const [fx, fz, f] of [[cx + i, cz - 2, 2], [cx + i, cz + 2, 0], [cx - 2, cz + i, 1], [cx + 2, cz + i, 3]]) ctx.set(fx, y + 1, fz, B.end_frame, f);
  }
  ctx.set(cx, y + 1, cz + 4, B.chest, 0 | (LOOT.dungeon << 2));
  for (const [dx, dz] of [[1, 1], [9, 1], [1, 9], [9, 9]]) ctx.set(x + dx, y + 3, z + dz, B.torch, 0);
  ctx.set(x + 1, y + 1, z + 5, B.totem);
}

function buildKeep(ctx, gen, st) {
  const { x, y, z } = st;
  for (let dx = 0; dx < 17; dx++) {
    for (let dz = 0; dz < 17; dz++) {
      const edge = dx === 0 || dz === 0 || dx === 16 || dz === 16;
      const door = (dx === 8 || dz === 8) && edge;
      for (let h = 0; h <= 8; h++) {
        let id = B.air;
        if (h === 0 || h === 8) id = B.cinder_bricks;
        else if (edge && h <= 5 && !(door && h <= 3)) id = pick(st, dx, h, dz, 31) < 0.12 ? B.air : B.cinder_bricks;
        else if (edge && h <= 5 && door) id = B.air;
        ctx.set(x + dx, y + h, z + dz, id);
      }
    }
  }
  for (const [dx, dz] of [[4, 4], [12, 4], [4, 12], [12, 12]]) {
    for (let h = 1; h <= 7; h++) ctx.set(x + dx, y + h, z + dz, h === 7 ? B.lumen_stone : B.cinder_bricks);
  }
  for (let dx = 7; dx <= 9; dx++) for (let dz = 7; dz <= 9; dz++) ctx.set(x + dx, y + 1, z + dz, B.quartz_block);
  ctx.set(x + 8, y + 2, z + 8, B.chest, 2 | (LOOT.keep << 2));
  if (pick(st, 1, 2, 3, 32) < 0.6) ctx.set(x + 3, y + 1, z + 8, B.chest, 1 | (LOOT.keep << 2));
  ctx.set(x + 8, y + 1, z + 2, B.totem);
  ctx.set(x + 8, y + 1, z + 14, B.totem);
}
