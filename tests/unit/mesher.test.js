import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meshSection, createPad, padIndex } from '../../src/world/mesher.js';
import { B } from '../../src/world/blocks.js';
import { flatWorld } from './helpers.js';

function padWith(blocks) {
  const pad = createPad();
  pad.light.fill(0xf0);
  for (const [x, y, z, id, meta = 0] of blocks) {
    pad.blocks[padIndex(x, y, z)] = id;
    pad.meta[padIndex(x, y, z)] = meta;
  }
  return pad;
}

test('a lone cube emits six faces', () => {
  const m = meshSection(padWith([[5, 5, 5, B.stone]]), null);
  assert.equal(m.opaque.quads, 6);
  assert.equal(m.translucent, null);
});

test('adjacent opaque cubes hide their shared faces', () => {
  const m = meshSection(padWith([[5, 5, 5, B.stone], [6, 5, 5, B.stone]]), null);
  assert.equal(m.opaque.quads, 10);
});

test('faces against padded neighbors (other chunks) are culled', () => {
  // Block on the section edge with an opaque neighbor in the padding (x = 16).
  const m = meshSection(padWith([[15, 5, 5, B.stone], [16, 5, 5, B.stone]]), null);
  assert.equal(m.opaque.quads, 5);
});

test('glass culls against glass but not against stone', () => {
  const m = meshSection(padWith([[5, 5, 5, B.glass], [6, 5, 5, B.glass]]), null);
  assert.equal(m.opaque.quads, 10);
  const m2 = meshSection(padWith([[5, 5, 5, B.glass], [6, 5, 5, B.stone]]), null);
  assert.equal(m2.opaque.quads, 6 + 5);
});

test('water goes to the translucent pass without internal faces', () => {
  const m = meshSection(padWith([[5, 5, 5, B.water], [6, 5, 5, B.water]]), null);
  assert.equal(m.opaque, null);
  // 2 blocks: 10 outer faces + 2 undersides of the top surface.
  assert.equal(m.translucent.quads, 12);
});

test('cross plants emit double-sided diagonal quads', () => {
  const m = meshSection(padWith([[5, 5, 5, B.tall_grass]]), null);
  assert.equal(m.opaque.quads, 4);
});

test('slab is a half-height box', () => {
  const m = meshSection(padWith([[5, 5, 5, B.stone_slab]]), null);
  assert.equal(m.opaque.quads, 6);
  const ys = [];
  for (let i = 1; i < m.opaque.position.length; i += 3) ys.push(m.opaque.position[i]);
  assert.equal(Math.max(...ys), 5.5);
});

test('ambient occlusion darkens corners next to blocks', () => {
  const m = meshSection(padWith([[5, 5, 5, B.stone], [6, 6, 5, B.stone]]), null);
  const shades = [];
  for (let i = 2; i < m.opaque.light.length; i += 4) shades.push(m.opaque.light[i]);
  assert.ok(Math.min(...shades) < Math.max(...shades) * 0.9);
});

test('meshing a section from a real world produces geometry and uses UV inside the atlas', () => {
  const w = flatWorld(1, 10);
  const pad = createPad();
  w.fillPad(0, 0, 0, pad);
  const m = meshSection(pad, w.getChunk(0, 0).climate);
  // Flat ground: only the top layer of the section is visible (16x16 faces).
  assert.equal(m.opaque.quads, 256);
  for (const v of m.opaque.uv) assert.ok(v >= 0 && v <= 1);
});
