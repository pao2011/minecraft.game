// Item registry. Item stacks store the string key (stable across versions) plus count and,
// for tools/armor, accumulated damage: { id: 'stone_pickaxe', count: 1, damage: 12 }.
import { BLOCKS, B } from '../world/blocks.js';

export const ITEMS = {};

// Tool tiers: harvest level, speed multiplier, durability, base melee damage.
export const TIERS = {
  wood: { name: 'Wooden', level: 1, speed: 2, durability: 60, damage: 4, color: [150, 112, 66] },
  stone: { name: 'Stone', level: 2, speed: 4, durability: 132, damage: 5, color: [128, 128, 132] },
  copper: { name: 'Copper', level: 2, speed: 5, durability: 190, damage: 5.5, color: [214, 124, 74] },
  iron: { name: 'Iron', level: 3, speed: 6, durability: 250, damage: 6, color: [222, 222, 228] },
  gold: { name: 'Golden', level: 1, speed: 12, durability: 40, damage: 4, color: [250, 214, 60] },
  starstone: { name: 'Starstone', level: 4, speed: 8, durability: 1561, damage: 7, color: [196, 170, 255] },
};

const TOOL_TYPES = {
  pickaxe: { name: 'Pickaxe', damage: -2, cost: 3 },
  axe: { name: 'Axe', damage: -0.5, cost: 3 },
  shovel: { name: 'Shovel', damage: -2.5, cost: 1 },
  sword: { name: 'Blade', damage: 0, cost: 2 },
  hoe: { name: 'Hoe', damage: -3, cost: 2 },
};

export const ARMOR_SETS = {
  hide: { name: 'Hide', points: [1, 3, 2, 1], durability: 6, material: 'hide', color: [140, 92, 56] },
  copper: { name: 'Copper', points: [2, 4, 3, 1], durability: 10, material: 'copper_ingot', color: [214, 124, 74] },
  iron: { name: 'Iron', points: [2, 6, 5, 2], durability: 15, material: 'iron_ingot', color: [222, 222, 228] },
  starstone: { name: 'Starstone', points: [3, 8, 6, 3], durability: 33, material: 'starstone', color: [196, 170, 255] },
};
export const ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];
const ARMOR_NAMES = { helmet: 'Cap', chestplate: 'Vest', leggings: 'Greaves', boots: 'Boots' };
const ARMOR_DURA_MULT = [11, 16, 15, 13];

function reg(key, props) {
  ITEMS[key] = { key, stack: 64, kind: 'material', ...props };
  return ITEMS[key];
}

// Every placeable block is also an item with the same key.
for (const d of BLOCKS) {
  if (!d || d.id === 0 || d.fluid || d.crop) continue;
  reg(d.key, { name: d.name, kind: 'block', block: d.id, category: d.category });
}

const mat = (key, name, extra = {}) => reg(key, { name, kind: 'material', ...extra });
mat('stick', 'Stick', { fuel: 5 });
mat('coal', 'Coal', { fuel: 80 });
mat('charcoal', 'Charcoal', { fuel: 80 });
mat('raw_copper', 'Raw Copper');
mat('copper_ingot', 'Copper Ingot');
mat('raw_iron', 'Raw Iron');
mat('iron_ingot', 'Iron Ingot');
mat('raw_gold', 'Raw Gold');
mat('gold_ingot', 'Gold Ingot');
mat('ember_dust', 'Ember Dust');
mat('azure_crystal', 'Azure Crystal');
mat('starstone', 'Starstone Gem');
mat('flint', 'Flint');
mat('clay_ball', 'Clay Lump');
mat('brick', 'Fired Brick');
mat('hide', 'Hide');
mat('feather', 'Feather');
mat('string', 'Silk Thread');
mat('bone', 'Bone');
mat('bone_meal', 'Bone Meal', { use: 'fertilize' });
mat('wheat', 'Wheat');
reg('wheat_seeds', { name: 'Wheat Seeds', kind: 'seed', plants: B.wheat });
reg('bucket', { name: 'Bucket', kind: 'tool', stack: 16, use: 'bucket' });
reg('water_bucket', { name: 'Water Bucket', kind: 'tool', stack: 1, use: 'water_bucket' });

const food = (key, name, hunger, saturation, extra = {}) => reg(key, { name, kind: 'food', food: { hunger, saturation }, ...extra });
food('apple', 'Apple', 4, 2.4);
food('bread', 'Bread', 5, 6);
food('carrot', 'Carrot', 3, 3.6, { plants: B.carrots });
food('raw_steak', 'Raw Grazer Steak', 3, 1.8);
food('cooked_steak', 'Seared Steak', 8, 12.8);
food('raw_ham', 'Raw Snout Ham', 3, 1.8);
food('cooked_ham', 'Roast Ham', 8, 12.8);
food('raw_fowl', 'Raw Cluck Fowl', 2, 1.2);
food('roast_fowl', 'Roast Fowl', 6, 7.2);
food('raw_mutton', 'Raw Mutton', 2, 1.2);
food('cooked_mutton', 'Cooked Mutton', 6, 9.6);
food('spoiled_meat', 'Spoiled Meat', 3, 0.6);

for (const [tierKey, tier] of Object.entries(TIERS)) {
  for (const [type, t] of Object.entries(TOOL_TYPES)) {
    reg(`${tierKey}_${type}`, {
      name: `${tier.name} ${t.name}`,
      kind: 'tool',
      stack: 1,
      tool: { type, tier: tierKey, level: tier.level, speed: tier.speed, durability: tier.durability, damage: Math.max(1, tier.damage + t.damage) },
      fuel: tierKey === 'wood' ? 10 : 0,
    });
  }
}

for (const [setKey, set] of Object.entries(ARMOR_SETS)) {
  ARMOR_SLOTS.forEach((slot, i) => {
    reg(`${setKey}_${slot}`, {
      name: `${set.name} ${ARMOR_NAMES[slot]}`,
      kind: 'armor',
      stack: 1,
      armor: { slot, slotIndex: i, points: set.points[i], durability: set.durability * ARMOR_DURA_MULT[i], set: setKey },
    });
  });
}

// Wooden blocks burn in the furnace.
for (const k of ['oak_log', 'pine_log', 'birch_log', 'dark_log']) ITEMS[k].fuel = 15;
for (const k of ['oak_planks', 'pine_planks', 'birch_planks', 'dark_planks', 'workbench', 'chest', 'fence', 'plank_slab', 'plank_stairs', 'ladder', 'bookshelf']) ITEMS[k].fuel = 15;
for (const k of ['oak_sapling', 'pine_sapling', 'birch_sapling', 'dark_sapling']) ITEMS[k].fuel = 5;

export const getItem = (key) => ITEMS[key] || null;
export const isValidItem = (key) => typeof key === 'string' && key in ITEMS;
export const maxStack = (key) => ITEMS[key]?.stack ?? 64;
export const maxDurability = (key) => ITEMS[key]?.tool?.durability ?? ITEMS[key]?.armor?.durability ?? 0;

/** Seconds needed to break a block with the given held item (Infinity = unbreakable). */
export function breakTime(blockId, heldKey, { creative = false, inWater = false, onGround = true } = {}) {
  const d = BLOCKS[blockId];
  if (!d || d.hardness < 0) return Infinity;
  if (creative) return 0;
  if (d.hardness === 0) return 0.05;
  const tool = ITEMS[heldKey]?.tool;
  const matching = tool && d.tool && tool.type === d.tool;
  const canHarvest = d.toolLevel === 0 || (matching && tool.level >= d.toolLevel);
  let speed = matching ? tool.speed : 1;
  if (tool?.type === 'sword' && (d.leaves || d.key === 'cactus')) speed = 1.5;
  let t = (d.hardness * (canHarvest ? 1.5 : 5)) / speed;
  if (inWater) t *= 5;
  if (!onGround) t *= 5;
  return t;
}

/** Whether breaking the block with this item yields drops. */
export function canHarvest(blockId, heldKey) {
  const d = BLOCKS[blockId];
  if (!d) return false;
  if (d.toolLevel === 0) return true;
  const tool = ITEMS[heldKey]?.tool;
  return !!(tool && tool.type === d.tool && tool.level >= d.toolLevel);
}

/** Drops for a broken block as item stacks. rng in [0,1). */
export function blockDrops(blockId, meta, heldKey, rng = Math.random) {
  const d = BLOCKS[blockId];
  if (!d || !canHarvest(blockId, heldKey)) return [];
  if (d.crop) {
    const ripe = (meta & 7) === 7;
    const out = [];
    if (ripe) out.push({ id: d.crop.item, count: d.crop.item === 'carrot' ? 2 + Math.floor(rng() * 3) : 1 });
    out.push({ id: d.crop.seed, count: ripe && d.crop.seed !== 'carrot' ? 1 + Math.floor(rng() * 3) : 1 });
    return out;
  }
  // Leaves cut with a hoe (shears stand-in) drop themselves.
  if (d.leaves && ITEMS[heldKey]?.tool?.type === 'hoe') return [{ id: d.key, count: 1 }];
  if (!d.drops) return ITEMS[d.key] ? [{ id: d.key, count: 1 }] : [];
  const out = [];
  for (const drop of d.drops) {
    if (drop.chance !== undefined && rng() >= drop.chance) continue;
    const [lo, hi] = drop.count || [1, 1];
    const count = lo + Math.floor(rng() * (hi - lo + 1));
    if (count > 0) out.push({ id: drop.item, count });
    if (d.exclusiveDrops) break;
  }
  return out;
}

/** Block placed by an item, if any. */
export function placedBlock(key) {
  const it = ITEMS[key];
  if (!it) return null;
  if (it.block !== undefined) return it.block;
  if (it.plants !== undefined) return it.plants;
  return null;
}
