import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Survival } from '../../src/game/survival.js';
import { Player } from '../../src/entities/player.js';
import { Mob } from '../../src/entities/mob.js';
import { findPath } from '../../src/entities/pathfind.js';
import { B, SOLID } from '../../src/world/blocks.js';
import { flatWorld } from './helpers.js';

function stubGame(mode = 'survival', difficulty = 'normal') {
  const events = [];
  const world = flatWorld(1, 10);
  const game = {
    record: { mode, difficulty, rules: {} },
    world,
    player: new Player(),
    onPlayerHurt: (d, s) => events.push(['hurt', d, s.type]),
    onPlayerDeath: () => events.push(['death']),
    onItemBroken: (id) => events.push(['broken', id]),
    onFootstep() {},
    onLand() {},
    events,
  };
  game.player.pos = { x: 4.5, y: 11, z: 4.5 };
  game.survival = new Survival(game);
  return game;
}

const noInput = { moveX: 0, moveZ: 0, jump: false, jumpPressed: false, sneak: false, sprint: false };

test('damage respects the invulnerability window (no per-frame damage)', () => {
  const g = stubGame();
  for (let i = 0; i < 60; i++) g.survival.damage(2, { type: 'mob' });
  assert.equal(g.player.health, 18);
  g.survival.update(0.6);
  g.survival.damage(2, { type: 'mob' });
  assert.equal(g.player.health, 16);
});

test('armor reduces damage and wears down; fall damage bypasses armor', () => {
  const g = stubGame();
  g.player.armor.set(1, { id: 'iron_chestplate', count: 1 });
  g.player.armor.set(2, { id: 'iron_leggings', count: 1 });
  g.survival.damage(10, { type: 'mob' }); // 11 armor points -> 44% reduction
  assert.equal(g.player.health, 20 - 5.5);
  assert.ok(g.player.armor.get(1).damage > 0);
  g.survival.invuln = 0;
  g.survival.damage(4, { type: 'fall' });
  assert.equal(g.player.health, 20 - 5.5 - 4);
});

test('creative mode ignores damage and hunger', () => {
  const g = stubGame('creative');
  g.survival.damage(100, { type: 'mob' });
  g.player.hunger = 3;
  g.survival.update(0.1);
  assert.equal(g.player.health, 20);
  assert.equal(g.player.hunger, 20);
});

test('eating restores hunger and saturation; full players cannot eat (except apples)', () => {
  const g = stubGame();
  g.player.hunger = 10;
  g.player.saturation = 0;
  assert.ok(g.survival.canEat('bread'));
  g.survival.eat('cooked_steak');
  assert.equal(g.player.hunger, 18);
  assert.equal(g.player.saturation, 12.8);
  g.player.hunger = 20;
  assert.ok(!g.survival.canEat('bread'));
  assert.ok(g.survival.canEat('apple'));
  assert.ok(!g.survival.canEat('stone'));
});

test('dying reports once and regeneration needs a full stomach', () => {
  const g = stubGame();
  g.player.health = 10;
  g.player.hunger = 20;
  g.player.saturation = 0;
  for (let i = 0; i < 20; i++) g.survival.update(0.5);
  assert.ok(g.player.health > 10, 'regenerates when fed');
  g.player.health = 10;
  g.player.hunger = 12;
  for (let i = 0; i < 20; i++) g.survival.update(0.5);
  assert.equal(g.player.health, 10, 'no regeneration while hungry');
  g.survival.invuln = 0;
  g.survival.damage(50, { type: 'mob' });
  assert.equal(g.events.filter((e) => e[0] === 'death').length, 1);
});

test('drowning: air runs out underwater, then damage ticks', () => {
  const g = stubGame();
  g.player.headInWater = true;
  for (let i = 0; i < 26; i++) g.survival.update(0.5);
  assert.equal(g.player.air, 0);
  assert.ok(g.player.health < 20);
});

test('player climbs ladders and swims upward', () => {
  const g = stubGame();
  const w = g.world;
  for (let y = 11; y < 16; y++) {
    w.setBlock(4, y, 3, B.stone);
    w.setBlock(4, y, 4, B.ladder, 0);
  }
  const p = g.player;
  p.pos = { x: 4.5, y: 11, z: 4.5 };
  for (let i = 0; i < 60; i++) p.update(1 / 60, { ...noInput, jump: true }, w, { creative: false, hungerAllowsSprint: true });
  assert.ok(p.pos.y > 12, `climbed to ${p.pos.y.toFixed(2)}`);

  for (let x = 8; x < 11; x++) for (let z = 8; z < 11; z++) for (let y = 7; y < 11; y++) w.setBlock(x, y, z, B.water, 0);
  p.pos = { x: 9.5, y: 7.2, z: 9.5 };
  p.vel = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 60; i++) p.update(1 / 60, { ...noInput, jump: true }, w, { creative: false, hungerAllowsSprint: true });
  assert.ok(p.pos.y > 8, `swam up to ${p.pos.y.toFixed(2)}`);
});

test('fall damage from a high drop, none from a small hop', () => {
  const g = stubGame();
  const p = g.player;
  p.hunger = 17; // below the regeneration threshold so healing does not mask the damage
  p.pos = { x: 4.5, y: 21, z: 4.5 };
  for (let i = 0; i < 120; i++) {
    p.update(1 / 60, noInput, g.world, { creative: false, hungerAllowsSprint: true });
    g.survival.update(1 / 60);
  }
  assert.equal(p.health, 20 - 7, `fell 10 blocks -> ${p.health}`);
  p.pos = { x: 4.5, y: 12, z: 4.5 };
  const h = p.health;
  for (let i = 0; i < 60; i++) {
    p.update(1 / 60, noInput, g.world, { creative: false, hungerAllowsSprint: true });
    g.survival.update(1 / 60);
  }
  assert.equal(p.health, h);
});

test('saplings grow into trees; crops advance with random ticks', () => {
  const w = flatWorld(1, 10);
  w.setBlock(4, 10, 4, B.grass);
  w.setBlock(4, 11, 4, B.oak_sapling);
  assert.ok(w.growSapling(4, 11, 4, 'oak'));
  assert.equal(w.getBlock(4, 11, 4), B.oak_log);
  assert.ok([...Array(8).keys()].some((dy) => w.getBlock(4, 13 + dy, 4) === B.oak_leaves || w.getBlock(5, 13 + dy, 4) === B.oak_leaves));
  w.setBlock(8, 10, 8, B.farmland, 1);
  w.setBlock(8, 11, 8, B.wheat, 0);
  for (let i = 0; i < 100; i++) w.randomTickBlock(8, 11, 8, B.wheat, () => 0.01);
  assert.equal(w.getMeta(8, 11, 8) & 7, 7);
});

test('pathfinding routes around a wall and climbs single steps', () => {
  const w = flatWorld(1, 10);
  for (let x = 0; x < 9; x++) for (let y = 11; y < 14; y++) w.setBlock(x, y, 6, B.stone);
  w.setBlock(4, 11, 9, B.stone); // a 1-block step on the way
  const path = findPath(w, { x: 2, y: 11, z: 3 }, { x: 2, y: 11, z: 10 }, { maxNodes: 600 });
  assert.ok(path && path.length > 7);
  const last = path[path.length - 1];
  assert.equal(last.x, 2);
  assert.equal(last.z, 10);
  assert.ok(path.every((n) => !SOLID[w.getBlock(n.x, n.y, n.z)] && !SOLID[w.getBlock(n.x, n.y + 1, n.z)]), 'never walks through solid blocks');
});

test('hostile AI chases and attacks a visible player; passive mobs flee when hit', () => {
  const w = flatWorld(1, 10);
  const player = new Player();
  player.pos = { x: 6.5, y: 11, z: 6.5 };
  const m = new Mob('shambler', { x: 6.5, y: 11, z: 12.5 });
  const events = [];
  for (let i = 0; i < 400 && !events.some((e) => e.type === 'melee'); i++) {
    m.update(1 / 20, { world: w, player, playerTargetable: true, isDay: false, events });
  }
  assert.ok(events.some((e) => e.type === 'melee'), 'shambler reached and attacked the player');
  const c = new Mob('cluck', { x: 4.5, y: 11, z: 4.5 });
  c.hurt(1, { x: 5.5, y: 11, z: 4.5 });
  assert.equal(c.state, 'flee');
  assert.ok(!c.hurt(1, { x: 5.5, y: 11, z: 4.5 }), 'invulnerable right after a hit');
});

test('daylight burns undead-like creatures under open sky', () => {
  const w = flatWorld(1, 10);
  const player = new Player();
  player.pos = { x: 40, y: 11, z: 40 };
  const m = new Mob('bonecaster', { x: 6.5, y: 11, z: 6.5 });
  const events = [];
  for (let i = 0; i < 400 && !m.dead; i++) m.update(1 / 20, { world: w, player, playerTargetable: true, isDay: true, events });
  assert.ok(m.dead, 'burned in sunlight');
});
