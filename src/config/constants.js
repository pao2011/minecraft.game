// World layout and gameplay balance values. Keep tunables here rather than inside systems.

export const GAME_TITLE = 'Blockwild';
export const GAME_VERSION = '1.0.0';

export const CHUNK_SIZE = 16; // horizontal size of a chunk column (X and Z)
export const SECTION_SIZE = 16; // vertical mesh section height
export const WORLD_HEIGHT = 128; // blocks, y in [0, 127]
export const SECTIONS_PER_CHUNK = WORLD_HEIGHT / SECTION_SIZE;
export const CHUNK_VOLUME = CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT;
export const SEA_LEVEL = 50;
export const LAVA_LEVEL = 10; // carved caves at or below this fill with lava/water
// shortcut: hard world border instead of true infinity; chunk keys and float precision stay safe well inside it.
export const WORLD_BORDER = 16000;

// Bumping GEN_VERSION means seeds produce different terrain; saved chunks are kept as-is.
export const GEN_VERSION = 1;
export const SAVE_VERSION = 2;

export const PLAYER = {
  width: 0.6,
  height: 1.8,
  sneakHeight: 1.5,
  eyeHeight: 1.62,
  sneakEyeHeight: 1.32,
  walkSpeed: 4.3,
  sprintSpeed: 5.8,
  sneakSpeed: 1.6,
  flySpeed: 11,
  flySprintSpeed: 22,
  swimSpeed: 2.6,
  jumpVelocity: 8.4,
  gravity: 28,
  terminalVelocity: 60,
  reach: 5,
  creativeReach: 6,
  maxHealth: 20,
  maxHunger: 20,
};

export const SURVIVAL = {
  // Exhaustion converts into hunger loss at 4.0 per point, like a slow energy budget.
  exhaustionPerHungerPoint: 4,
  exhaustionWalkPerBlock: 0.01,
  exhaustionSprintPerBlock: 0.1,
  exhaustionJump: 0.05,
  exhaustionSprintJump: 0.2,
  exhaustionMine: 0.005,
  exhaustionAttack: 0.1,
  exhaustionRegen: 3,
  regenInterval: 4, // seconds per half-heart while hunger is high
  regenHungerThreshold: 18,
  starveInterval: 4,
  fallDamageThreshold: 3.4, // blocks fallen before damage applies
  drownInterval: 1,
  maxAir: 10, // seconds of breath
  invulnerabilityTime: 0.5,
};

export const DIFFICULTY = {
  peaceful: { id: 'peaceful', label: 'Peaceful', mobDamage: 0, hostileCap: 0, starveFloor: 20, hungerRate: 0, passiveRegen: true },
  easy: { id: 'easy', label: 'Easy', mobDamage: 0.6, hostileCap: 8, starveFloor: 10, hungerRate: 0.7, passiveRegen: false },
  normal: { id: 'normal', label: 'Normal', mobDamage: 1, hostileCap: 14, starveFloor: 1, hungerRate: 1, passiveRegen: false },
  hard: { id: 'hard', label: 'Hard', mobDamage: 1.5, hostileCap: 20, starveFloor: 0, hungerRate: 1.25, passiveRegen: false },
};

export const DAY_LENGTH_OPTIONS = { short: 600, normal: 1200, long: 2400 }; // seconds per full day

export const ENTITY_LIMITS = {
  passiveCap: 16,
  droppedItems: 96,
  itemDespawnSeconds: 300,
  pickupRadius: 1.6,
  mobDespawnDistance: 80,
  mobSimulationDistance: 64,
  projectiles: 32,
};

export const QUALITY_PRESETS = {
  low: { renderDistance: 3, particles: 0.35, clouds: false, fancyLeaves: false, waterAnimation: false, pixelRatio: 0.75 },
  medium: { renderDistance: 5, particles: 0.7, clouds: true, fancyLeaves: true, waterAnimation: true, pixelRatio: 1 },
  high: { renderDistance: 7, particles: 1, clouds: true, fancyLeaves: true, waterAnimation: true, pixelRatio: 1.5 },
};
