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
    radius: 0.3
  },
  TANK: {
    name: 'Tank',
    cost: 60,
    hp: 150,
    damage: 25,
    speed: 1,
    range: 2,
    color: '#1d4ed8', // blue-700
    radius: 0.5
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