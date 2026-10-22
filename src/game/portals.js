// Portal frames: detection, lighting, building, destination search, and the End gate sanctum.
import { B, SOLID } from '../world/blocks.js';

const AXES = [[1, 0], [0, 1]];
const isFrame = (id) => id === B.obsidian;
const isOpen = (id) => id === B.air || id === B.nether_portal;

/** Interior of a rectangular obsidian frame (2..21 wide, 3..21 tall) containing (x, y, z), or null. */
export function findFrame(world, x, y, z) {
  for (let axis = 0; axis < 2; axis++) {
    const [dx, dz] = AXES[axis];
    if (!isOpen(world.getBlock(x, y, z))) continue;
    let by = y;
    while (isOpen(world.getBlock(x, by - 1, z)) && y - by < 21) by--;
    if (!isFrame(world.getBlock(x, by - 1, z))) continue;
    let l = 0;
    while (isOpen(world.getBlock(x - dx * (l + 1), by, z - dz * (l + 1))) && l < 21) l++;
    if (!isFrame(world.getBlock(x - dx * (l + 1), by, z - dz * (l + 1)))) continue;
    let r = 0;
    while (isOpen(world.getBlock(x + dx * (r + 1), by, z + dz * (r + 1))) && r < 21) r++;
    if (!isFrame(world.getBlock(x + dx * (r + 1), by, z + dz * (r + 1)))) continue;
    const w = l + r + 1;
    const ox = x - dx * l, oz = z - dz * l;
    let h = 0;
    while (isOpen(world.getBlock(ox, by + h, oz)) && h < 21) h++;
    if (w < 2 || w > 21 || h < 3) continue;
    let ok = true;
    const cells = [];
    for (let i = 0; i < w && ok; i++) {
      if (!isFrame(world.getBlock(ox + dx * i, by - 1, oz + dz * i)) || !isFrame(world.getBlock(ox + dx * i, by + h, oz + dz * i))) ok = false;
      for (let j = 0; j < h && ok; j++) {
        if (!isOpen(world.getBlock(ox + dx * i, by + j, oz + dz * i))) ok = false;
        cells.push([ox + dx * i, by + j, oz + dz * i]);
      }
    }
    for (let j = 0; j < h && ok; j++) {
      if (!isFrame(world.getBlock(ox - dx, by + j, oz - dz)) || !isFrame(world.getBlock(ox + dx * w, by + j, oz + dz * w))) ok = false;
    }
    if (ok) return { axis, cells };
  }
  return null;
}

function withoutChecks(world, fn) {
  world.portalCheck = false;
  try {
    fn();
  } finally {
    world.portalCheck = true;
  }
}

/** Fill a valid frame with portal blocks. Returns true if a frame was found. */
export function lightPortal(world, x, y, z) {
  const f = findFrame(world, x, y, z);
  if (!f) return false;
  withoutChecks(world, () => {
    for (const [cx, cy, cz] of f.cells) world.setBlock(cx, cy, cz, B.nether_portal, f.axis);
  });
  return true;
}

/** Build a 4x5 obsidian frame (2x3 interior) with a platform and cleared space; (x,y,z) = bottom-left interior cell. */
export function buildPortal(world, x, y, z, axis) {
  const [dx, dz] = AXES[axis];
  const [px, pz] = [dz, dx]; // perpendicular (depth) direction
  withoutChecks(world, () => {
    for (let k = -2; k <= 2; k++) {
      for (let i = -2; i <= 3; i++) {
        for (let j = 0; j <= 4; j++) world.setBlock(x + dx * i + px * k, y + j, z + dz * i + pz * k, B.air);
      }
    }
    for (let k = -1; k <= 1; k++) for (let i = -1; i <= 2; i++) world.setBlock(x + dx * i + px * k, y - 1, z + dz * i + pz * k, B.obsidian);
    for (let i = -1; i <= 2; i++) {
      for (let j = -1; j <= 3; j++) {
        const edge = i === -1 || i === 2 || j === -1 || j === 3;
        if (edge) world.setBlock(x + dx * i, y + j, z + dz * i, B.obsidian);
        else world.setBlock(x + dx * i, y + j, z + dz * i, B.nether_portal, axis);
      }
    }
  });
}

/** Nearest portal block within `radius` of (x, z) at any height, or null. */
export function findPortalNear(world, x, z, radius) {
  let best = null, bestD = Infinity;
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (!world.isLoaded(x + dx, z + dz)) continue;
      for (let y = 1; y < 127; y++) {
        if (world.getBlock(x + dx, y, z + dz) !== B.nether_portal) continue;
        const d = dx * dx + dz * dz + y * 0.01;
        if (d < bestD) {
          bestD = d;
          best = { x: x + dx, y, z: z + dz, axis: world.getMeta(x + dx, y, z + dz) & 1 };
        }
        break;
      }
    }
  }
  if (!best) return null;
  // Drop to the lowest portal cell of this pane so the player stands at its base.
  while (world.getBlock(best.x, best.y - 1, best.z) === B.nether_portal) best.y--;
  return best;
}

/** A free 3-high standing cell with solid ground near (x, z), searching outward; null if none. */
export function findSite(world, x, z, minY, maxY, maxR = 12) {
  for (let r = 0; r <= maxR; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        const cx = x + dx, cz = z + dz;
        if (!world.isLoaded(cx, cz)) continue;
        for (let y = maxY; y >= minY; y--) {
          if (world.getBlock(cx, y, cz) === B.air && world.getBlock(cx, y + 1, cz) === B.air && world.getBlock(cx, y + 2, cz) === B.air && SOLID[world.getBlock(cx, y - 1, cz)]) return { x: cx, y, z: cz };
        }
      }
    }
  }
  return null;
}

/** Void Gate sanctum: center of the 3x3 well if (x, y, z) belongs to a ring of 12 frames, else null. */
export function findGateCenter(world, x, y, z) {
  for (let cx = x - 2; cx <= x + 2; cx++) {
    for (let cz = z - 2; cz <= z + 2; cz++) {
      let ok = true;
      for (let i = -1; i <= 1 && ok; i++) {
        for (const [fx, fz] of [[cx + i, cz - 2], [cx + i, cz + 2], [cx - 2, cz + i], [cx + 2, cz + i]]) {
          if (world.getBlock(fx, y, fz) !== B.end_frame) ok = false;
        }
      }
      if (ok && [x, z].every((v, k) => Math.abs(v - (k ? cz : cx)) <= 2)) return { x: cx, z: cz };
    }
  }
  return null;
}

/** If every frame of the ring holds an eye, open the gate. Returns true when activated. */
export function tryOpenGate(world, x, y, z) {
  const c = findGateCenter(world, x, y, z);
  if (!c) return false;
  for (let i = -1; i <= 1; i++) {
    for (const [fx, fz] of [[c.x + i, c.z - 2], [c.x + i, c.z + 2], [c.x - 2, c.z + i], [c.x + 2, c.z + i]]) {
      if (!(world.getMeta(fx, y, fz) & 4)) return false;
    }
  }
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) world.setBlock(c.x + dx, y, c.z + dz, B.end_portal, 2);
  return true;
}

/** Nearest Void Gate sanctum to (x, z) within `rr` regions (64 blocks each), or null. */
export function nearestSanctum(gen, x, z, rr = 40) {
  const fn = gen.structureFns[1][1];
  const rx0 = Math.floor(x / 64), rz0 = Math.floor(z / 64);
  let best = null;
  for (let rx = rx0 - rr; rx <= rx0 + rr; rx++) {
    for (let rz = rz0 - rr; rz <= rz0 + rr; rz++) {
      const st = gen.cachedStructure(fn, rx, rz);
      if (st?.type !== 'sanctum') continue;
      const d = Math.hypot(st.x + 5 - x, st.z + 5 - z);
      if (!best || d < best.dist) best = { x: st.x + 5, y: st.y, z: st.z + 5, dist: d };
    }
  }
  return best;
}
