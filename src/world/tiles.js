// Ordered list of texture tiles in the block atlas. The index of a name is its atlas slot.
// Painters for each tile live in rendering/textures.js; append new tiles at the end.
export const TILE_NAMES = [
  'grass_top', 'grass_side', 'snow_grass_side', 'dirt', 'coarse_dirt', 'stone', 'cobblestone', 'mossy_cobblestone',
  'sand', 'sandstone_side', 'sandstone_top', 'gravel', 'clay', 'snow', 'ice', 'water',
  'lava', 'bedrock', 'oak_log', 'oak_log_top', 'pine_log', 'pine_log_top', 'birch_log', 'birch_log_top',
  'dark_log', 'dark_log_top', 'oak_planks', 'pine_planks', 'birch_planks', 'dark_planks', 'oak_leaves', 'pine_leaves',
  'birch_leaves', 'dark_leaves', 'oak_sapling', 'pine_sapling', 'birch_sapling', 'dark_sapling', 'tall_grass', 'flower_red',
  'flower_yellow', 'flower_blue', 'dead_bush', 'cactus_side', 'cactus_top', 'glowcap', 'stone_bricks', 'bricks',
  'glass', 'chiseled_stone', 'smooth_stone', 'door_bottom', 'door_top', 'trapdoor', 'ladder', 'torch',
  'lantern', 'workbench_top', 'workbench_side', 'workbench_front', 'furnace_front', 'furnace_front_lit', 'furnace_side', 'furnace_top',
  'chest_front', 'chest_side', 'chest_top', 'bed_head_top', 'bed_foot_top', 'bed_side', 'coal_ore', 'copper_ore',
  'iron_ore', 'gold_ore', 'ember_ore', 'crystal_ore', 'starstone_ore', 'farmland', 'farmland_wet', 'wheat_0',
  'wheat_1', 'wheat_2', 'wheat_3', 'carrots_0', 'carrots_1', 'carrots_2', 'carrots_3', 'wool',
  'hay_side', 'hay_top', 'iron_block', 'gold_block', 'crystal_lamp', 'totem_side', 'totem_top', 'crack_0',
  'crack_1', 'crack_2', 'crack_3', 'crack_4', 'crack_5', 'crack_6', 'crack_7', 'snow_grass_top',
  'crystal_block', 'bookshelf', 'pane_top', 'fence_post',
  'tidestone_ore', 'verdant_ore', 'quartz_ore', 'nether_gold_ore', 'abyssal_ore', 'coal_block', 'copper_block', 'tidestone_block',
  'verdant_block', 'ember_block', 'starstone_block', 'abyssal_block', 'quartz_block', 'quartz_pillar', 'cinderrock', 'lumen_stone',
  'magma', 'cinder_bricks', 'obsidian', 'void_stone', 'frame_top', 'frame_side', 'frame_eye', 'nether_portal',
  'end_portal', 'cobweb', 'potatoes_0', 'potatoes_1', 'potatoes_2', 'potatoes_3', 'void_crystal', 'tnt_side',
  'tnt_top',
];

export const TILE = Object.fromEntries(TILE_NAMES.map((n, i) => [n, i]));
export const ATLAS_COLS = 16;
export const ATLAS_ROWS = 16;
export const TILE_PX = 16;
