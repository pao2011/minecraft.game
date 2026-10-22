// Axis-separated AABB collision against voxel boxes, shared by the player and creatures.
// Entities are positioned by the center of their feet: pos = {x, y, z}.
import { BLOCKS } from '../world/blocks.js';

const EPS = 1e-6;
const scratch = [];

export function entityBox(e, pos = e.pos) {
  const hw = e.width / 2;
  return { minX: pos.x - hw, minY: pos.y, minZ: pos.z - hw, maxX: pos.x + hw, maxY: pos.y + e.height, maxZ: pos.z + hw };
}

function clipAxis(boxes, a, axis, d) {
  for (const b of boxes) {
    const [bx0, by0, bz0, bx1, by1, bz1] = b;
    if (axis === 'y') {
      if (a.maxX <= bx0 + EPS || a.minX >= bx1 - EPS || a.maxZ <= bz0 + EPS || a.minZ >= bz1 - EPS) continue;
      if (d > 0 && a.maxY <= by0 + EPS) d = Math.min(d, by0 - a.maxY);
      else if (d < 0 && a.minY >= by1 - EPS) d = Math.max(d, by1 - a.minY);
    } else if (axis === 'x') {
      if (a.maxY <= by0 + EPS || a.minY >= by1 - EPS || a.maxZ <= bz0 + EPS || a.minZ >= bz1 - EPS) continue;
      if (d > 0 && a.maxX <= bx0 + EPS) d = Math.min(d, bx0 - a.maxX);
      else if (d < 0 && a.minX >= bx1 - EPS) d = Math.max(d, bx1 - a.minX);
    } else {
      if (a.maxY <= by0 + EPS || a.minY >= by1 - EPS || a.maxX <= bx0 + EPS || a.minX >= bx1 - EPS) continue;
      if (d > 0 && a.maxZ <= bz0 + EPS) d = Math.min(d, bz0 - a.maxZ);
      else if (d < 0 && a.minZ >= bz1 - EPS) d = Math.max(d, bz1 - a.minZ);
    }
  }
  return d;
}

function shift(a, axis, d) {
  if (axis === 'x') { a.minX += d; a.maxX += d; } else if (axis === 'y') { a.minY += d; a.maxY += d; } else { a.minZ += d; a.maxZ += d; }
}

function sweep(world, e, dx, dy, dz) {
  const a = entityBox(e);
  const boxes = world.collisionBoxes(
    Math.min(a.minX, a.minX + dx) - 0.01, Math.min(a.minY, a.minY + dy) - 0.01, Math.min(a.minZ, a.minZ + dz) - 0.01,
    Math.max(a.maxX, a.maxX + dx) + 0.01, Math.max(a.maxY, a.maxY + dy) + 0.01, Math.max(a.maxZ, a.maxZ + dz) + 0.01, scratch,
  );
  const ry = clipAxis(boxes, a, 'y', dy);
  shift(a, 'y', ry);
  const rx = clipAxis(boxes, a, 'x', dx);
  shift(a, 'x', rx);
  const rz = clipAxis(boxes, a, 'z', dz);
  shift(a, 'z', rz);
  return { rx, ry, rz };
}

/** True if the entity box at pos overlaps any solid collision box. */
export function collidesAt(world, e, pos) {
  const a = entityBox(e, pos);
  const boxes = world.collisionBoxes(a.minX, a.minY, a.minZ, a.maxX - EPS, a.maxY - EPS, a.maxZ - EPS, scratch);
  for (const [x0, y0, z0, x1, y1, z1] of boxes) {
    if (a.maxX > x0 + EPS && a.minX < x1 - EPS && a.maxY > y0 + EPS && a.minY < y1 - EPS && a.maxZ > z0 + EPS && a.minZ < z1 - EPS) return true;
  }
  return false;
}

/**
 * Move an entity by its velocity over dt with collision. Sets onGround and horizontal-collision
 * flags, applies step-up (stairs/slabs) and optional sneak edge-guarding.
 */
export function moveEntity(world, e, dt, { stepHeight = 0.6, sneakGuard = false } = {}) {
  let dx = e.vel.x * dt, dy = e.vel.y * dt, dz = e.vel.z * dt;
  // Sneaking: refuse horizontal moves that would leave the supporting edge.
  if (sneakGuard && e.onGround) {
    const supported = (ox, oz) => {
      const probe = { x: e.pos.x + ox, y: e.pos.y - 0.6, z: e.pos.z + oz };
      return collidesAt(world, { width: e.width, height: 0.59 }, probe);
    };
    const step = 0.05;
    while (dx !== 0 && !supported(dx, 0)) dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
    while (dz !== 0 && !supported(0, dz)) dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
    while (dx !== 0 && dz !== 0 && !supported(dx, dz)) {
      dx = Math.abs(dx) < step ? 0 : dx - Math.sign(dx) * step;
      dz = Math.abs(dz) < step ? 0 : dz - Math.sign(dz) * step;
    }
  }
  const wasGround = e.onGround;
  let r = sweep(world, e, dx, dy, dz);
  // Step up onto low obstacles when walking into them on the ground.
  if (stepHeight > 0 && (wasGround || (dy < 0 && r.ry !== dy)) && (r.rx !== dx || r.rz !== dz)) {
    const save = { ...e.pos };
    const up = sweep(world, e, 0, stepHeight, 0).ry;
    e.pos.y += up;
    const h = sweep(world, e, dx, 0, dz);
    e.pos.x += h.rx;
    e.pos.z += h.rz;
    const down = sweep(world, e, 0, -up - 0.01, 0).ry;
    e.pos.y += down;
    const gained = Math.hypot(h.rx, h.rz) - Math.hypot(r.rx, r.rz);
    if (gained > 1e-4 && down > -up - 0.01 + 1e-6) {
      e.onGround = true;
      e.vel.y = 0;
      e.hitHorizontal = Math.abs(h.rx - dx) > 1e-4 || Math.abs(h.rz - dz) > 1e-4;
      return;
    }
    e.pos.x = save.x;
    e.pos.y = save.y;
    e.pos.z = save.z;
    r = sweep(world, e, dx, dy, dz);
  }
  e.pos.x += r.rx;
  e.pos.y += r.ry;
  e.pos.z += r.rz;
  e.onGround = dy < 0 && r.ry > dy + 1e-7;
  e.hitCeiling = dy > 0 && r.ry < dy - 1e-7;
  if (e.onGround || e.hitCeiling) e.vel.y = 0;
  e.hitHorizontal = Math.abs(r.rx - dx) > 1e-7 || Math.abs(r.rz - dz) > 1e-7;
  if (Math.abs(r.rx - dx) > 1e-7) e.vel.x = 0;
  if (Math.abs(r.rz - dz) > 1e-7) e.vel.z = 0;
}

/** Blocks overlapping the entity box (for water, ladders, cactus contact...). */
export function touchingBlocks(world, e, grow = 0) {
  const a = entityBox(e);
  const out = [];
  for (let x = Math.floor(a.minX - grow); x <= Math.floor(a.maxX + grow); x++) {
    for (let y = Math.floor(a.minY - grow); y <= Math.floor(a.maxY + grow - 1e-6); y++) {
      for (let z = Math.floor(a.minZ - grow); z <= Math.floor(a.maxZ + grow); z++) {
        const id = world.getBlock(x, y, z);
        if (id) out.push({ x, y, z, id, def: BLOCKS[id] });
      }
    }
  }
  return out;
}
