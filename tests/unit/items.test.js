import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Inventory, clickSlot, quickMove } from '../../src/items/inventory.js';
import { RECIPES, craft, maxCraftable, ingredientStatus, tickFurnace, newFurnaceState, recipesFor } from '../../src/items/recipes.js';
import { ITEMS, breakTime, blockDrops, canHarvest, placedBlock, isValidItem } from '../../src/items/items.js';
import { rollLoot } from '../../src/items/loot.js';
import { B } from '../../src/world/blocks.js';

const R = (out) => RECIPES.find((r) => r.out.id === out);

test('adding merges into existing stacks before using empty slots', () => {
  const inv = new Inventory(4);
  inv.set(2, { id: 'dirt', count: 60 });
  assert.equal(inv.add({ id: 'dirt', count: 10 }), 0);
  assert.equal(inv.get(2).count, 64);
  assert.equal(inv.get(0).count, 6);
});

test('full inventory reports leftovers instead of destroying items', () => {
  const inv = new Inventory(2);
  inv.add({ id: 'stone', count: 64 });
  inv.add({ id: 'stone', count: 64 });
  assert.equal(inv.add({ id: 'stone', count: 5 }), 5);
  assert.equal(inv.count('stone'), 128);
  assert.equal(inv.spaceFor({ id: 'stone', count: 1 }), 0);
});

test('tools never stack', () => {
  const inv = new Inventory(3);
  inv.add({ id: 'iron_pickaxe', count: 1 });
  inv.add({ id: 'iron_pickaxe', count: 1 });
  assert.equal(inv.get(0).count, 1);
  assert.equal(inv.get(1).count, 1);
});

test('clickSlot: pick all, split half, place one, merge and swap', () => {
  const inv = new Inventory(3);
  inv.set(0, { id: 'cobblestone', count: 10 });
  let cursor = clickSlot(inv, 0, null, 'half');
  assert.equal(cursor.count, 5);
  assert.equal(inv.get(0).count, 5);
  cursor = clickSlot(inv, 1, cursor, 'half');
  assert.equal(inv.get(1).count, 1);
  assert.equal(cursor.count, 4);
  cursor = clickSlot(inv, 0, cursor, 'all');
  assert.equal(cursor, null);
  assert.equal(inv.get(0).count, 9);
  inv.set(2, { id: 'dirt', count: 3 });
  cursor = clickSlot(inv, 2, null, 'all');
  cursor = clickSlot(inv, 0, cursor, 'all');
  assert.equal(inv.get(0).id, 'dirt');
  assert.equal(cursor.id, 'cobblestone');
  assert.equal(inv.count('dirt') + inv.count('cobblestone') + cursor.count, 3 + 10);
});

test('quickMove transfers between inventories and keeps leftovers', () => {
  const a = new Inventory(2), b = new Inventory(1);
  a.set(0, { id: 'sand', count: 40 });
  b.set(0, { id: 'sand', count: 50 });
  quickMove(a, 0, b);
  assert.equal(b.get(0).count, 64);
  assert.equal(a.get(0).count, 26);
});

test('inventory JSON round trip drops invalid entries safely', () => {
  const inv = new Inventory(4);
  inv.set(0, { id: 'stone_pickaxe', count: 1, damage: 7 });
  inv.set(3, { id: 'apple', count: 5 });
  const back = Inventory.fromJSON(JSON.parse(JSON.stringify(inv)), 4);
  assert.deepEqual(back.get(0), { id: 'stone_pickaxe', count: 1, damage: 7 });
  assert.equal(back.get(3).count, 5);
  const bad = Inventory.fromJSON([{ id: 'not_real', count: 3 }, { id: 'apple', count: -2 }, { id: 'apple', count: 'x' }, { id: 'dirt', count: 999 }], 4);
  assert.equal(bad.get(0), null);
  assert.equal(bad.get(1), null);
  assert.equal(bad.get(2), null);
  assert.equal(bad.get(3).count, 64);
});

test('logs craft into planks, planks into sticks (tag ingredients)', () => {
  const inv = new Inventory(9);
  inv.add({ id: 'birch_log', count: 2 });
  assert.ok(craft(inv, R('birch_planks'), 2).ok);
  assert.equal(inv.count('birch_planks'), 8);
  assert.equal(inv.count('birch_log'), 0);
  assert.ok(craft(inv, R('stick')).ok);
  assert.equal(inv.count('stick'), 4);
  assert.equal(inv.count('birch_planks'), 6);
});

test('crafting without ingredients consumes nothing', () => {
  const inv = new Inventory(9);
  inv.add({ id: 'cobblestone', count: 2 });
  inv.add({ id: 'stick', count: 2 });
  const before = JSON.stringify(inv);
  const res = craft(inv, R('stone_pickaxe'));
  assert.equal(res.ok, false);
  assert.equal(JSON.stringify(inv), before);
  const status = ingredientStatus(inv, R('stone_pickaxe'));
  assert.deepEqual(status.map((s) => s.ok), [false, true]);
});

test('crafting fails transactionally when output does not fit', () => {
  const inv = new Inventory(1);
  inv.set(0, { id: 'oak_log', count: 64 });
  // 1 log -> 4 planks needs a free slot after consuming only one log.
  const res = craft(inv, R('oak_planks'));
  assert.equal(res.ok, false);
  assert.equal(inv.get(0).count, 64);
});

test('maxCraftable and recipe station filtering', () => {
  const inv = new Inventory(9);
  inv.add({ id: 'oak_planks', count: 9 });
  assert.equal(maxCraftable(inv, R('stick')), 4);
  assert.ok(!recipesFor('hand').some((r) => r.station === 'workbench'));
  assert.ok(recipesFor('workbench').some((r) => r.out.id === 'iron_pickaxe'));
});

test('furnace smelts with fuel and stops without it', () => {
  const st = newFurnaceState();
  st.slots[0] = { id: 'raw_iron', count: 3 };
  st.slots[1] = { id: 'oak_planks', count: 1 }; // 15 s of fuel -> 2 items at 6 s each
  for (let i = 0; i < 200; i++) tickFurnace(st, 0.1);
  assert.equal(st.slots[2].id, 'iron_ingot');
  assert.equal(st.slots[2].count, 2);
  assert.equal(st.slots[0].count, 1);
  assert.equal(st.slots[1], null);
});

test('tool effectiveness: correct tool is faster; wrong tier gives no drops', () => {
  const hand = breakTime(B.stone, null);
  const wood = breakTime(B.stone, 'wood_pickaxe');
  const iron = breakTime(B.stone, 'iron_pickaxe');
  assert.ok(hand > wood && wood > iron);
  assert.equal(canHarvest(B.stone, null), false);
  assert.deepEqual(blockDrops(B.stone, 0, null), []);
  assert.deepEqual(blockDrops(B.stone, 0, 'wood_pickaxe'), [{ id: 'cobblestone', count: 1 }]);
  assert.equal(canHarvest(B.iron_ore, 'wood_pickaxe'), false);
  assert.equal(canHarvest(B.iron_ore, 'stone_pickaxe'), true);
  assert.equal(canHarvest(B.starstone_ore, 'stone_pickaxe'), false);
  assert.equal(breakTime(B.bedrock, 'starstone_pickaxe'), Infinity);
  assert.equal(breakTime(B.stone, null, { creative: true }), 0);
  assert.ok(breakTime(B.oak_log, 'iron_axe') < breakTime(B.oak_log, null));
});

test('block drops follow the registry rules', () => {
  assert.deepEqual(blockDrops(B.grass, 0, null), [{ id: 'dirt', count: 1 }]);
  assert.deepEqual(blockDrops(B.oak_log, 0, null), [{ id: 'oak_log', count: 1 }]);
  assert.deepEqual(blockDrops(B.glass, 0, null), []);
  const gravel = blockDrops(B.gravel, 0, 'wood_shovel', () => 0.5);
  assert.deepEqual(gravel, [{ id: 'gravel', count: 1 }]);
  assert.deepEqual(blockDrops(B.gravel, 0, null, () => 0.01), [{ id: 'flint', count: 1 }]);
  assert.deepEqual(blockDrops(B.wheat, 7, null, () => 0), [{ id: 'wheat', count: 1 }, { id: 'wheat_seeds', count: 1 }]);
  assert.deepEqual(blockDrops(B.wheat, 2, null, () => 0), [{ id: 'wheat_seeds', count: 1 }]);
});

test('items: every recipe and loot reference resolves; placement mapping', () => {
  assert.equal(placedBlock('wheat_seeds'), B.wheat);
  assert.equal(placedBlock('stone'), B.stone);
  assert.equal(placedBlock('stick'), null);
  for (let t = 1; t <= 5; t++) {
    const loot = rollLoot(t, 1234 + t, isValidItem);
    assert.equal(loot.length, 27);
    assert.ok(loot.some(Boolean), `table ${t} rolls items`);
    for (const s of loot) if (s) assert.ok(ITEMS[s.id], s.id);
  }
  assert.deepEqual(rollLoot(5, 99, isValidItem), rollLoot(5, 99, isValidItem));
});
