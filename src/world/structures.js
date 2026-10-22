// Deterministic points of interest. Each region of the world holds at most one structure,
// positioned so footprints never cross region borders, which rules out overlaps.
// A chunk builds every structure whose bounds intersect it, clipped to its own blocks.
import { SEA_LEVEL } from '../config/constants.js';
import { hash4, hashFloat } from '../util/noise.js';
import { B } from './blocks.js';
import { BIOME } from './biomes.js';

const SURFACE_REGION = 80;
const UNDER_REGION = 64;

export const LOOT = { shelter: 1, tower: 2, camp: 3, shrine: 4, dungeon: 5 };

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
  if (hashFloat(s, rx, rz, 603) < 0.6) return { type: 'dungeon', x, y, z, sx: 9, sz: 9, height: 6, hash: h, under: true };
  return { type: 'geode', x, y, z, sx: 13, sz: 13, height: 13, hash: h, under: true };
}

/** All structures whose footprint overlaps the box [x0, x1) x [z0, z1). */
export function structuresIn(gen, x0, z0, x1, z1) {
  const out = [];
  for (const [size, fn] of [[SURFACE_REGION, surfaceStructure], [UNDER_REGION, undergroundStructure]]) {
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
  ({ shelter: buildShelter, tower: buildTower, camp: buildCamp, shrine: buildShrine, dungeon: buildDungeon, geode: buildGeode })[st.type](ctx, gen, st);
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
