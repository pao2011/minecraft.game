// Voxel ray traversal (Amanatides & Woo) with exact hits against block selection boxes.
import { BLOCKS } from './blocks.js';
import { getBoxes } from './shapes.js';

/** Slab ray/AABB test. Returns {t, normal} of the entry point or null. */
export function rayBox(ox, oy, oz, dx, dy, dz, b) {
  let tmin = -Infinity, tmax = Infinity, nAxis = -1, nSign = 0;
  const o = [ox, oy, oz], d = [dx, dy, dz];
  for (let a = 0; a < 3; a++) {
    if (Math.abs(d[a]) < 1e-12) {
      if (o[a] < b[a] || o[a] > b[a + 3]) return null;
      continue;
    }
    let t1 = (b[a] - o[a]) / d[a], t2 = (b[a + 3] - o[a]) / d[a];
    let sign = -1;
    if (t1 > t2) {
      [t1, t2] = [t2, t1];
      sign = 1;
    }
    if (t1 > tmin) {
      tmin = t1;
      nAxis = a;
      nSign = sign;
    }
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return null;
  }
  if (tmax < 0) return null;
  const normal = [0, 0, 0];
  if (nAxis >= 0) normal[nAxis] = nSign;
  return { t: Math.max(0, tmin), normal };
}

/**
 * Cast a ray through the world. `accept(id)` decides which blocks can be hit
 * (default: anything with a selection box, fluids excluded).
 */
export function raycast(world, origin, dir, maxDist, accept) {
  const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
  const dx = dir.x / len, dy = dir.y / len, dz = dir.z / len;
  let x = Math.floor(origin.x), y = Math.floor(origin.y), z = Math.floor(origin.z);
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const tDeltaX = Math.abs(1 / dx), tDeltaY = Math.abs(1 / dy), tDeltaZ = Math.abs(1 / dz);
  let tMaxX = dx > 0 ? (x + 1 - origin.x) * tDeltaX : (origin.x - x) * tDeltaX;
  let tMaxY = dy > 0 ? (y + 1 - origin.y) * tDeltaY : (origin.y - y) * tDeltaY;
  let tMaxZ = dz > 0 ? (z + 1 - origin.z) * tDeltaZ : (origin.z - z) * tDeltaZ;
  if (!isFinite(tMaxX)) tMaxX = Infinity;
  if (!isFinite(tMaxY)) tMaxY = Infinity;
  if (!isFinite(tMaxZ)) tMaxZ = Infinity;
  let t = 0;
  while (t <= maxDist) {
    const id = world.getBlock(x, y, z);
    if (id) {
      const d = BLOCKS[id];
      const ok = accept ? accept(id, d) : !d.fluid && d.shape !== 'portal';
      if (ok) {
        const meta = world.getMeta(x, y, z);
        const nb = (ax, ay, az) => world.getBlock(x + ax, y + ay, z + az);
        const boxes = d.fluid ? [[0, 0, 0, 1, 0.875, 1]] : getBoxes(id, meta, nb, 'select');
        let best = null;
        for (const b of boxes) {
          const hit = rayBox(origin.x - x, origin.y - y, origin.z - z, dx, dy, dz, b);
          if (hit && hit.t <= maxDist && (!best || hit.t < best.t)) best = { ...hit, box: b };
        }
        if (best) {
          return {
            x, y, z, id, meta,
            normal: best.normal,
            dist: best.t,
            box: best.box,
            point: { x: origin.x + dx * best.t, y: origin.y + dy * best.t, z: origin.z + dz * best.t },
            place: { x: x + best.normal[0], y: y + best.normal[1], z: z + best.normal[2] },
          };
        }
      }
    }
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
    }
  }
  return null;
}
