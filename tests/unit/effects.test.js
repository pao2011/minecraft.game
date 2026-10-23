import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ParticleSystem, SHAPE } from '../../src/rendering/particles.js';
import { AmbientFx } from '../../src/game/ambientFx.js';
import { BIOMES, BIOME } from '../../src/world/biomes.js';
import { B } from '../../src/world/blocks.js';
import { ITEMS } from '../../src/items/items.js';
import { WorldGenerator, growTree } from '../../src/world/generator.js';
import { flatWorld } from './helpers.js';

test('biome table is indexed by id (lookups BIOMES[id] depend on it)', () => {
  BIOMES.forEach((b, i) => assert.equal(b.id, i, b.key));
  assert.equal(BIOMES[BIOME.lake].key, 'lake');
  assert.equal(BIOMES[BIOME.cherry].key, 'cherry');
});

test('particle pool: caps at capacity, expires particles, keeps the survivors intact', () => {
  const ps = new ParticleSystem(new THREE.Scene());
  for (let i = 0; i < 2000; i++) ps.emit('glow', { life: 1, x: i });
  assert.equal(ps.glow.n, ps.glow.max);
  ps.emit('matter', { life: 0.1, x: 1 });
  ps.emit('matter', { life: 5, x: 2, shape: SHAPE.leaf });
  ps.emit('matter', { life: 0.1, x: 3 });
  ps.update(0.5, null, { height: 600, fov: 70, far: 80, hdr: true });
  assert.equal(ps.matter.n, 1, 'short-lived particles are gone');
  assert.equal(ps.matter.points.geometry.attributes.position.array[0], 2, 'survivor moved into slot 0');
  assert.equal(ps.glow.n, ps.glow.max);
  ps.update(1, null, { height: 600, fov: 70, far: 80, hdr: false });
  assert.equal(ps.glow.n, 0);
});

test('ambient emitters: torches found by the scan emit flame particles', () => {
  const world = flatWorld(2, 10);
  world.setBlock(2, 11, 2, B.torch);
  world.setBlock(3, 11, 3, B.lava);
  const scene = new THREE.Scene();
  const game = { world, renderer: { pfx: new ParticleSystem(scene), quality: { particles: 1 } }, entities: { mobs: [], projectiles: [] } };
  const fx = new AmbientFx(game);
  fx.density = 1;
  const eye = { x: 2.5, y: 14, z: 2.5 };
  for (let i = 0; i < 25; i++) fx.scan(eye);
  assert.ok(fx.emitters.some((e) => e.id === B.torch), 'torch registered');
  for (let i = 0; i < 60; i++) fx.emitFromBlocks(1 / 30, eye);
  assert.ok(game.renderer.pfx.glow.n > 5, `flames emitted (${game.renderer.pfx.glow.n})`);
  fx.explosion(2, 12, 2, 3);
  assert.ok(game.renderer.pfx.matter.n > 10, 'explosion smoke');
});

test('blossom trees and wood work like other woods', () => {
  for (const k of ['cherry_log', 'cherry_planks', 'cherry_leaves', 'cherry_sapling']) assert.ok(ITEMS[k], k);
  const gen = new WorldGenerator('tree-test');
  const placed = new Map();
  const ctx = { soft: (x, y, z, id) => placed.set(`${x},${y},${z}`, id), set: (x, y, z, id) => placed.set(`${x},${y},${z}`, id) };
  growTree(ctx, { x: 0, y: 20, z: 0, type: 'cherry', hash: 7 });
  const ids = [...placed.values()];
  assert.ok(ids.includes(B.cherry_log) && ids.filter((i) => i === B.cherry_leaves).length > 20);
  void gen;
});
