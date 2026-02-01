export interface Vector2 {
  x: number;
  y: number;
}

export enum EntityType {
  UNIT,
  ZOMBIE,
  BASE,
  HOUSE,
  ENEMY_BASE,
  MINE,
  WALL
}

export interface Entity {
  id: string;
  type: EntityType;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  radius: number;
  ownerId: string; // 'p1', 'p2', 'enemy'
  
  // Dynamic props
  targetId?: string | null;
  attackCooldown?: number;
  lastAttackerId?: string; // Track who last dealt damage (for kill credit)
  
  // Velocity (for animation direction)
  vx?: number;
  vy?: number;
  // Facing direction for sprites (-1 = left, 1 = right)
  facing?: number;
  // Pathfinding
  path?: Vector2[];
  pathIndex?: number;
  pathCooldown?: number;
  
  // Unit specific
  damage?: number;
  range?: number;
  speed?: number;
  unitType?: string; // 'SOLDIER', 'TANK'
}

export interface PlayerState {
  id: string; // 'p1' or 'p2'
  name: string;
  gold: number;
  currentPop: number;
  maxPop: number;
  basePosition: Vector2;
  color: string;
  defeated: boolean;
}

export interface GameState {
  players: Record<string, PlayerState>;
  entities: Entity[];
  lastTick: number;
  gameOver: boolean;
  winner: string | null;
  waveNumber: number;
  playerCount?: number;
}

export interface PeerMessage {
  type: 'SYNC' | 'ACTION';
  payload: any;
}

// Lobby player info (before game starts)
export interface LobbyPlayer {
  id: string;        // 'p1', 'p2', etc.
  peerId: string;    // Network peer ID
  name: string;      // Display name
  color: string;     // Chosen color
  isHost: boolean;
}
