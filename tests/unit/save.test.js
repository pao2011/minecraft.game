import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rleEncode, rleDecode, encodeChunk, decodeChunk, normalizeWorld, migrate, newWorldRecord, currentPalette } from '../../src/save/serialize.js';
import { WorldGenerator } from '../../src/world/generator.js';
import { CHUNK_VOLUME, SAVE_VERSION } from '../../src/config/constants.js';
import { B } from '../../src/world/blocks.js';

test('RLE round-trips arbitrary data including long runs', () => {
  const src = new Uint8Array(1000);
  for (let i = 0; i < src.length; i++) src[i] = i < 600 ? 7 : i % 3;
  const enc = rleEncode(src);
  assert.ok(enc.length < src.length);
  assert.deepEqual(rleDecode(enc, src.length), src);
});

test('RLE rejects truncated or oversized data', () => {
  const enc = rleEncode(new Uint8Array(100).fill(3));
  assert.throws(() => rleDecode(enc.slice(0, enc.length - 2), 100));
  assert.throws(() => rleDecode(enc, 50));
  assert.throws(() => rleDecode(new Uint8Array([0, 1]), 1), /Corrupt/);
});

test('generated chunks compress well and decode identically', () => {
  const g = new WorldGenerator('save-test');
  const { blocks, meta } = g.generateChunk(3, -2);
  const rec = encodeChunk(blocks, meta);
  assert.ok(rec.blocks.length < CHUNK_VOLUME / 2, `compressed to ${rec.blocks.length} bytes`);
  const back = decodeChunk(rec, currentPalette());
  assert.deepEqual(back.blocks, blocks);
  assert.deepEqual(back.meta, meta);
});

test('chunk palette remaps renumbered blocks and drops unknown ones to air', () => {
  const blocks = new Uint8Array(CHUNK_VOLUME).fill(B.stone);
  blocks[0] = B.dirt;
  blocks[1] = 200; // id unknown to this palette
  const rec = encodeChunk(blocks, new Uint8Array(CHUNK_VOLUME));
  // Pretend an older version stored stone at id 9 and dirt at id 2.
  const oldPalette = currentPalette().slice();
  oldPalette[B.stone] = 'dirt';
  oldPalette[B.dirt] = 'stone';
  const back = decodeChunk(rec, oldPalette);
  assert.equal(back.blocks[0], B.stone);
  assert.equal(back.blocks[2], B.dirt);
  assert.equal(back.blocks[1], 0);
});

test('world records validate: bad values are repaired, unusable records rejected', () => {
  const rec = normalizeWorld({
    id: 'w1', seed: 42, name: '   ', mode: 'hacker', difficulty: 'nightmare', saveVersion: 2,
    player: { pos: { x: 'NaN', y: 3, z: 1 }, health: 999, hunger: -5, inventory: [{ id: 'stone', count: 3 }, { id: 'nope', count: 1 }], selected: 42 },
    containers: { '1,2,3': { type: 'chest', slots: [{ id: 'apple', count: 2 }] }, 'bad key': { type: 'chest' } },
    time: { tod: 1.25, day: -3 },
  });
  assert.equal(rec.name, 'Unnamed World');
  assert.equal(rec.seed, '42');
  assert.equal(rec.mode, 'survival');
  assert.equal(rec.difficulty, 'normal');
  assert.equal(rec.player.pos, null, 'invalid position falls back to spawn');
  assert.equal(rec.player.health, 20);
  assert.equal(rec.player.hunger, 0);
  assert.equal(rec.player.selected, 8);
  assert.deepEqual(rec.player.inventory.slice(0, 2), [{ id: 'stone', count: 3 }, null]);
  assert.deepEqual(Object.keys(rec.containers), ['1,2,3']);
  assert.equal(rec.time.tod, 0.25);
  assert.equal(rec.time.day, 0);
  assert.ok(rec.warnings.length > 0);
  assert.throws(() => normalizeWorld({ id: 'x' }), /seed/);
  assert.throws(() => normalizeWorld(null));
  assert.throws(() => normalizeWorld({ id: 'x', seed: 1, saveVersion: SAVE_VERSION + 1 }), /newer/);
});

test('v1 saves migrate to the current format', () => {
  const v1 = { id: 'old', seed: 'abc', saveVersion: 1, player: { health: 10 }, inventory: [{ id: 'torch', count: 5 }] };
  const m = migrate(v1);
  assert.equal(m.saveVersion, 2);
  assert.deepEqual(m.player.inventory, [{ id: 'torch', count: 5 }]);
  assert.equal(m.weather.state, 'clear');
  const rec = normalizeWorld(v1);
  assert.equal(rec.player.inventory[0].count, 5);
  assert.equal(rec.rules.mobSpawning, true);
});

test('new world records are complete and current', () => {
  const r = newWorldRecord({ id: 'n', name: 'Fresh', seed: 's', mode: 'creative', difficulty: 'hard', rules: { dayLength: 'long' } });
  assert.equal(r.saveVersion, SAVE_VERSION);
  assert.equal(r.mode, 'creative');
  assert.equal(r.rules.dayLength, 'long');
  assert.equal(r.player.inventory.length, 36);
  assert.equal(r.palette.length, currentPalette().length);
});
