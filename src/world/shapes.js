// Box geometry for every block shape, shared by the mesher (render), physics (collision)
// and raycasting (selection). Boxes are [x0, y0, z0, x1, y1, z1] in block-local units.
import { BLOCKS, SOLID, OPAQUE } from './blocks.js';

const FULL = [[0, 0, 0, 1, 1, 1]];
const P = 3 / 16; // door / hatch thickness

/** Thin panel against side f (0=N 1=E 2=S 3=W), full height. */
export function sidePanel(f, t = P, y0 = 0, y1 = 1) {
  switch (f & 3) {
    case 0: return [0, y0, 0, 1, y1, t];
    case 1: return [1 - t, y0, 0, 1, y1, 1];
    case 2: return [0, y0, 1 - t, 1, y1, 1];
    default: return [0, y0, 0, t, y1, 1];
  }
}

function stairsBoxes(meta) {
  const f = meta & 3;
  const up = meta & 4;
  const base = up ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1];
  const y0 = up ? 0 : 0.5;
  const y1 = up ? 0.5 : 1;
  const back = [[0, y0, 0, 1, y1, 0.5], [0.5, y0, 0, 1, y1, 1], [0, y0, 0.5, 1, y1, 1], [0, y0, 0, 0.5, y1, 1]][f];
  return [base, back];
}

const connectsFence = (id) => id && (BLOCKS[id].shape === 'fence' || OPAQUE[id]);
const connectsPane = (id) => id && (BLOCKS[id].shape === 'pane' || id === 40 || OPAQUE[id]);

function connectorBoxes(nb, connects, post, arm, y0, y1) {
  const [a, b] = arm; // arm half-width bounds across the axis
  const boxes = [[post[0], y0, post[0], post[1], y1, post[1]]];
  if (connects(nb(0, 0, -1))) boxes.push([a, y0, 0, b, y1, post[0]]);
  if (connects(nb(1, 0, 0))) boxes.push([post[1], y0, a, 1, y1, b]);
  if (connects(nb(0, 0, 1))) boxes.push([a, y0, post[1], b, y1, 1]);
  if (connects(nb(-1, 0, 0))) boxes.push([0, y0, a, post[0], y1, b]);
  return boxes;
}

/** Fence render geometry: a post plus two rails per connected side. */
export function fenceRenderBoxes(nb) {
  const boxes = [[0.375, 0, 0.375, 0.625, 1, 0.625]];
  const rails = [[0.75, 0.9375], [0.375, 0.5625]];
  const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  dirs.forEach(([dx, dz], i) => {
    if (!connectsFence(nb(dx, 0, dz))) return;
    for (const [r0, r1] of rails) {
      if (i === 0) boxes.push([0.4375, r0, 0, 0.5625, r1, 0.375]);
      if (i === 1) boxes.push([0.625, r0, 0.4375, 1, r1, 0.5625]);
      if (i === 2) boxes.push([0.4375, r0, 0.625, 0.5625, r1, 1]);
      if (i === 3) boxes.push([0, r0, 0.4375, 0.375, r1, 0.5625]);
    }
  });
  return boxes;
}

/**
 * Boxes for a block. kind: 'render' | 'collision' | 'select'.
 * nb(dx, dy, dz) returns the neighbor block id (needed by fences and panes).
 */
export function getBoxes(id, meta, nb, kind) {
  const d = BLOCKS[id];
  if (!d) return [];
  switch (d.shape) {
    case 'none':
      return [];
    case 'cube':
      return FULL;
    case 'liquid':
      return [];
    case 'cross':
    case 'crop':
      if (kind === 'collision') return [];
      return [[0.15, 0, 0.15, 0.85, d.shape === 'crop' ? 0.25 + 0.1 * (meta & 7) : 0.8, 0.85]];
    case 'slab':
      return [meta & 1 ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1]];
    case 'stairs':
      return stairsBoxes(meta);
    case 'fence':
      if (kind === 'render') return fenceRenderBoxes(nb);
      return connectorBoxes(nb, connectsFence, [0.375, 0.625], [0.375, 0.625], 0, kind === 'collision' ? 1.5 : 1);
    case 'pane':
      return connectorBoxes(nb, connectsPane, [0.4375, 0.5625], [0.4375, 0.5625], 0, 1);
    case 'door': {
      const open = meta & 4;
      return [sidePanel(open ? (meta + 1) & 3 : meta & 3)];
    }
    case 'trapdoor': {
      if (meta & 4) return [sidePanel(meta & 3)];
      return [meta & 8 ? [0, 1 - P, 0, 1, 1, 1] : [0, 0, 0, 1, P, 1]];
    }
    case 'torch': {
      if (kind === 'collision') return [];
      const w = meta & 7;
      if (w === 0) return [[0.4375, 0, 0.4375, 0.5625, 0.625, 0.5625]];
      // Wall torch rests against the wall on side (w - 1).
      return [[[0.4375, 0.2, 0, 0.5625, 0.825, 0.15], [0.85, 0.2, 0.4375, 1, 0.825, 0.5625], [0.4375, 0.2, 0.85, 0.5625, 0.825, 1], [0, 0.2, 0.4375, 0.15, 0.825, 0.5625]][w - 1]];
    }
    case 'lantern':
      return [[0.3125, 0, 0.3125, 0.6875, 0.5625, 0.6875]];
    case 'cactus':
      return kind === 'render' ? FULL : [[0.0625, 0, 0.0625, 0.9375, 1, 0.9375]];
    case 'bed':
      return [[0, 0, 0, 1, 0.5625, 1]];
    case 'farmland':
      return [[0, 0, 0, 1, 0.9375, 1]];
    case 'ladder':
      return [sidePanel(meta & 3, 0.125)];
    default:
      return SOLID[id] ? FULL : [];
  }
}

/** True when the block is a full unit cube for collision purposes (fast path). */
export const isFullCollision = (id) => SOLID[id] && BLOCKS[id].shape === 'cube';
