// Section mesher: turns an 18^3 padded copy of block, meta and light data into vertex arrays.
// Only faces next to non-opaque neighbors are emitted. Cube faces get smooth lighting and
// ambient occlusion; special shapes (slabs, doors, plants...) are built from shapes.js boxes.
// Pure function of its inputs -> runs in Node tests and could move to a worker unchanged.
import { BLOCKS, OPAQUE, B } from './blocks.js';
import { getBoxes, fenceRenderBoxes } from './shapes.js';
import { ATLAS_COLS, ATLAS_ROWS, TILE } from './tiles.js';
import { grassTint, foliageTint, waterTint } from './biomes.js';

export const PAD = 18;
const P2 = PAD * PAD;
export const padIndex = (x, y, z) => ((y + 1) * PAD + (z + 1)) * PAD + (x + 1);

// Faces: 0 +x, 1 -x, 2 +y, 3 -y, 4 +z, 5 -z. Corners are CCW seen from outside.
const FACES = [
  { n: [1, 0, 0], c: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: 0.72 },
  { n: [-1, 0, 0], c: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.72 },
  { n: [0, 1, 0], c: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.0 },
  { n: [0, -1, 0], c: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.5 },
  { n: [0, 0, 1], c: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.86 },
  { n: [0, 0, -1], c: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.86 },
];
// Precompute AO sample offsets per face corner: side1, side2, corner (relative to block + normal).
for (const f of FACES) {
  const axis = f.n.findIndex((v) => v !== 0);
  f.ao = f.c.map((corner) => {
    const t = [0, 1, 2].filter((a) => a !== axis);
    const s1 = [0, 0, 0], s2 = [0, 0, 0];
    s1[t[0]] = corner[t[0]] ? 1 : -1;
    s2[t[1]] = corner[t[1]] ? 1 : -1;
    const add = (a, b) => a.map((v, i) => v + b[i]);
    const base = f.n;
    const o = [add(base, s1), add(base, s2), add(add(base, s1), s2)];
    return o.map(([x, y, z]) => y * P2 + z * PAD + x);
  });
  f.nOff = f.n[1] * P2 + f.n[2] * PAD + f.n[0];
}
const AO_CURVE = [0.42, 0.62, 0.8, 1.0];
const FACING_TO_FACE = [5, 0, 4, 1];

/** UV for a point on a face, in tile space (0..1, v up). Mirrors the cube corner layout. */
function faceUV(f, x, y, z) {
  switch (f) {
    case 0: return [1 - z, y];
    case 1: return [z, y];
    case 2: return [x, 1 - z];
    case 3: return [x, z];
    case 4: return [x, y];
    default: return [1 - x, y];
  }
}

class Buffer {
  constructor(maxQuads) {
    this.pos = new Float32Array(maxQuads * 12);
    this.uv = new Float32Array(maxQuads * 8);
    this.light = new Uint8Array(maxQuads * 16);
    this.color = new Uint8Array(maxQuads * 12);
    this.quads = 0;
    this.max = maxQuads;
  }
  reset() {
    this.quads = 0;
  }
  grow() {
    const n = new Buffer(this.max * 2);
    n.pos.set(this.pos);
    n.uv.set(this.uv);
    n.light.set(this.light);
    n.color.set(this.color);
    n.quads = this.quads;
    Object.assign(this, n);
  }
  /** v: 4 corners of [x, y, z, u, v, sky, blk, shade]; flip swaps the triangle diagonal. */
  quad(v, tint, anim, flip) {
    if (this.quads >= this.max) this.grow();
    const q = this.quads++;
    for (let k = 0; k < 4; k++) {
      const c = v[k];
      this.pos[q * 12 + k * 3] = c[0];
      this.pos[q * 12 + k * 3 + 1] = c[1];
      this.pos[q * 12 + k * 3 + 2] = c[2];
      this.uv[q * 8 + k * 2] = c[3];
      this.uv[q * 8 + k * 2 + 1] = c[4];
      this.light[q * 16 + k * 4] = c[5];
      this.light[q * 16 + k * 4 + 1] = c[6];
      this.light[q * 16 + k * 4 + 2] = c[7];
      this.light[q * 16 + k * 4 + 3] = anim | (flip ? 128 : 0);
      this.color[q * 12 + k * 3] = tint[0];
      this.color[q * 12 + k * 3 + 1] = tint[1];
      this.color[q * 12 + k * 3 + 2] = tint[2];
    }
  }
  /** Copy out compact arrays plus an index buffer. */
  build() {
    const n = this.quads;
    if (!n) return null;
    const verts = n * 4;
    const index = verts > 65535 ? new Uint32Array(n * 6) : new Uint16Array(n * 6);
    for (let q = 0; q < n; q++) {
      const b = q * 4;
      const flip = this.light[q * 16 + 3] & 128;
      const o = q * 6;
      if (flip) {
        index[o] = b + 1; index[o + 1] = b + 2; index[o + 2] = b + 3;
        index[o + 3] = b + 1; index[o + 4] = b + 3; index[o + 5] = b;
      } else {
        index[o] = b; index[o + 1] = b + 1; index[o + 2] = b + 2;
        index[o + 3] = b; index[o + 4] = b + 2; index[o + 5] = b + 3;
      }
    }
    const light = this.light.slice(0, n * 16);
    for (let i = 3; i < light.length; i += 4) light[i] &= 127;
    return { position: this.pos.slice(0, n * 12), uv: this.uv.slice(0, n * 8), light, color: this.color.slice(0, n * 12), index, quads: n };
  }
}

const opaqueBuf = new Buffer(8192);
const transBuf = new Buffer(2048);
const WHITE = [255, 255, 255];
const EPS = 0.0005; // UV inset avoids sampling the neighboring atlas tile

function tileUV(tile, u, v) {
  const col = tile % ATLAS_COLS, row = Math.floor(tile / ATLAS_COLS);
  const uu = Math.min(1 - EPS, Math.max(EPS, u));
  const vv = Math.min(1 - EPS, Math.max(EPS, v));
  return [(col + uu) / ATLAS_COLS, (row + 1 - vv) / ATLAS_ROWS];
}

function tintFor(kind, climate) {
  if (!kind || !climate) return WHITE;
  const t = climate[0] / 127.5 - 1, h = climate[1] / 127.5 - 1;
  const c = kind === 'grass' ? grassTint(t, h) : kind === 'foliage' ? foliageTint(t, h) : waterTint(t, h);
  return [Math.round(c[0] * 255), Math.round(c[1] * 255), Math.round(c[2] * 255)];
}

/**
 * Mesh one 16^3 section.
 * pad: { blocks, meta, light } Uint8Arrays of PAD^3 (light = sky<<4 | block).
 * climate: Uint8Array(512) of the owning chunk column, or null.
 */
export function meshSection(pad, climate, opts = {}) {
  const fancyLeaves = opts.fancyLeaves !== false;
  const { blocks, meta } = pad;
  opaqueBuf.reset();
  transBuf.reset();
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const pi = padIndex(x, y, z);
        const id = blocks[pi];
        if (id === 0) continue;
        const d = BLOCKS[id];
        const cl = climate ? [climate[(z * 16 + x) * 2], climate[(z * 16 + x) * 2 + 1]] : null;
        const tint = d.tint ? tintFor(d.tint, cl) : WHITE;
        switch (d.shape) {
          case 'cube':
            emitCube(pad, x, y, z, pi, id, d, meta[pi], tint, fancyLeaves);
            break;
          case 'liquid':
            emitLiquid(pad, x, y, z, pi, id, d, tint);
            break;
          case 'cross':
            emitCross(pad, x, y, z, pi, d.faces[0], tint, false);
            break;
          case 'crop':
            emitCross(pad, x, y, z, pi, d.crop.tiles[Math.min(3, (meta[pi] & 7) >> 1)], WHITE, true);
            break;
          default:
            emitBoxes(pad, x, y, z, pi, id, d, meta[pi]);
        }
      }
    }
  }
  return { opaque: opaqueBuf.build(), translucent: transBuf.build() };
}

function faceTile(d, f, meta) {
  if (d.axis && (meta & 3)) {
    const axis = meta & 3; // 1 = x, 2 = z
    const endFace = axis === 1 ? f <= 1 : f >= 4;
    return endFace ? d.faces[2] : d.faces[0];
  }
  if (d.frontTile !== undefined && FACING_TO_FACE[meta & 3] === f) {
    if (d.key === 'furnace' && meta & 4) return TILE.furnace_front_lit;
    return d.frontTile;
  }
  return d.faces[f];
}

function emitCube(pad, x, y, z, pi, id, d, meta, tint, fancyLeaves) {
  const { blocks, light } = pad;
  const translucent = d.render === 'translucent';
  const buf = translucent ? transBuf : opaqueBuf;
  const anim = d.leaves ? 4 : 0;
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const ni = pi + face.nOff;
    const nid = blocks[ni];
    if (OPAQUE[nid]) continue;
    if (nid === id && (d.cullSame || translucent || (d.leaves && !fancyLeaves))) continue;
    const tile = faceTile(d, f, meta);
    const v = new Array(4);
    const aoVals = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const c = face.c[k];
      const offs = face.ao[k];
      const s1 = OPAQUE[blocks[pi + offs[0]]], s2 = OPAQUE[blocks[pi + offs[1]]], cc = OPAQUE[blocks[pi + offs[2]]];
      const ao = s1 && s2 ? 0 : 3 - (s1 + s2 + cc);
      aoVals[k] = ao;
      // Smooth light: average the face neighbor with the non-opaque corner samples.
      let sky = light[ni] >> 4, blk = light[ni] & 15, n = 1;
      if (!s1) { sky += light[pi + offs[0]] >> 4; blk += light[pi + offs[0]] & 15; n++; }
      if (!s2) { sky += light[pi + offs[1]] >> 4; blk += light[pi + offs[1]] & 15; n++; }
      if (!cc && !(s1 && s2)) { sky += light[pi + offs[2]] >> 4; blk += light[pi + offs[2]] & 15; n++; }
      const [u, vv] = faceUV(f, c[0], c[1], c[2]);
      const [tu, tv] = tileUV(tile, u, vv);
      v[k] = [x + c[0], y + c[1], z + c[2], tu, tv, Math.round((sky / n) * 17), Math.round((blk / n) * 17), Math.round(face.shade * AO_CURVE[ao] * 255)];
    }
    buf.quad(v, tint, anim, aoVals[0] + aoVals[2] < aoVals[1] + aoVals[3]);
  }
}

function liquidHeight(pad, pi, id) {
  if (pad.blocks[pi + P2] === id) return 1;
  const level = pad.meta[pi] & 7;
  if (pad.meta[pi] & 8) return 0.9;
  return level === 0 ? 0.875 : Math.max(0.12, (8 - level) / 9);
}

function emitLiquid(pad, x, y, z, pi, id, d, tint) {
  const { blocks, light } = pad;
  const buf = d.render === 'translucent' ? transBuf : opaqueBuf;
  const h = liquidHeight(pad, pi, id);
  const tile = d.faces[0];
  const anim = id === B.water ? 2 : 3;
  for (let f = 0; f < 6; f++) {
    const face = FACES[f];
    const ni = pi + face.nOff;
    const nid = blocks[ni];
    if (nid === id) continue;
    if (OPAQUE[nid] && f !== 2) continue;
    if (f === 2 && OPAQUE[nid] && h >= 1) continue;
    if (id === B.water && nid === B.ice) continue;
    const l = OPAQUE[nid] ? light[pi] : light[ni];
    const v = face.c.map((c) => {
      const cy = c[1] ? h : 0;
      const [u, vv] = faceUV(f, c[0], cy, c[2]);
      const [tu, tv] = tileUV(tile, u, vv);
      return [x + c[0], y + cy, z + c[2], tu, tv, (l >> 4) * 17, (l & 15) * 17, Math.round(face.shade * 255)];
    });
    buf.quad(v, tint, anim, false);
    // Underside of the surface so it is visible from below the water.
    if (f === 2 && d.render === 'translucent') buf.quad([v[3], v[2], v[1], v[0]], tint, anim, false);
  }
}

function emitCross(pad, x, y, z, pi, tile, tint, hash) {
  const l = pad.light[pi];
  const sky = (l >> 4) * 17, blk = (l & 15) * 17;
  const planes = hash
    ? [[[0.25, 0, 0], [0.25, 0, 1]], [[0.75, 0, 1], [0.75, 0, 0]], [[0, 0, 0.75], [1, 0, 0.75]], [[1, 0, 0.25], [0, 0, 0.25]]]
    : [[[0.15, 0, 0.15], [0.85, 0, 0.85]], [[0.15, 0, 0.85], [0.85, 0, 0.15]]];
  const h = hash ? 1 : 0.9;
  for (const [a, b] of planes) {
    const corners = [
      [a[0], 0, a[2], 0, 0],
      [b[0], 0, b[2], 1, 0],
      [b[0], h, b[2], 1, 1],
      [a[0], h, a[2], 0, 1],
    ];
    const v = corners.map(([cx, cy, cz, u, vv]) => {
      const [tu, tv] = tileUV(tile, u, vv);
      return [x + cx, y + cy, z + cz, tu, tv, sky, blk, 235];
    });
    opaqueBuf.quad(v, tint, 1, false);
    opaqueBuf.quad([v[1], v[0], v[3], v[2]], tint, 1, false);
  }
}

function emitBoxes(pad, x, y, z, pi, id, d, meta) {
  const { blocks, light } = pad;
  const nb = (dx, dy, dz) => blocks[pi + dy * P2 + dz * PAD + dx];
  let boxes;
  if (d.shape === 'fence') boxes = fenceRenderBoxes(nb);
  else if (d.shape === 'cactus') boxes = [[0.0625, 0, 0.0625, 0.9375, 1, 0.9375]];
  else boxes = getBoxes(id, meta, nb, 'render');
  const own = light[pi];
  for (const box of boxes) {
    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const axis = f >> 1;
      const positive = (f & 1) === 0;
      const onEdge = positive ? box[axis + 3] >= 1 : box[axis] <= 0;
      const ni = pi + face.nOff;
      if (onEdge && OPAQUE[blocks[ni]]) continue;
      let tile = faceTile(d, f, meta);
      if (d.shape === 'door' && meta & 8) tile = TILE.door_top;
      if (d.shape === 'bed' && f === 2) tile = meta & 4 ? TILE.bed_head_top : TILE.bed_foot_top;
      if (d.shape === 'farmland' && f === 2 && meta & 1) tile = TILE.farmland_wet;
      const l = onEdge ? light[ni] : own;
      const sky = (l >> 4) * 17, blk = (l & 15) * 17;
      const v = face.c.map((c) => {
        const px = c[0] ? box[3] : box[0], py = c[1] ? box[4] : box[1], pz = c[2] ? box[5] : box[2];
        let [u, vv] = faceUV(f, px, py, pz);
        if (d.shape === 'torch' && f >= 2 && f <= 3) {
          // Torch caps show the flame pixels near the top of the tile.
          u = 0.4375 + (c[0] ? 0.125 : 0);
          vv = 0.5 + (c[2] ? 0.125 : 0);
        }
        const [tu, tv] = tileUV(tile, u, vv);
        return [x + px, y + py, z + pz, tu, tv, sky, blk, Math.round(face.shade * 255)];
      });
      opaqueBuf.quad(v, WHITE, 0, false);
    }
  }
}

/** Fill a padded section copy from a block-access function (used by tests and the renderer). */
export function createPad() {
  const n = PAD * PAD * PAD;
  return { blocks: new Uint8Array(n), meta: new Uint8Array(n), light: new Uint8Array(n) };
}
