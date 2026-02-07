export const TILE_SIZE = 32;
export const MAP_SIZE = 64; // 64x64 grid
export const FPS = 60;

// Game Balance
export const GOLD_GENERATION_INTERVAL = 20000; // 20 seconds
export const PASSIVE_GOLD_AMOUNT = 50;
export const ZOMBIE_BOUNTY = 10;
export const STARTING_GOLD = 100;
export const STARTING_POP_CAP = 5;
export const HOUSE_POP_INCREASE = 5;
export const HOUSE_COST = 50;
export const MINE_COST = 250;
export const MINE_INCOME = 50; // Extra gold per income cycle
export const WALL_COST = 30;
export const FIRE_WALL_COST = 60;
export const FIRE_WALL_DPS = 6;
export const FIRE_WALL_BURN_DURATION = 3; // seconds
export const FIRE_WALL_LIFETIME = 30; // seconds
export const FOG_UNIT_RADIUS = 3; // tiles
export const FOG_BUILDING_RADIUS = 2.5; // tiles
// Visual tweak: pixels to nudge wall bottoms (positive = up). Keep at 0 for exact grid alignment.
export const WALL_BOTTOM_OFFSET = 0;

// Units
export const UNIT_TYPES = {
  SOLDIER: {
    name: 'Soldier',
    cost: 20,
    hp: 50,
    damage: 10,
    speed: 2,
    range: 1.5, // tiles
    color: '#3b82f6', // blue-500
    radius: 0.3,
    popCost: 1
  },
  TANK: {
    name: 'Tank',
    cost: 60,
    hp: 300,
    damage: 25,
    speed: 1,
    range: 1.1,
    color: '#1d4ed8', // blue-700
    radius: 0.5,
    popCost: 2
  }
};

// Building Rules
export const BUILD_RADIUS = 8; // Tiles around base center where you can build

// Colors
export const COLORS = {
  BACKGROUND: '#000000',
  TERRAIN: '#666666',
  BASE_P1: '#3b82f6', // Blue
  BASE_P2: '#ef4444', // Red
  ZOMBIE: '#22c55e', // Green
  ZOMBIE_BASE: '#14532d', // Dark Green
  HOUSE: '#f59e0b', // Amber
  GRID: 'rgba(255, 255, 255, 0.1)',
  SELECTION: 'rgba(255, 255, 255, 0.5)'
};

export const DIFFICULTY_SETTINGS = {
  normal: { health: 1, damage: 1, speed: 1, spawn: 1 },
  elite: { health: 1.25, damage: 1.2, speed: 1.15, spawn: 1.2 },
  legendary: { health: 1.5, damage: 1.35, speed: 1.25, spawn: 1.4 }
};
