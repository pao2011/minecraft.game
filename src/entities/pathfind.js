// Bounded A* over walkable voxel cells for creatures. A cell (x, y, z) is walkable when the
// block below supports the creature and `height` blocks of headroom are passable.
import { SOLID, BLOCKS, B } from '../world/blocks.js';

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

function passable(world, x, y, z) {
  const id = world.getBlock(x, y, z);
  if (id === B.lava || id === B.cactus) return false;
  return !SOLID[id] || (BLOCKS[id].shape === 'door' && (world.getMeta(x, y, z) & 4) !== 0);
}

export function walkable(world, x, y, z, height = 2) {
  const below = world.getBlock(x, y - 1, z);
  if (!SOLID[below] && below !== B.water) return false;
  if (below === B.lava || below === B.cactus || BLOCKS[below].shape === 'fence') return false;
  for (let h = 0; h < height; h++) if (!passable(world, x, y + h, z)) return false;
  return true;
}

const key = (x, y, z) => `${x},${y},${z}`;

/**
 * Find a path from start to goal (integer block coords of the feet). Returns waypoints
 * (excluding the start) or the best partial path toward the goal, or null if boxed in.
 */
export function findPath(world, start, goal, { maxNodes = 320, maxDrop = 3, height = 2 } = {}) {
  const h = (x, y, z) => {
    const dx = Math.abs(x - goal.x), dz = Math.abs(z - goal.z);
    return Math.max(dx, dz) + 0.41 * Math.min(dx, dz) + Math.abs(y - goal.y) * 0.5;
  };
  const open = [{ x: start.x, y: start.y, z: start.z, g: 0, f: h(start.x, start.y, start.z), parent: null }];
  const seen = new Map([[key(start.x, start.y, start.z), 0]]);
  let best = open[0];
  let expanded = 0;
  while (open.length && expanded < maxNodes) {
    // Small open sets: a linear min-scan beats a heap here.
    let bi = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bi].f) bi = i;
    const cur = open.splice(bi, 1)[0];
    expanded++;
    if (cur.x === goal.x && cur.z === goal.z && Math.abs(cur.y - goal.y) <= 1) {
      best = cur;
      break;
    }
    if (cur.f - cur.g < best.f - best.g) best = cur;
    for (const [dx, dz] of DIRS) {
      const nx = cur.x + dx, nz = cur.z + dz;
      if (dx && dz && (!passable(world, cur.x + dx, cur.y, cur.z) || !passable(world, cur.x, cur.y, cur.z + dz))) continue;
      let ny = null;
      if (walkable(world, nx, cur.y, nz, height)) ny = cur.y;
      else if (walkable(world, nx, cur.y + 1, nz, height) && passable(world, cur.x, cur.y + height, cur.z)) ny = cur.y + 1;
      else {
        for (let d = 1; d <= maxDrop; d++) {
          if (!passable(world, nx, cur.y - d + height - 1, nz)) break;
          if (walkable(world, nx, cur.y - d, nz, height)) {
            ny = cur.y - d;
            break;
          }
        }
      }
      if (ny === null) continue;
      const g = cur.g + (dx && dz ? 1.41 : 1) + (ny !== cur.y ? 0.6 : 0);
      const k = key(nx, ny, nz);
      if (seen.has(k) && seen.get(k) <= g) continue;
      seen.set(k, g);
      open.push({ x: nx, y: ny, z: nz, g, f: g + h(nx, ny, nz), parent: cur });
    }
  }
  if (!best.parent) return null;
  const path = [];
  for (let n = best; n && n.parent; n = n.parent) path.push({ x: n.x, y: n.y, z: n.z });
  path.reverse();
  return path;
}
