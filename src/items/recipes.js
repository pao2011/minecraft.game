// Data-driven crafting and smelting. Crafting is transactional: it is simulated on a copy of
// the inventory and only committed when every ingredient is present and the output fits.
import { Inventory } from './inventory.js';
import { ITEMS, TIERS, ARMOR_SETS, ARMOR_SLOTS } from './items.js';

export const TAGS = {
  planks: ['oak_planks', 'pine_planks', 'birch_planks', 'dark_planks', 'cherry_planks'],
  logs: ['oak_log', 'pine_log', 'birch_log', 'dark_log', 'cherry_log'],
  stone_like: ['cobblestone'],
  fuel_coal: ['coal', 'charcoal'],
};

export const RECIPES = [];
let nextId = 0;
function recipe(out, count, ingredients, station = 'hand', category = 'basics') {
  RECIPES.push({
    id: `r${nextId++}_${out}`,
    out: { id: out, count },
    in: Object.entries(ingredients).map(([k, n]) => (k.startsWith('#') ? { tag: k.slice(1), count: n } : { id: k, count: n })),
    station,
    category,
  });
}

// Basics (no station).
for (const w of ['oak', 'pine', 'birch', 'dark', 'cherry']) recipe(`${w}_planks`, 4, { [`${w}_log`]: 1 }, 'hand', 'basics');
recipe('stick', 4, { '#planks': 2 });
recipe('workbench', 1, { '#planks': 4 });
recipe('torch', 4, { '#fuel_coal': 1, stick: 1 });

// Workbench: tools.
const toolHeads = { wood: '#planks', stone: 'cobblestone', copper: 'copper_ingot', iron: 'iron_ingot', gold: 'gold_ingot', starstone: 'starstone', crystal: 'azure_crystal', abyssal: 'abyssal_ingot' };
const toolCost = { pickaxe: [3, 2], axe: [3, 2], shovel: [1, 2], sword: [2, 1], hoe: [2, 2] };
for (const tier of Object.keys(TIERS)) {
  for (const [type, [heads, sticks]] of Object.entries(toolCost)) {
    recipe(`${tier}_${type}`, 1, { [toolHeads[tier]]: heads, stick: sticks }, 'workbench', 'tools');
  }
}
const armorCost = [5, 8, 7, 4];
for (const [set, def] of Object.entries(ARMOR_SETS)) {
  ARMOR_SLOTS.forEach((slot, i) => recipe(`${set}_${slot}`, 1, { [def.material]: armorCost[i] }, 'workbench', 'armor'));
}

// Workbench: building and functional blocks.
recipe('chest', 1, { '#planks': 8 }, 'workbench', 'functional');
recipe('furnace', 1, { cobblestone: 8 }, 'workbench', 'functional');
recipe('door', 3, { '#planks': 6 }, 'workbench', 'building');
recipe('trapdoor', 2, { '#planks': 6 }, 'workbench', 'building');
recipe('fence', 3, { '#planks': 4, stick: 2 }, 'workbench', 'building');
recipe('ladder', 3, { stick: 7 }, 'workbench', 'building');
recipe('plank_slab', 6, { oak_planks: 3 }, 'workbench', 'building');
recipe('plank_stairs', 4, { oak_planks: 6 }, 'workbench', 'building');
recipe('stone_bricks', 4, { stone: 4 }, 'workbench', 'building');
recipe('stone_slab', 6, { stone_bricks: 3 }, 'workbench', 'building');
recipe('stone_stairs', 4, { cobblestone: 6 }, 'workbench', 'building');
recipe('chiseled_stone', 1, { stone_slab: 2 }, 'workbench', 'building');
recipe('bricks', 1, { brick: 4 }, 'workbench', 'building');
recipe('sandstone', 1, { sand: 4 }, 'workbench', 'building');
recipe('glass_pane', 16, { glass: 6 }, 'workbench', 'building');
recipe('clay', 1, { clay_ball: 4 }, 'workbench', 'building');
recipe('wool', 1, { string: 4 }, 'workbench', 'building');
recipe('bed', 1, { wool: 3, '#planks': 3 }, 'workbench', 'functional');
recipe('lantern', 1, { iron_ingot: 1, torch: 1 }, 'workbench', 'functional');
recipe('crystal_lamp', 1, { azure_crystal: 4, glass: 1 }, 'workbench', 'functional');
recipe('crystal_block', 1, { azure_crystal: 4 }, 'workbench', 'building');
recipe('bookshelf', 1, { '#planks': 6, wheat: 3 }, 'workbench', 'building');
recipe('hay', 1, { wheat: 9 }, 'workbench', 'building');
recipe('wheat', 9, { hay: 1 }, 'workbench', 'basics');
recipe('iron_block', 1, { iron_ingot: 9 }, 'workbench', 'building');
recipe('iron_ingot', 9, { iron_block: 1 }, 'workbench', 'basics');
recipe('gold_block', 1, { gold_ingot: 9 }, 'workbench', 'building');
recipe('gold_ingot', 9, { gold_block: 1 }, 'workbench', 'basics');
recipe('bucket', 1, { iron_ingot: 3 }, 'workbench', 'tools');
recipe('bread', 1, { wheat: 3 }, 'workbench', 'food');
recipe('bone_meal', 3, { bone: 1 }, 'hand', 'basics');
recipe('mossy_cobblestone', 1, { cobblestone: 1, oak_leaves: 1 }, 'workbench', 'building');

// Minerals: storage blocks and conversions.
for (const [blk, item] of [['coal_block', 'coal'], ['copper_block', 'copper_ingot'], ['tidestone_block', 'tidestone'], ['verdant_block', 'verdant_gem'], ['ember_block', 'ember_dust'], ['starstone_block', 'starstone'], ['abyssal_block', 'abyssal_ingot']]) {
  recipe(blk, 1, { [item]: 9 }, 'workbench', 'building');
  recipe(item, 9, { [blk]: 1 }, 'workbench', 'basics');
}
recipe('abyssal_ingot', 1, { abyssal_scrap: 4, gold_ingot: 4 }, 'workbench', 'basics');
recipe('quartz_block', 1, { quartz: 4 }, 'workbench', 'building');
recipe('quartz_pillar', 2, { quartz_block: 2 }, 'workbench', 'building');
recipe('cinder_bricks', 1, { cinder_brick: 4 }, 'workbench', 'building');
recipe('ember_powder', 2, { ember_rod: 1 });
recipe('void_eye', 1, { void_pearl: 1, ember_powder: 1 }, 'workbench', 'tools');
recipe('blast_charge', 1, { blast_powder: 5, sand: 4 }, 'workbench', 'functional');
recipe('cobweb', 1, { string: 5 }, 'workbench', 'building');
// Gear and food.
recipe('bow', 1, { stick: 3, string: 3 }, 'workbench', 'tools');
recipe('arrow', 4, { flint: 1, stick: 1, feather: 1 }, 'workbench', 'tools');
recipe('shield', 1, { '#planks': 6, iron_ingot: 1 }, 'workbench', 'armor');
recipe('shears', 1, { iron_ingot: 2 }, 'workbench', 'tools');
recipe('flint_and_steel', 1, { iron_ingot: 1, flint: 1 }, 'workbench', 'tools');
recipe('fishing_rod', 1, { stick: 3, string: 2 }, 'workbench', 'tools');
recipe('compass', 1, { iron_ingot: 4, ember_dust: 1 }, 'workbench', 'tools');
recipe('clock', 1, { gold_ingot: 4, ember_dust: 1 }, 'workbench', 'tools');
recipe('bowl', 4, { '#planks': 3 }, 'hand', 'basics');
recipe('glowcap_stew', 1, { glowcap: 2, bowl: 1 }, 'workbench', 'food');
recipe('golden_apple', 1, { apple: 1, gold_ingot: 8 }, 'workbench', 'food');
recipe('golden_carrot', 1, { carrot: 1, gold_ingot: 8 }, 'workbench', 'food');

export const SMELTING = {
  raw_copper: 'copper_ingot',
  raw_iron: 'iron_ingot',
  raw_gold: 'gold_ingot',
  sand: 'glass',
  cobblestone: 'stone',
  stone: 'smooth_stone',
  clay_ball: 'brick',
  oak_log: 'charcoal',
  pine_log: 'charcoal',
  birch_log: 'charcoal',
  dark_log: 'charcoal',
  cherry_log: 'charcoal',
  raw_steak: 'cooked_steak',
  raw_ham: 'cooked_ham',
  raw_fowl: 'roast_fowl',
  raw_mutton: 'cooked_mutton',
  raw_fish: 'cooked_fish',
  raw_hare: 'cooked_hare',
  potato: 'baked_potato',
  cinderrock: 'cinder_brick',
};
export const SMELT_TIME = 6; // seconds per item

for (const r of RECIPES) {
  if (!ITEMS[r.out.id]) throw new Error(`Recipe output ${r.out.id} is not an item`);
  for (const ing of r.in) if (ing.id && !ITEMS[ing.id]) throw new Error(`Recipe ingredient ${ing.id} is not an item`);
}

/** Which recipes are usable at a station ('hand' recipes are usable everywhere). */
export const recipesFor = (station) => RECIPES.filter((r) => r.station === 'hand' || r.station === station);

/** Available vs required counts per ingredient, for UI display. */
export function ingredientStatus(inv, r, times = 1) {
  return r.in.map((ing) => {
    const ids = ing.tag ? TAGS[ing.tag] : [ing.id];
    const have = ids.reduce((n, id) => n + inv.count(id), 0);
    return { ...ing, need: ing.count * times, have, ok: have >= ing.count * times, ids };
  });
}

/** How many times the recipe can currently be crafted (ignoring output space). */
export function maxCraftable(inv, r) {
  let n = Infinity;
  for (const s of ingredientStatus(inv, r)) n = Math.min(n, Math.floor(s.have / s.count));
  return n === Infinity ? 0 : n;
}

/**
 * Craft `times` times. Returns {ok, reason} and only mutates inv on success.
 */
export function craft(inv, r, times = 1) {
  if (!r || !RECIPES.includes(r)) return { ok: false, reason: 'Unknown recipe' };
  if (!(times >= 1)) return { ok: false, reason: 'Nothing to craft' };
  const missing = ingredientStatus(inv, r, times).filter((s) => !s.ok);
  if (missing.length) return { ok: false, reason: 'Missing ingredients', missing };
  const sim = new Inventory(inv.size);
  sim.restore(inv.slots);
  for (const ing of r.in) {
    let need = ing.count * times;
    for (const id of ing.tag ? TAGS[ing.tag] : [ing.id]) {
      if (need <= 0) break;
      need -= sim.remove(id, need);
    }
    if (need > 0) return { ok: false, reason: 'Missing ingredients' };
  }
  const left = sim.add({ id: r.out.id, count: r.out.count * times });
  if (left > 0) return { ok: false, reason: 'Inventory full' };
  inv.restore(sim.slots);
  return { ok: true };
}

// ---- Furnace -----------------------------------------------------------------------------

export const newFurnaceState = () => ({ type: 'furnace', slots: [null, null, null], burn: 0, burnMax: 0, progress: 0 });
export const fuelValue = (id) => ITEMS[id]?.fuel || 0;

/** Advance a furnace by dt seconds. slots: [input, fuel, output]. Returns true while lit. */
export function tickFurnace(st, dt) {
  const [input, , output] = st.slots;
  const result = input ? SMELTING[input.id] : null;
  const outputOk = result && (!output || (output.id === result && output.count < (ITEMS[result].stack || 64)));
  let remaining = dt;
  while (remaining > 0) {
    if (st.burn <= 0) {
      const fuel = st.slots[1];
      if (!outputOk || !fuel || !fuelValue(fuel.id)) {
        st.progress = Math.max(0, st.progress - remaining * 2);
        return false;
      }
      st.burn = st.burnMax = fuelValue(fuel.id);
      fuel.count -= 1;
      if (fuel.count <= 0) st.slots[1] = null;
    }
    const step = Math.min(remaining, st.burn);
    st.burn -= step;
    remaining -= step;
    if (!(st.slots[0] && SMELTING[st.slots[0].id]) || !canOutput(st)) continue;
    st.progress += step;
    if (st.progress >= SMELT_TIME) {
      st.progress -= SMELT_TIME;
      const res = SMELTING[st.slots[0].id];
      st.slots[0].count -= 1;
      if (st.slots[0].count <= 0) st.slots[0] = null;
      if (st.slots[2]) st.slots[2].count += 1;
      else st.slots[2] = { id: res, count: 1 };
      if (!canOutput(st)) st.progress = 0;
    }
  }
  return st.burn > 0;
}

function canOutput(st) {
  const input = st.slots[0];
  if (!input) return false;
  const res = SMELTING[input.id];
  if (!res) return false;
  const out = st.slots[2];
  return !out || (out.id === res && out.count < (ITEMS[res].stack || 64));
}
