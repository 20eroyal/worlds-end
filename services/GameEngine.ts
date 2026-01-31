import { 
  GameState, Entity, EntityType, PlayerState, Vector2, LobbyPlayer 
} from '../types';
import { 
  MAP_SIZE, UNIT_TYPES, ZOMBIE_BOUNTY, BUILD_RADIUS, 
  PASSIVE_GOLD_AMOUNT, COLORS, MINE_COST 
} from '../constants';
import { getDistance } from '../utils/isometric';

// Simple unique ID generator
const generateId = () => Math.random().toString(36).substr(2, 9);

// Player colors for up to 8 players
const PLAYER_COLORS = [
  '#3b82f6', // Blue
  '#ef4444', // Red
  '#22c55e', // Green
  '#f59e0b', // Amber
  '#8b5cf6', // Purple
  '#ec4899', // Pink
  '#06b6d4', // Cyan
  '#f97316', // Orange
];

// Base positions for up to 8 players (spread around the bottom-left area)
const BASE_POSITIONS: Vector2[] = [
  { x: 10, y: 54 },
  { x: 20, y: 44 },
  { x: 8, y: 44 },
  { x: 18, y: 54 },
  { x: 12, y: 48 },
  { x: 22, y: 50 },
  { x: 6, y: 50 },
  { x: 16, y: 42 },
];

export class GameEngine {
  state: GameState;
  playerCount: number;
  lobbyPlayers: LobbyPlayer[];
  
  constructor(initialState?: GameState, playerCount: number = 1, lobbyPlayers?: LobbyPlayer[]) {
    this.playerCount = playerCount;
    this.lobbyPlayers = lobbyPlayers || [];
    if (initialState) {
      this.state = initialState;
    } else {
      this.state = this.createInitialState(playerCount, lobbyPlayers);
    }
  }

  createInitialState(playerCount: number = 1, lobbyPlayers?: LobbyPlayer[]): GameState {
    const enemyBasePos = { x: 54, y: 10 }; 
    
    // Create players and their bases dynamically
    const players: Record<string, PlayerState> = {};
    const entities: Entity[] = [];
    
    for (let i = 0; i < playerCount; i++) {
      const playerId = `p${i + 1}`;
      const basePos = BASE_POSITIONS[i];
      
      // Get lobby player info if available
      const lobbyPlayer = lobbyPlayers?.find(lp => lp.id === playerId);
      
      players[playerId] = {
        id: playerId,
        name: lobbyPlayer?.name || `Player ${i + 1}`,
        gold: 100,
        currentPop: 0,
        maxPop: 5,
        basePosition: basePos,
        color: lobbyPlayer?.color || PLAYER_COLORS[i],
        defeated: false
      };
      
      entities.push({
        id: `base_${playerId}`,
        type: EntityType.BASE,
        x: basePos.x,
        y: basePos.y,
        hp: 1000,
        maxHp: 1000,
        radius: 1.5,
        ownerId: playerId
      });
    }
    
    // Scale enemy base HP based on player count
    const enemyBaseHp = 3000 + (playerCount * 1000);
    
    entities.push({
      id: 'enemy_base',
      type: EntityType.ENEMY_BASE,
      x: enemyBasePos.x,
      y: enemyBasePos.y,
      hp: enemyBaseHp,
      maxHp: enemyBaseHp,
      radius: 2,
      ownerId: 'enemy'
    });

    return {
      players,
      entities,
      lastTick: Date.now(),
      gameOver: false,
      winner: null,
      waveNumber: 1,
      playerCount: playerCount
    };
  }

  // Check if a tile is valid terrain
  isValidTerrain(x: number, y: number): boolean {
    if (x < 0 || x >= MAP_SIZE || y < 0 || y >= MAP_SIZE) return false;
    
    const centerX = x;
    const centerY = y;
    
    // Main diagonal distance (x + y = constant for the line between bases)
    const distFromDiagonal = Math.abs(centerX + centerY - MAP_SIZE);
    
    // Wider corridor (increased from 10 to 14) plus noise
    const roominess = Math.sin(centerX * 0.15) * 6 + Math.cos(centerY * 0.15) * 6;
    
    // Always valid near bases
    const distP1 = getDistance({x, y}, { x: 10, y: 54 });
    const distP2 = getDistance({x, y}, { x: 20, y: 44 });
    const distEnemy = getDistance({x, y}, { x: 54, y: 10 });
    
    if (distP1 < 8 || distP2 < 8 || distEnemy < 8) return true;

    return distFromDiagonal < (14 + roominess);
  }

  spawnUnit(playerId: string, unitTypeKey: keyof typeof UNIT_TYPES) {
    const player = this.state.players[playerId];
    if (!player || player.defeated) return; // Can't spawn if defeated
    
    const unitStats = UNIT_TYPES[unitTypeKey];

    if (player.gold >= unitStats.cost && player.currentPop < player.maxPop) {
      player.gold -= unitStats.cost;
      player.currentPop++;

      const angle = Math.random() * Math.PI * 2;
      const spawnX = player.basePosition.x + Math.cos(angle) * 2;
      const spawnY = player.basePosition.y + Math.sin(angle) * 2;

      this.state.entities.push({
        id: generateId(),
        type: EntityType.UNIT,
        x: spawnX,
        y: spawnY,
        hp: unitStats.hp,
        maxHp: unitStats.hp,
        radius: unitStats.radius,
        ownerId: playerId,
        damage: unitStats.damage,
        range: unitStats.range,
        speed: unitStats.speed,
        unitType: unitTypeKey,
        attackCooldown: 0
      });
    }
  }

  buildHouse(playerId: string, x: number, y: number) {
    const player = this.state.players[playerId];
    if (!player || player.defeated) return; // Can't build if defeated
    
    const houseCost = 50;
    
    const dist = getDistance({x, y}, player.basePosition);
    const occupied = this.state.entities.some(e => 
      Math.abs(e.x - x) < 0.8 && Math.abs(e.y - y) < 0.8
    );

    if (
      player.gold >= houseCost && 
      dist <= BUILD_RADIUS && 
      !occupied &&
      this.isValidTerrain(x, y)
    ) {
      player.gold -= houseCost;
      player.maxPop += 5;
      
      this.state.entities.push({
        id: generateId(),
        type: EntityType.HOUSE,
        x: Math.floor(x) + 0.5,
        y: Math.floor(y) + 0.5,
        hp: 100,
        maxHp: 100,
        radius: 0.5,
        ownerId: playerId
      });
    }
  }

  buildMine(playerId: string, x: number, y: number) {
    const player = this.state.players[playerId];
    if (!player || player.defeated) return; // Can't build if defeated
    
    const dist = getDistance({x, y}, player.basePosition);
    const occupied = this.state.entities.some(e => 
      Math.abs(e.x - x) < 0.8 && Math.abs(e.y - y) < 0.8
    );

    if (
      player.gold >= MINE_COST && 
      dist <= BUILD_RADIUS && 
      !occupied &&
      this.isValidTerrain(x, y)
    ) {
      player.gold -= MINE_COST;
      
      this.state.entities.push({
        id: generateId(),
        type: EntityType.MINE,
        x: Math.floor(x) + 0.5,
        y: Math.floor(y) + 0.5,
        hp: 150,
        maxHp: 150,
        radius: 0.5,
        ownerId: playerId
      });
    }
  }

  spawnZombie() {
    const enemyBase = this.state.entities.find(e => e.type === EntityType.ENEMY_BASE);
    if (!enemyBase) return;

    // Scale zombie stats based on player count
    const playerMultiplier = 1 + ((this.playerCount - 1) * 0.3); // 30% stronger per extra player
    const hp = Math.floor((30 + (this.state.waveNumber * 5)) * playerMultiplier);
    const damage = Math.floor((5 + (this.state.waveNumber * 1)) * playerMultiplier);

    const angle = Math.random() * Math.PI * 2;
    const spawnX = enemyBase.x + Math.cos(angle) * 2;
    const spawnY = enemyBase.y + Math.sin(angle) * 2;

    this.state.entities.push({
      id: generateId(),
      type: EntityType.ZOMBIE,
      x: spawnX,
      y: spawnY,
      hp: hp,
      maxHp: hp,
      radius: 0.4,
      ownerId: 'enemy',
      damage: damage,
      range: 0.8,
      speed: 0.8,  // 33% slower movement
      attackCooldown: 0
    });
  }
  
  // Spawn multiple zombies based on player count
  spawnZombieWave() {
    // Spawn more zombies for more players
    const zombiesToSpawn = Math.ceil(this.playerCount * 1.5);
    for (let i = 0; i < zombiesToSpawn; i++) {
      this.spawnZombie();
    }
  }

  update(deltaTime: number) {
    if (this.state.gameOver) return;

    this.state.entities.forEach(entity => {
      if (entity.attackCooldown && entity.attackCooldown > 0) {
        entity.attackCooldown -= deltaTime;
      }

      if (entity.type === EntityType.UNIT || entity.type === EntityType.ZOMBIE) {
        let target: Entity | undefined;
        
        if (entity.type === EntityType.ZOMBIE) {
          // Target all player entities (bases, units, houses)
          const allPlayerIds = Object.keys(this.state.players);
          target = this.findClosestTarget(entity, allPlayerIds);
        } else {
          target = this.findClosestTarget(entity, ['enemy']);
        }

        if (target) {
           const dist = getDistance(entity, target);
           
           if (entity.range && dist > entity.range) {
             const dx = target.x - entity.x;
             const dy = target.y - entity.y;
             const length = Math.sqrt(dx * dx + dy * dy);
             
             if (length > 0) {
                const moveSpeed = (entity.speed || 1) * deltaTime;
                const vx = (dx / length) * moveSpeed;
                const vy = (dy / length) * moveSpeed;
                let newX = entity.x + vx;
                let newY = entity.y + vy;

                if (this.isValidTerrain(newX, newY)) {
                  entity.x = newX;
                  entity.y = newY;
                  // Store velocity for animation direction
                  entity.vx = dx / length;
                  entity.vy = dy / length;
                }
             }
           } 
           else if (entity.range && dist <= entity.range) {
             // Not moving - clear velocity
             entity.vx = 0;
             entity.vy = 0;
             if (!entity.attackCooldown || entity.attackCooldown <= 0) {
               target.hp -= (entity.damage || 0);
               entity.attackCooldown = 1.0; 
             }
           }
        }
      }
    });

    this.state.entities = this.state.entities.filter(e => {
        if (e.hp <= 0) {
            // When a zombie dies, give bounty to all non-defeated players
            if (e.type === EntityType.ZOMBIE) {
                Object.values(this.state.players).forEach(player => {
                    if (!player.defeated) {
                        player.gold += ZOMBIE_BOUNTY;
                    }
                });
            }
            // When a player's base is destroyed, mark them as defeated
            if (e.type === EntityType.BASE && e.ownerId) {
                if (this.state.players[e.ownerId]) {
                    this.state.players[e.ownerId].defeated = true;
                }
            }
            if (e.type === EntityType.UNIT) {
                if (this.state.players[e.ownerId]) {
                    this.state.players[e.ownerId].currentPop = Math.max(0, this.state.players[e.ownerId].currentPop - 1);
                }
            }
            return false;
        }
        return true;
    });

    // Check for game over conditions
    // Players lose if ALL their bases are destroyed
    const remainingPlayerBases = this.state.entities.filter(e => e.type === EntityType.BASE);
    const enemyBase = this.state.entities.find(e => e.id === 'enemy_base');

    if (remainingPlayerBases.length === 0) {
        this.state.gameOver = true;
        this.state.winner = 'ZOMBIES';
    } else if (!enemyBase) {
        this.state.gameOver = true;
        this.state.winner = 'PLAYERS';
    }
  }

  findClosestTarget(source: Entity, targetOwners: string[]): Entity | undefined {
    let closest: Entity | undefined;
    let minDst = Infinity;

    for (const e of this.state.entities) {
      if (targetOwners.includes(e.ownerId) && e.hp > 0) {
        const d = getDistance(source, e);
        if (d < minDst) {
          minDst = d;
          closest = e;
        }
      }
    }
    return closest;
  }
}