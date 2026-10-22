// Central, data-driven block registry. Numeric IDs are stored in chunk arrays and saves,
// so IDs are append-only: never renumber an existing block. Saves also store a palette
// (see save/serialize.js) so a future reorder can be remapped.
import { TILE } from './tiles.js';

export const BLOCKS = []; // id -> definition
export const B = {}; // key -> id

// Sound categories double as footstep/mining material groups.
const DEFAULTS = {
  shape: 'cube',
  solid: true,
  render: 'opaque', // opaque | cutout | translucent | none
  lightOpacity: 15,
  emit: 0,
  hardness: 1,
  tool: null,
  toolLevel: 0,
  drops: null, // null = drops itself when harvested correctly
  replaceable: false,
  interact: null,
  sound: 'stone',
  category: 'building',
  fluid: null,
  needsSupport: false,
  climbable: false,
  contactDamage: 0,
  creative: true,
  tint: null, // 'grass' | 'foliage' | 'water' - biome tint applied in the shader
  stackSize: 64,
};

function def(id, key, name, props = {}) {
  if (BLOCKS[id]) throw new Error(`Duplicate block id ${id}`);
  const d = { ...DEFAULTS, ...props, id, key, name };
  if (props.tex === undefined && d.shape !== 'none') d.tex = { all: TILE[key] };
  // Expand texture shorthands to per-face tiles: order +x, -x, +y, -y, +z, -z.
  const t = d.tex || {};
  const side = t.side ?? t.all;
  d.faces = [side, side, t.top ?? t.end ?? t.all, t.bottom ?? t.end ?? t.all, side, side];
  if (t.front !== undefined) d.frontTile = t.front;
  for (const f of d.faces) if (d.shape !== 'none' && f === undefined) throw new Error(`Missing tile for ${key}`);
  d.opaque = d.shape === 'cube' && d.render === 'opaque';
  BLOCKS[id] = d;
  B[key] = id;
  return d;
}

const T = TILE;
const plant = { shape: 'cross', solid: false, render: 'cutout', lightOpacity: 0, hardness: 0, sound: 'grass', needsSupport: true, category: 'plants' };

def(0, 'air', 'Air', { shape: 'none', solid: false, render: 'none', lightOpacity: 0, hardness: 0, replaceable: true, creative: false });
def(1, 'bedrock', 'Bedrock', { hardness: -1, category: 'natural', creative: true });
def(2, 'stone', 'Stone', { hardness: 1.5, tool: 'pickaxe', toolLevel: 1, drops: [{ item: 'cobblestone' }], category: 'natural' });
def(3, 'cobblestone', 'Cobblestone', { hardness: 2, tool: 'pickaxe', toolLevel: 1 });
def(4, 'dirt', 'Dirt', { hardness: 0.5, tool: 'shovel', sound: 'gravel', category: 'natural' });
def(5, 'grass', 'Turf Block', { hardness: 0.6, tool: 'shovel', sound: 'grass', tex: { top: T.grass_top, bottom: T.dirt, side: T.grass_side }, drops: [{ item: 'dirt' }], tint: 'grass', category: 'natural' });
def(6, 'coarse_dirt', 'Coarse Dirt', { hardness: 0.5, tool: 'shovel', sound: 'gravel', category: 'natural' });
def(7, 'sand', 'Sand', { hardness: 0.5, tool: 'shovel', sound: 'sand', category: 'natural' });
def(8, 'sandstone', 'Sandstone', { hardness: 0.8, tool: 'pickaxe', toolLevel: 1, tex: { side: T.sandstone_side, end: T.sandstone_top }, category: 'natural' });
def(9, 'gravel', 'Gravel', {
  hardness: 0.6, tool: 'shovel', sound: 'gravel', category: 'natural',
  drops: [{ item: 'flint', chance: 0.12 }, { item: 'gravel' }], exclusiveDrops: true,
});
def(10, 'clay', 'Clay', { hardness: 0.6, tool: 'shovel', sound: 'gravel', drops: [{ item: 'clay_ball', count: [4, 4] }], category: 'natural' });
def(11, 'snow', 'Snow Block', { hardness: 0.2, tool: 'shovel', sound: 'snow', category: 'natural' });
def(12, 'ice', 'Ice', { hardness: 0.5, tool: 'pickaxe', render: 'translucent', lightOpacity: 1, sound: 'glass', drops: [], category: 'natural' });
def(13, 'water', 'Water', { shape: 'liquid', solid: false, render: 'translucent', lightOpacity: 2, hardness: -1, replaceable: true, fluid: 'water', sound: 'liquid', drops: [], tint: 'water', creative: false });
def(14, 'lava', 'Lava', { shape: 'liquid', solid: false, render: 'opaque', lightOpacity: 15, emit: 15, hardness: -1, replaceable: true, fluid: 'lava', sound: 'liquid', drops: [], contactDamage: 4, creative: false });

const woods = [
  [15, 'oak', 'Oakwood'], [16, 'pine', 'Pinewood'], [17, 'birch', 'Paperbark'], [18, 'dark', 'Duskwood'],
];
for (const [id, w, label] of woods) {
  def(id, `${w}_log`, `${label} Log`, { hardness: 2, tool: 'axe', sound: 'wood', tex: { side: T[`${w}_log`], end: T[`${w}_log_top`] }, axis: true, category: 'wood' });
  def(id + 4, `${w}_planks`, `${label} Planks`, { hardness: 2, tool: 'axe', sound: 'wood', category: 'wood' });
  def(id + 8, `${w}_leaves`, `${label} Leaves`, {
    render: 'cutout', lightOpacity: 1, hardness: 0.2, tool: 'hoe', sound: 'grass', tint: w === 'pine' || w === 'birch' ? null : 'foliage', category: 'plants',
    drops: [{ item: `${w}_sapling`, chance: 0.06 }, ...(w === 'oak' ? [{ item: 'apple', chance: 0.02 }] : [])], leaves: true,
  });
  def(id + 12, `${w}_sapling`, `${label} Sapling`, { ...plant, sapling: w });
}
// ids 15..30 used above (logs 15-18, planks 19-22, leaves 23-26, saplings 27-30)

def(31, 'tall_grass', 'Wild Grass', { ...plant, replaceable: true, tint: 'grass', drops: [{ item: 'wheat_seeds', chance: 0.125 }, { item: 'carrot', chance: 0.03 }] });
def(32, 'flower_red', 'Emberbloom', { ...plant });
def(33, 'flower_yellow', 'Sunbutton', { ...plant });
def(34, 'flower_blue', 'Frostbell', { ...plant });
def(35, 'dead_bush', 'Dry Bramble', { ...plant, replaceable: true, drops: [{ item: 'stick', count: [0, 2] }] });
def(36, 'cactus', 'Cactus', { shape: 'cactus', render: 'cutout', lightOpacity: 0, hardness: 0.4, sound: 'wool', tex: { side: T.cactus_side, end: T.cactus_top }, contactDamage: 1, needsSupport: true, category: 'plants' });
def(37, 'snow_grass', 'Frosted Turf', { hardness: 0.6, tool: 'shovel', sound: 'snow', tex: { top: T.snow_grass_top, bottom: T.dirt, side: T.snow_grass_side }, drops: [{ item: 'dirt' }], category: 'natural' });
def(38, 'stone_bricks', 'Stone Bricks', { hardness: 1.5, tool: 'pickaxe', toolLevel: 1 });
def(39, 'bricks', 'Clay Bricks', { hardness: 2, tool: 'pickaxe', toolLevel: 1 });
def(40, 'glass', 'Glass', { render: 'cutout', lightOpacity: 0, hardness: 0.3, sound: 'glass', drops: [], cullSame: true });
def(41, 'glass_pane', 'Glass Pane', { shape: 'pane', render: 'cutout', lightOpacity: 0, hardness: 0.3, sound: 'glass', tex: { all: T.glass, top: T.pane_top, bottom: T.pane_top }, drops: [] });
def(42, 'plank_slab', 'Oakwood Slab', { shape: 'slab', lightOpacity: 0, hardness: 2, tool: 'axe', sound: 'wood', tex: { all: T.oak_planks } });
def(43, 'stone_slab', 'Stone Slab', { shape: 'slab', lightOpacity: 0, hardness: 2, tool: 'pickaxe', toolLevel: 1, tex: { all: T.stone_bricks } });
def(44, 'plank_stairs', 'Oakwood Stairs', { shape: 'stairs', lightOpacity: 0, hardness: 2, tool: 'axe', sound: 'wood', tex: { all: T.oak_planks } });
def(45, 'stone_stairs', 'Cobblestone Stairs', { shape: 'stairs', lightOpacity: 0, hardness: 2, tool: 'pickaxe', toolLevel: 1, tex: { all: T.cobblestone } });
def(46, 'fence', 'Oakwood Fence', { shape: 'fence', render: 'opaque', lightOpacity: 0, hardness: 2, tool: 'axe', sound: 'wood', tex: { all: T.oak_planks, top: T.fence_post, bottom: T.fence_post } });
def(47, 'door', 'Oakwood Door', { shape: 'door', render: 'cutout', lightOpacity: 0, hardness: 3, tool: 'axe', sound: 'wood', tex: { all: T.door_bottom }, interact: 'door', drops: [{ item: 'door' }] });
def(48, 'trapdoor', 'Oakwood Hatch', { shape: 'trapdoor', render: 'cutout', lightOpacity: 0, hardness: 3, tool: 'axe', sound: 'wood', interact: 'trapdoor' });
def(49, 'torch', 'Torch', { shape: 'torch', solid: false, render: 'cutout', lightOpacity: 0, emit: 14, hardness: 0, sound: 'wood', needsSupport: true, category: 'functional' });
def(50, 'lantern', 'Lantern', { shape: 'lantern', render: 'cutout', lightOpacity: 0, emit: 15, hardness: 1, tool: 'pickaxe', sound: 'metal', category: 'functional' });
def(51, 'workbench', 'Workbench', { hardness: 2.5, tool: 'axe', sound: 'wood', tex: { top: T.workbench_top, bottom: T.oak_planks, side: T.workbench_side, front: T.workbench_front }, interact: 'workbench', facing: true, category: 'functional' });
def(52, 'furnace', 'Furnace', { hardness: 3.5, tool: 'pickaxe', toolLevel: 1, tex: { top: T.furnace_top, bottom: T.furnace_top, side: T.furnace_side, front: T.furnace_front }, interact: 'furnace', facing: true, category: 'functional' });
def(53, 'chest', 'Chest', { hardness: 2.5, tool: 'axe', sound: 'wood', tex: { top: T.chest_top, bottom: T.chest_top, side: T.chest_side, front: T.chest_front }, interact: 'chest', facing: true, category: 'functional' });
def(54, 'bed', 'Bedroll', { shape: 'bed', lightOpacity: 0, hardness: 0.2, sound: 'wool', tex: { all: T.bed_side, top: T.bed_foot_top, bottom: T.oak_planks }, interact: 'bed', drops: [{ item: 'bed' }], category: 'functional' });
def(55, 'coal_ore', 'Coal Ore', { hardness: 3, tool: 'pickaxe', toolLevel: 1, drops: [{ item: 'coal' }], category: 'ores' });
def(56, 'copper_ore', 'Copper Ore', { hardness: 3, tool: 'pickaxe', toolLevel: 2, drops: [{ item: 'raw_copper', count: [1, 3] }], category: 'ores' });
def(57, 'iron_ore', 'Iron Ore', { hardness: 3, tool: 'pickaxe', toolLevel: 2, drops: [{ item: 'raw_iron' }], category: 'ores' });
def(58, 'gold_ore', 'Gold Ore', { hardness: 3, tool: 'pickaxe', toolLevel: 3, drops: [{ item: 'raw_gold' }], category: 'ores' });
def(59, 'ember_ore', 'Ember Ore', { hardness: 3, tool: 'pickaxe', toolLevel: 3, emit: 4, drops: [{ item: 'ember_dust', count: [3, 5] }], category: 'ores' });
def(60, 'crystal_ore', 'Azure Crystal Ore', { hardness: 3, tool: 'pickaxe', toolLevel: 3, emit: 3, drops: [{ item: 'azure_crystal', count: [1, 2] }], category: 'ores' });
def(61, 'starstone_ore', 'Starstone Ore', { hardness: 4, tool: 'pickaxe', toolLevel: 3, drops: [{ item: 'starstone' }], category: 'ores' });
def(62, 'farmland', 'Tilled Soil', { shape: 'farmland', lightOpacity: 0, hardness: 0.6, tool: 'shovel', sound: 'gravel', tex: { top: T.farmland, side: T.dirt, bottom: T.dirt }, drops: [{ item: 'dirt' }], category: 'natural' });
def(63, 'wheat', 'Wheat Crop', { ...plant, shape: 'crop', crop: { item: 'wheat', seed: 'wheat_seeds', tiles: [T.wheat_0, T.wheat_1, T.wheat_2, T.wheat_3] }, creative: false, tex: { all: T.wheat_3 } });
def(64, 'carrots', 'Carrot Crop', { ...plant, shape: 'crop', crop: { item: 'carrot', seed: 'carrot', tiles: [T.carrots_0, T.carrots_1, T.carrots_2, T.carrots_3] }, creative: false, tex: { all: T.carrots_3 } });
def(65, 'wool', 'Wool', { hardness: 0.8, sound: 'wool', category: 'decoration' });
def(66, 'mossy_cobblestone', 'Mossy Cobblestone', { hardness: 2, tool: 'pickaxe', toolLevel: 1, category: 'decoration' });
def(67, 'chiseled_stone', 'Chiseled Stone', { hardness: 1.5, tool: 'pickaxe', toolLevel: 1, category: 'decoration' });
def(68, 'smooth_stone', 'Smooth Stone', { hardness: 2, tool: 'pickaxe', toolLevel: 1, category: 'decoration' });
def(69, 'hay', 'Hay Bale', { hardness: 0.5, sound: 'grass', tex: { side: T.hay_side, end: T.hay_top }, category: 'decoration' });
def(70, 'iron_block', 'Block of Iron', { hardness: 5, tool: 'pickaxe', toolLevel: 2, sound: 'metal', category: 'decoration' });
def(71, 'gold_block', 'Block of Gold', { hardness: 3, tool: 'pickaxe', toolLevel: 3, sound: 'metal', category: 'decoration' });
def(72, 'crystal_lamp', 'Crystal Lamp', { hardness: 0.3, emit: 15, sound: 'glass', category: 'functional' });
def(73, 'totem', 'Shadow Totem', { hardness: 5, tool: 'pickaxe', toolLevel: 1, emit: 2, tex: { side: T.totem_side, end: T.totem_top }, drops: [], category: 'functional', spawner: true });
def(74, 'glowcap', 'Glowcap', { ...plant, emit: 9, category: 'plants' });
def(75, 'ladder', 'Ladder', { shape: 'ladder', solid: true, render: 'cutout', lightOpacity: 0, hardness: 0.4, tool: 'axe', sound: 'wood', climbable: true, category: 'functional' });
def(76, 'crystal_block', 'Azure Crystal Block', { hardness: 1.5, tool: 'pickaxe', toolLevel: 1, emit: 6, sound: 'glass', category: 'decoration' });
def(77, 'bookshelf', 'Bookshelf', { hardness: 1.5, tool: 'axe', sound: 'wood', tex: { side: T.bookshelf, end: T.oak_planks }, category: 'decoration' });

export const AIR = 0;

/** Look-up tables for hot loops (mesher, lighting, physics). */
export const OPAQUE = new Uint8Array(256);
export const SOLID = new Uint8Array(256);
export const EMIT = new Uint8Array(256);
export const OPACITY = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  const d = BLOCKS[i];
  OPAQUE[i] = d && d.opaque ? 1 : 0;
  SOLID[i] = d && d.solid ? 1 : 0;
  EMIT[i] = d ? d.emit : 0;
  OPACITY[i] = d ? d.lightOpacity : 0;
}

export const getBlock = (id) => BLOCKS[id] || BLOCKS[0];
export const blockByKey = (key) => (key in B ? BLOCKS[B[key]] : null);
export const isFluid = (id) => !!BLOCKS[id]?.fluid;

/** Facing directions: 0=north(-z) 1=east(+x) 2=south(+z) 3=west(-x). */
export const FACING_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
