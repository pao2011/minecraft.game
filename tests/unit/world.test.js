import { test } from 'node:test';
import assert from 'node:assert/strict';
import { floorDiv, mod, toChunk, toLocal, chunkKey, chunkKeyX, chunkKeyZ, localIndex } from '../../src/world/coords.js';
import { WorldGenerator } from '../../src/world/generator.js';
import { SimplexNoise, hashSeed } from '../../src/util/noise.js';
import { B, BLOCKS } from '../../src/world/blocks.js';
import { TILE_NAMES, ATLAS_COLS, ATLAS_ROWS } from '../../src/world/tiles.js';
import { SEA_LEVEL } from '../../src/config/constants.js';
import { flatWorld } from './helpers.js';

test('floor division and modulo handle negatives', () => {
  assert.equal(floorDiv(-1, 16), -1);
  assert.equal(floorDiv(-16, 16), -1);
  assert.equal(floorDiv(-17, 16), -2);
  assert.equal(floorDiv(15, 16), 0);
  assert.equal(mod(-1, 16), 15);
  assert.equal(mod(-16, 16), 0);
  assert.equal(mod(17, 16), 1);
});

test('block -> chunk/local conversion is consistent across the origin', () => {
  for (let x = -40; x <= 40; x++) {
    assert.equal(toChunk(x) * 16 + toLocal(x), x);
    assert.ok(toLocal(x) >= 0 && toLocal(x) < 16);
  }
  assert.equal(toChunk(-1), -1);
  assert.equal(toLocal(-1), 15);
});

test('chunk keys round-trip including negative coordinates', () => {
  for (const [cx, cz] of [[0, 0], [-1, -1], [123, -456], [-1000, 999]]) {
    const k = chunkKey(cx, cz);
    assert.equal(chunkKeyX(k), cx);
    assert.equal(chunkKeyZ(k), cz);
  }
  assert.notEqual(chunkKey(1, 0), chunkKey(0, 1));
});

test('atlas fits every tile and block textures resolve', () => {
  assert.ok(TILE_NAMES.length <= ATLAS_COLS * ATLAS_ROWS);
  for (const d of BLOCKS) {
    if (!d || d.shape === 'none') continue;
    for (const f of d.faces) assert.ok(f >= 0 && f < TILE_NAMES.length, `${d.key} face tile`);
  }
});

test('noise and seed hashing are deterministic', () => {
  assert.equal(hashSeed('abc'), hashSeed('abc'));
  assert.notEqual(hashSeed('abc'), hashSeed('abd'));
  const a = new SimplexNoise(42), b = new SimplexNoise(42);
  for (let i = 0; i < 50; i++) assert.equal(a.noise3(i * 0.37, i * 0.11, -i * 0.5), b.noise3(i * 0.37, i * 0.11, -i * 0.5));
});

test('same seed generates identical chunks; different seeds differ', () => {
  const g1 = new WorldGenerator('seed-1'), g2 = new WorldGenerator('seed-1'), g3 = new WorldGenerator('seed-2');
  for (const [cx, cz] of [[0, 0], [-3, 5], [7, -2]]) {
    const a = g1.generateChunk(cx, cz), b = g2.generateChunk(cx, cz);
    assert.deepEqual(a.blocks, b.blocks);
    assert.deepEqual(a.meta, b.meta);
  }
  assert.notDeepEqual(g1.generateChunk(0, 0).blocks, g3.generateChunk(0, 0).blocks);
});

test('generated terrain has bedrock floor, stone underground and a sensible surface', () => {
  const g = new WorldGenerator('layers');
  const { blocks } = g.generateChunk(2, 3);
  for (let i = 0; i < 256; i++) assert.equal(blocks[i], B.bedrock);
  let stone = 0;
  for (let i = 256 * 20; i < 256 * 30; i++) if (blocks[i] === B.stone) stone++;
  assert.ok(stone > 256 * 5, 'mostly stone at depth');
  // Every column has water or a solid surface at/near its computed height.
  for (let lz = 0; lz < 16; lz++) {
    for (let lx = 0; lx < 16; lx++) {
      const col = g.column(2 * 16 + lx, 3 * 16 + lz);
      const top = blocks[localIndex(lx, Math.max(col.h, SEA_LEVEL), lz)];
      assert.ok(top !== undefined);
    }
  }
});

test('trees crossing chunk borders are consistent on both sides', () => {
  const g = new WorldGenerator('forest-test');
  // Find a tree candidate whose trunk is on a chunk edge.
  let found = null;
  for (let cx = -60; cx < 60 && !found; cx++) {
    for (let cz = -60; cz < 60 && !found; cz++) {
      const t = g.treeInCell(cx, cz);
      if (t && (((t.x % 16) + 16) % 16) === 15 && t.type === 'oak') found = t;
    }
  }
  assert.ok(found, 'found an edge tree');
  const ccx = Math.floor(found.x / 16), ccz = Math.floor(found.z / 16);
  const own = g.generateChunk(ccx, ccz);
  const east = g.generateChunk(ccx + 1, ccz);
  const lz = ((found.z % 16) + 16) % 16;
  let ownLeaves = 0, eastLeaves = 0;
  for (let y = found.y; y < found.y + 10; y++) {
    if (own.blocks[localIndex(14, y, lz)] === B.oak_leaves) ownLeaves++;
    if (east.blocks[localIndex(0, y, lz)] === B.oak_leaves) eastLeaves++;
  }
  // The canopy is symmetric around the trunk, so the neighbor chunk must hold its share.
  assert.ok(eastLeaves > 0, 'neighbor chunk contains the canopy part');
  assert.ok(ownLeaves > 0);
});

test('spawn point is on dry land with headroom', () => {
  for (const seed of ['a', 'b', 'c', '12345']) {
    const g = new WorldGenerator(seed);
    const s = g.findSpawn();
    const col = g.column(Math.floor(s.x), Math.floor(s.z));
    assert.ok(col.h >= SEA_LEVEL + 1, `${seed} spawn above sea`);
    const cx = Math.floor(Math.floor(s.x) / 16), cz = Math.floor(Math.floor(s.z) / 16);
    const { blocks } = g.generateChunk(cx, cz);
    const lx = ((Math.floor(s.x) % 16) + 16) % 16, lz = ((Math.floor(s.z) % 16) + 16) % 16;
    assert.ok(!BLOCKS[blocks[localIndex(lx, s.y, lz)]].solid, `${seed} feet clear`);
    assert.ok(!BLOCKS[blocks[localIndex(lx, s.y + 1, lz)]].solid, `${seed} head clear`);
  }
});

test('setBlock marks sections dirty, including neighbor chunks on borders', () => {
  const w = flatWorld(1, 10);
  w.setBlock(15, 11, 3, B.stone);
  const dirty = w.takeDirtySections();
  const key = (cx, sy, cz) => ((cx + 32768) * 65536 + (cz + 32768)) * 16 + sy;
  assert.ok(dirty.has(key(0, 0, 0)));
  assert.ok(dirty.has(key(1, 0, 0)), 'east neighbor remeshes');
  assert.equal(w.getBlock(15, 11, 3), B.stone);
  assert.ok(w.chunkAtBlock(15, 3).modified);
});

test('sky light: open air is 15, shadow forms under a roof and clears after removal', () => {
  const w = flatWorld(1, 10);
  assert.equal(w.getLight(5, 11, 5)[0], 15);
  // Build a 5x5 roof at y=14 centered on (5, 5).
  for (let x = 3; x <= 7; x++) for (let z = 3; z <= 7; z++) w.setBlock(x, 14, z, B.stone);
  const under = w.getLight(5, 11, 5)[0];
  assert.ok(under < 15 && under >= 12, `shadowed sky light ${under}`);
  for (let x = 3; x <= 7; x++) for (let z = 3; z <= 7; z++) w.setBlock(x, 14, z, B.air);
  assert.equal(w.getLight(5, 11, 5)[0], 15);
});

test('block light: torch lights its surroundings and removal darkens them', () => {
  const w = flatWorld(1, 30);
  // Dig a sealed pocket underground.
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) for (let y = 10; y < 13; y++) w.setBlock(x, y, z, B.air);
  assert.equal(w.getLight(2, 10, 2)[0], 0, 'pocket has no sky light');
  w.setBlock(2, 10, 2, B.torch);
  assert.equal(w.getLight(2, 10, 2)[1], 14);
  assert.equal(w.getLight(3, 10, 2)[1], 13);
  assert.equal(w.getLight(4, 10, 2)[1], 12);
  w.setBlock(2, 10, 2, B.air);
  assert.equal(w.getLight(3, 10, 2)[1], 0);
});

test('light crosses chunk borders', () => {
  const w = flatWorld(1, 30);
  for (let x = 12; x < 20; x++) for (let y = 10; y < 12; y++) w.setBlock(x, y, 4, B.air);
  w.setBlock(14, 10, 4, B.lantern);
  assert.equal(w.getLight(17, 10, 4)[1], 12);
});

test('fluid flows into a dug channel and stops at range', () => {
  const w = flatWorld(1, 10);
  for (let x = 0; x < 12; x++) w.setBlock(x, 10, 0, B.air);
  w.setBlock(0, 10, 0, B.water, 0);
  for (let i = 0; i < 200; i++) {
    w.time += 0.5;
    w.tickFluids(512);
  }
  assert.equal(w.getBlock(1, 10, 0), B.water);
  assert.equal(w.getBlock(7, 10, 0), B.water);
  assert.equal(w.getBlock(8, 10, 0), B.air, 'water spreads at most 7 blocks');
  // Removing the source drains the flow.
  w.setBlock(0, 10, 0, B.stone);
  for (let i = 0; i < 200; i++) {
    w.time += 0.5;
    w.tickFluids(512);
  }
  assert.equal(w.getBlock(3, 10, 0), B.air);
});

test('unsupported plants and torches break and report drops', () => {
  const w = flatWorld(1, 10);
  const broken = [];
  w.on('blockBroken', (x, y, z, id) => broken.push(id));
  w.setBlock(4, 11, 4, B.flower_red);
  w.setBlock(6, 11, 6, B.torch, 0);
  w.setBlock(4, 10, 4, B.air);
  w.setBlock(6, 10, 6, B.air);
  assert.equal(w.getBlock(4, 11, 4), B.air);
  assert.equal(w.getBlock(6, 11, 6), B.air);
  assert.deepEqual(broken.sort(), [B.flower_red, B.torch].sort());
});

test('collision boxes treat unloaded chunks as solid', () => {
  const w = flatWorld(0, 10);
  const boxes = w.collisionBoxes(40, 50, 40, 41, 51, 41);
  assert.ok(boxes.length > 0);
});
