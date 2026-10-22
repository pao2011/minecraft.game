// Container loot tables for generated structures. Loot is rolled once, when a chest is first
// opened, from a seed derived from its position, then persisted like any player container.
import { makeRng } from '../util/noise.js';

const TABLES = {
  1: { // abandoned shelter
    rolls: [3, 6],
    items: [['bread', 3, 1, 3], ['apple', 3, 1, 3], ['stick', 2, 2, 6], ['torch', 3, 2, 6], ['wheat_seeds', 2, 2, 5], ['coal', 2, 1, 4], ['stone_pickaxe', 1, 1, 1], ['wool', 1, 1, 3], ['carrot', 2, 1, 3], ['raw_iron', 1, 1, 2]],
  },
  2: { // ruined tower
    rolls: [3, 6],
    items: [['iron_ingot', 3, 1, 4], ['copper_ingot', 3, 2, 6], ['gold_ingot', 1, 1, 3], ['bone', 2, 1, 4], ['iron_sword', 1, 1, 1], ['iron_helmet', 1, 1, 1], ['bread', 2, 1, 3], ['azure_crystal', 1, 1, 2], ['lantern', 1, 1, 2]],
  },
  3: { // campsite
    rolls: [2, 4],
    items: [['cooked_steak', 3, 1, 3], ['torch', 3, 2, 8], ['coal', 2, 2, 5], ['stick', 2, 2, 6], ['raw_fowl', 2, 1, 3], ['wood_axe', 1, 1, 1], ['bucket', 1, 1, 1]],
  },
  4: { // desert shrine
    rolls: [3, 5],
    items: [['gold_ingot', 3, 2, 5], ['ember_dust', 2, 2, 6], ['bone', 2, 1, 5], ['spoiled_meat', 2, 1, 4], ['starstone', 1, 1, 1], ['iron_ingot', 2, 1, 3], ['copper_chestplate', 1, 1, 1]],
  },
  5: { // dungeon
    rolls: [4, 7],
    items: [['iron_ingot', 3, 1, 5], ['gold_ingot', 2, 1, 4], ['starstone', 1, 1, 2], ['bone', 3, 2, 6], ['spoiled_meat', 3, 1, 5], ['bread', 2, 1, 2], ['iron_pickaxe', 1, 1, 1], ['iron_chestplate', 1, 1, 1], ['bone_meal', 2, 2, 6], ['azure_crystal', 2, 1, 3], ['ember_dust', 2, 2, 5]],
  },
};

/** Roll loot for a table id: returns an array of 27 slots (null = empty). */
export function rollLoot(tableId, seed, isValid) {
  const t = TABLES[tableId];
  const slots = new Array(27).fill(null);
  if (!t) return slots;
  const rng = makeRng(seed);
  const entries = t.items.filter(([id, w]) => w > 0 && isValid(id));
  const total = entries.reduce((n, e) => n + e[1], 0);
  const rolls = rng.int(t.rolls[0], t.rolls[1]);
  for (let r = 0; r < rolls; r++) {
    let pick = rng() * total;
    const e = entries.find((x) => (pick -= x[1]) < 0) || entries[0];
    let slot = rng.int(0, 26);
    for (let k = 0; k < 27 && slots[slot]; k++) slot = (slot + 1) % 27;
    slots[slot] = { id: e[0], count: rng.int(e[2], e[3]) };
  }
  return slots;
}
