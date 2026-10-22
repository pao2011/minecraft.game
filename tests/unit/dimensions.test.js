import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../../src/world/world.js';
import { Chunk } from '../../src/world/chunk.js';
import { B, BLOCKS } from '../../src/world/blocks.js';
import { findFrame, lightPortal, buildPortal, findPortalNear, tryOpenGate, findGateCenter } from '../../src/game/portals.js';
import { structuresIn } from '../../src/world/structures.js';
import { WorldGenerator } from '../../src/world/generator.js';
import { WORLD_HEIGHT } from '../../src/config/constants.js';
import { localIndex } from '../../src/world/coords.js';
import { flatWorld } from './helpers.js';

const countOf = (blocks, id) => blocks.reduce((n, b) => n + (b === id ? 1 : 0), 0);

test('Nether chunks are deterministic, bedrock-capped and contain nether minerals and lava', () => {
  const a = new World('nether-seed', 'nether').generator, b = new World('nether-seed', 'nether').generator;
  const ca = a.generateChunk(2, -3), cb = b.generateChunk(2, -3);
  assert.deepEqual(ca.blocks, cb.blocks);
  assert.notDeepEqual(ca.blocks, new World('other', 'nether').generator.generateChunk(2, -3).blocks);
  for (let i = 0; i < 256; i++) {
    assert.equal(ca.blocks[localIndex(i % 16, 0, Math.floor(i / 16))], B.bedrock, 'floor');
    assert.equal(ca.blocks[localIndex(i % 16, WORLD_HEIGHT - 1, Math.floor(i / 16))], B.bedrock, 'ceiling');
  }
  let ores = { quartz_ore: 0, nether_gold_ore: 0, abyssal_ore: 0, lava: 0, cinderrock: 0 };
  for (let cx = -3; cx <= 3; cx++) {
    const { blocks } = a.generateChunk(cx, 0);
    for (const k of Object.keys(ores)) ores[k] += countOf(blocks, B[k]);
  }
  for (const [k, n] of Object.entries(ores)) assert.ok(n > 0, `found ${k}`);
  assert.ok(ores.quartz_ore > ores.abyssal_ore * 5, 'abyssal ore is far rarer than quartz');
});

test('End has a main island, obsidian pillars with void crystals, and void beyond', () => {
  const g = new World('end-seed', 'end').generator;
  let stone = 0, crystals = 0, obsidian = 0;
  for (let cx = -4; cx <= 3; cx++) for (let cz = -4; cz <= 3; cz++) {
    const { blocks } = g.generateChunk(cx, cz);
    stone += countOf(blocks, B.void_stone);
    crystals += countOf(blocks, B.void_crystal);
    obsidian += countOf(blocks, B.obsidian);
  }
  assert.ok(stone > 20000);
  assert.equal(crystals, 10);
  assert.ok(obsidian > 1000);
  assert.equal(g.column(90, 0).h, 0, 'gap between main island and outer isles is void');
  const spawn = g.findSpawn();
  assert.ok(g.island(Math.floor(spawn.x), Math.floor(spawn.z)));
});

test('mineshafts exist, carve tunnels with supports, cobwebs and a loot chest', () => {
  const g = new WorldGenerator('mine-test');
  let shaft = null;
  for (let rx = -6; rx <= 6 && !shaft; rx++) for (let rz = -6; rz <= 6 && !shaft; rz++) {
    shaft = structuresIn(g, rx * 128, rz * 128, rx * 128 + 128, rz * 128 + 128).find((s) => s.type === 'mineshaft');
  }
  assert.ok(shaft, 'found a mineshaft');
  const totals = { fence: 0, oak_planks: 0, chest: 0, cobweb: 0, air: 0 };
  for (let cx = Math.floor(shaft.x / 16); cx <= Math.floor((shaft.x + 47) / 16); cx++) {
    for (let cz = Math.floor(shaft.z / 16); cz <= Math.floor((shaft.z + 47) / 16); cz++) {
      const { blocks } = g.generateChunk(cx, cz);
      for (const y of [shaft.y + 1, shaft.y + 2, shaft.y + 3]) {
        for (let i = 0; i < 256; i++) {
          const id = blocks[y * 256 + i];
          for (const k of Object.keys(totals)) if (id === B[k]) totals[k]++;
        }
      }
    }
  }
  assert.ok(totals.fence >= 8 && totals.oak_planks >= 8, JSON.stringify(totals));
  assert.ok(totals.chest >= 1, 'chest present');
  assert.ok(totals.air > 100, 'tunnels carved');
});

test('Void Gate sanctums exist in the overworld', () => {
  let found = 0;
  for (const seed of ['a', 'b', 'c', 'd']) {
    const g = new WorldGenerator(seed);
    for (let rx = -20; rx <= 20; rx++) for (let rz = -20; rz <= 20; rz++) {
      if (g.cachedStructure(g.structureFns[1][1], rx, rz)?.type === 'sanctum') found++;
    }
  }
  assert.ok(found > 0, 'at least one sanctum in four 41x41-region samples');
});

test('portal frames: detection, lighting, breaking the frame removes the portal', () => {
  const w = flatWorld(1, 10);
  buildPortal(w, 4, 11, 4, 0);
  // buildPortal lights it already; remove the panes and relight with the frame detector.
  for (const [x, y] of [[4, 11], [5, 11], [4, 12], [5, 12], [4, 13], [5, 13]]) w.setBlock(x, y, 4, B.air);
  const f = findFrame(w, 4, 11, 4);
  assert.ok(f && f.cells.length === 6 && f.axis === 0);
  assert.ok(lightPortal(w, 4, 12, 4));
  assert.equal(w.getBlock(5, 13, 4), B.nether_portal);
  assert.equal(findPortalNear(w, 6, 6, 8)?.y, 11);
  // An incomplete frame is not a portal.
  const w2 = flatWorld(1, 10);
  for (let j = 0; j <= 3; j++) w2.setBlock(4, 11 + j, 4, B.obsidian);
  assert.equal(findFrame(w2, 5, 12, 4), null);
  // Mining a frame block collapses the portal.
  w.breakBlock(3, 12, 4);
  assert.equal(w.getBlock(4, 12, 4), B.air);
  assert.equal(w.getBlock(5, 13, 4), B.air);
});

test('portals work along the Z axis too', () => {
  const w = flatWorld(1, 10);
  buildPortal(w, 4, 11, 4, 1);
  assert.equal(w.getBlock(4, 12, 5), B.nether_portal);
  assert.equal(w.getMeta(4, 12, 5), 1);
});

test('Void Gate opens only when all 12 frames hold an eye', () => {
  const w = flatWorld(1, 10);
  const ring = [];
  for (let i = -1; i <= 1; i++) ring.push([6 + i, 4], [6 + i, 8], [4, 6 + i], [8, 6 + i]);
  for (const [x, z] of ring) w.setBlock(x, 11, z, B.end_frame, 0);
  assert.deepEqual(findGateCenter(w, 4, 11, 6), { x: 6, z: 6 });
  ring.slice(0, 11).forEach(([x, z]) => w.setBlock(x, 11, z, B.end_frame, 4));
  assert.equal(tryOpenGate(w, 6, 11, 4), false);
  const [lx, lz] = ring[11];
  w.setBlock(lx, 11, lz, B.end_frame, 4);
  assert.equal(tryOpenGate(w, 6, 11, 4), true);
  assert.equal(w.getBlock(6, 11, 6), B.end_portal);
});

test('explosions break weak blocks, spare bedrock and obsidian, and drop nothing by themselves', () => {
  const w = flatWorld(1, 10);
  w.setBlock(4, 11, 4, B.obsidian);
  const broken = [];
  w.on('blockBroken', (x, y, z, id, m, cause) => broken.push(cause));
  const n = w.explode(4.5, 10.5, 4.5, 3, () => 0);
  assert.ok(n > 10);
  assert.equal(w.getBlock(4, 11, 4), B.obsidian);
  assert.equal(w.getBlock(4, 0, 4), B.bedrock);
  assert.ok(broken.every((c) => c === 'explosion'));
});

test('lava source meeting water becomes obsidian', () => {
  const w = flatWorld(1, 10);
  w.setBlock(4, 11, 4, B.lava, 0);
  w.setBlock(5, 11, 4, B.water, 0);
  for (let i = 0; i < 20; i++) { w.time += 2; w.tickFluids(256); }
  assert.equal(w.getBlock(4, 11, 4), B.obsidian);
});

test('new minerals have correct tool requirements', () => {
  const need = { tidestone_ore: 2, verdant_ore: 3, abyssal_ore: 4, obsidian: 4, quartz_ore: 1 };
  for (const [k, lvl] of Object.entries(need)) assert.equal(BLOCKS[B[k]].toolLevel, lvl, k);
});

test('every mob has a registered voice and every item has an icon sprite entry', async () => {
  const { MOBS } = await import('../../src/entities/mobs.js');
  const src = (await import('node:fs')).readFileSync(new URL('../../src/audio/audio.js', import.meta.url), 'utf8');
  for (const [k, d] of Object.entries(MOBS)) assert.ok(new RegExp(`\\b${d.sound}: \\{`).test(src), `${k} voice ${d.sound}`);
  const icons = (await import('node:fs')).readFileSync(new URL('../../src/rendering/icons.js', import.meta.url), 'utf8');
  const { ITEMS } = await import('../../src/items/items.js');
  for (const [k, it] of Object.entries(ITEMS)) if (it.kind !== 'block' && !it.tool?.tier && !it.armor) assert.ok(icons.includes(`  ${k}: () =>`), `icon for ${k}`);
});
