import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveEntity, collidesAt } from '../../src/entities/physics.js';
import { raycast } from '../../src/world/raycast.js';
import { B } from '../../src/world/blocks.js';
import { flatWorld } from './helpers.js';

const ent = (x, y, z) => ({ pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 }, width: 0.6, height: 1.8, onGround: false });

function simulate(w, e, seconds, opts, each) {
  for (let t = 0; t < seconds; t += 1 / 60) {
    each?.(e);
    e.vel.y -= 28 / 60;
    moveEntity(w, e, 1 / 60, opts);
  }
}

test('entity falls and lands on the ground surface', () => {
  const w = flatWorld(1, 10);
  const e = ent(4.5, 20, 4.5);
  simulate(w, e, 3);
  assert.ok(Math.abs(e.pos.y - 11) < 1e-6, `y=${e.pos.y}`);
  assert.ok(e.onGround);
});

test('walls stop horizontal movement', () => {
  const w = flatWorld(1, 10);
  for (let y = 11; y <= 13; y++) w.setBlock(8, y, 4, B.stone);
  const e = ent(6.5, 11, 4.5);
  e.onGround = true;
  simulate(w, e, 2, { stepHeight: 0.6 }, (en) => (en.vel.x = 4));
  assert.ok(e.pos.x <= 8 - 0.3 + 1e-6, `x=${e.pos.x}`);
  assert.ok(e.pos.x > 7.6);
});

test('step-up climbs a slab but not a full block', () => {
  const w = flatWorld(1, 10);
  w.setBlock(8, 11, 4, B.stone_slab, 0);
  const e = ent(6.5, 11, 4.5);
  simulate(w, e, 0.2);
  simulate(w, e, 1.5, { stepHeight: 0.6 }, (en) => (en.vel.x = 3));
  assert.ok(e.pos.x > 8.2, `crossed the slab, x=${e.pos.x}`);
});

test('sneaking prevents walking off an edge', () => {
  const w = flatWorld(1, 10);
  for (let x = 0; x < 16; x++) for (let z = 0; z < 16; z++) if (x >= 8) w.setBlock(x, 10, z, B.air);
  const e = ent(6.5, 11, 4.5);
  simulate(w, e, 0.2);
  simulate(w, e, 2, { sneakGuard: true }, (en) => (en.vel.x = 2));
  assert.ok(e.pos.y >= 11 - 1e-6, 'still on the ledge');
  assert.ok(e.pos.x < 8.3);
});

test('entity never ends up inside blocks while moving fast', () => {
  const w = flatWorld(1, 10);
  for (let x = 5; x < 10; x++) for (let y = 11; y < 14; y++) w.setBlock(x, y, 8, B.stone);
  const e = ent(7.5, 11, 6.5);
  simulate(w, e, 0.2);
  for (let i = 0; i < 200; i++) {
    e.vel.x = Math.sin(i) * 10;
    e.vel.z = Math.cos(i * 1.3) * 10;
    e.vel.y -= 28 / 60;
    moveEntity(w, e, 1 / 60);
    assert.ok(!collidesAt(w, e, e.pos), `step ${i} at ${JSON.stringify(e.pos)}`);
  }
});

test('raycast finds the targeted block, face and placement cell', () => {
  const w = flatWorld(1, 10);
  const hit = raycast(w, { x: 4.5, y: 12.6, z: 4.5 }, { x: 0, y: -1, z: 0 }, 5);
  assert.equal(hit.x, 4);
  assert.equal(hit.y, 10);
  assert.deepEqual(hit.normal, [0, 1, 0]);
  assert.deepEqual(hit.place, { x: 4, y: 11, z: 4 });
  assert.ok(Math.abs(hit.dist - 1.6) < 1e-6);
  w.setBlock(7, 11, 4, B.stone);
  const side = raycast(w, { x: 4.5, y: 11.5, z: 4.5 }, { x: 1, y: 0, z: 0 }, 5);
  assert.equal(side.x, 7);
  assert.deepEqual(side.normal, [-1, 0, 0]);
  assert.equal(raycast(w, { x: 4.5, y: 11.5, z: 4.5 }, { x: 0, y: 1, z: 0 }, 5), null);
});

test('raycast respects reach and handles negative coordinates', () => {
  const w = flatWorld(1, 10);
  w.setBlock(-3, 11, -3, B.stone);
  const hit = raycast(w, { x: -0.5, y: 11.5, z: -2.5 }, { x: -1, y: 0, z: 0 }, 5);
  assert.equal(hit.x, -3);
  assert.equal(hit.z, -3);
  assert.equal(raycast(w, { x: -0.5, y: 11.5, z: -2.5 }, { x: -1, y: 0, z: 0 }, 1.4), null);
});

test('raycast hits partial shapes exactly (slab top at half height)', () => {
  const w = flatWorld(1, 10);
  w.setBlock(4, 11, 4, B.stone_slab, 0);
  const hit = raycast(w, { x: 4.5, y: 13, z: 4.5 }, { x: 0, y: -1, z: 0 }, 5);
  assert.equal(hit.y, 11);
  assert.ok(Math.abs(hit.point.y - 11.5) < 1e-6);
});
