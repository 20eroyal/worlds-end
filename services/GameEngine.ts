import { 
  GameState, Entity, EntityType, PlayerState, Vector2, LobbyPlayer 
} from '../types';
import { 
  MAP_SIZE, UNIT_TYPES, ZOMBIE_BOUNTY, BUILD_RADIUS, 
  PASSIVE_GOLD_AMOUNT, COLORS, MINE_COST, WALL_COST 
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

const PATH_RECALC_INTERVAL = 0.4; // seconds between path recalcs to reduce jitter
const ATTACK_RANGE_BUFFER = 0.05; // small buffer so attackers don't stutter at range edge
const WALL_TARGET_MAX_DISTANCE = 5; // tiles: don't divert to faraway walls
const WALL_BLOCK_TOLERANCE = 0.75; // how close a wall must be to the direct line to count as blocking
const WALL_BREAK_CLOSE_DISTANCE = 2.5; // within this distance, zombies will break walls even if a detour exists

const getFacingFromVector = (dx: number, dy: number) => ((dx - dy) < 0 ? -1 : 1);

const getPathLength = (path: Vector2[]) => {
  let length = 0;
  for (let i = 1; i < path.length; i++) {
    length += getDistance(path[i - 1], path[i]);
  }
  return length;
};

const distancePointToSegment = (
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number
) => {
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) {
    return Math.sqrt(Math.pow(px - ax, 2) + Math.pow(py - ay, 2));
  }
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  const clamped = Math.max(0, Math.min(1, t));
  const cx = ax + clamped * dx;
  const cy = ay + clamped * dy;
  return Math.sqrt(Math.pow(px - cx, 2) + Math.pow(py - cy, 2));
};

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

  // Snap a fractional cartesian coordinate to the nearest tile center (x.5)
  snapToTileCoord(v: number) {
    return Math.round(v - 0.5) + 0.5;
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
    
    // Snap to nearest tile center
    const sx = this.snapToTileCoord(x);
    const sy = this.snapToTileCoord(y);
    const dist = getDistance({x: sx, y: sy}, player.basePosition);
    const occupied = this.state.entities.some(e => 
      Math.abs(e.x - sx) < 0.8 && Math.abs(e.y - sy) < 0.8
    );

    if (
      player.gold >= houseCost && 
      dist <= BUILD_RADIUS && 
      !occupied &&
      this.isValidTerrain(sx, sy)
    ) {
      player.gold -= houseCost;
      player.maxPop += 5;
      
      this.state.entities.push({
        id: generateId(),
        type: EntityType.HOUSE,
        x: sx,
        y: sy,
        hp: 100,
        maxHp: 100,
        radius: 1.0,
        ownerId: playerId
      });
    }
  }

  buildMine(playerId: string, x: number, y: number) {
    const player = this.state.players[playerId];
    if (!player || player.defeated) return; // Can't build if defeated
    
    // Snap to nearest tile center
    const sx = this.snapToTileCoord(x);
    const sy = this.snapToTileCoord(y);
    const dist = getDistance({x: sx, y: sy}, player.basePosition);
    const occupied = this.state.entities.some(e => 
      Math.abs(e.x - sx) < 0.8 && Math.abs(e.y - sy) < 0.8
    );

    if (
      player.gold >= MINE_COST && 
      dist <= BUILD_RADIUS && 
      !occupied &&
      this.isValidTerrain(sx, sy)
    ) {
      player.gold -= MINE_COST;
      
      this.state.entities.push({
        id: generateId(),
        type: EntityType.MINE,
        x: sx,
        y: sy,
        hp: 150,
        maxHp: 150,
        radius: 1.0,
        ownerId: playerId
      });
    }
  }

  buildWall(playerId: string, x: number, y: number) {
    const player = this.state.players[playerId];
    if (!player || player.defeated) return; // Can't build if defeated
    
    // Snap to nearest tile center
    const sx = this.snapToTileCoord(x);
    const sy = this.snapToTileCoord(y);
    const occupied = this.state.entities.some(e => 
      Math.abs(e.x - sx) < 0.8 && Math.abs(e.y - sy) < 0.8
    );

    // Walls can be placed anywhere on valid terrain (no BUILD_RADIUS restriction)
    if (
      player.gold >= WALL_COST && 
      !occupied &&
      this.isValidTerrain(sx, sy)
    ) {
      player.gold -= WALL_COST;
      
      this.state.entities.push({
        id: generateId(),
        type: EntityType.WALL,
        x: sx,
        y: sy,
        hp: 200,
        maxHp: 200,
        // Keep wall hitbox close to tile size so zombies have to get near to attack
        radius: 0.8,
        ownerId: playerId
      });
    }
  }


  // Check whether a world position is blocked by an entity (used to prevent overlap)
  isPositionBlocked(x: number, y: number, ignoreId?: string, ignoreTypes?: EntityType[]): boolean {
    const ignoredTypes = ignoreTypes ?? [];
    for (const e of this.state.entities) {
      if (ignoreId && e.id === ignoreId) continue;
      if (ignoredTypes.includes(e.type)) continue;
      if (e.hp <= 0) continue;
      // Consider walls, buildings and bases as blocking
      if ([EntityType.WALL, EntityType.HOUSE, EntityType.MINE, EntityType.BASE, EntityType.ENEMY_BASE].includes(e.type)) {
        const d = getDistance({ x, y }, e);
        const blockerRadius = e.radius || 0.5;
        // Use a small tolerance to avoid jitter
        if (d < blockerRadius + 0.5) return true;
      }
    }
    return false;
  }

  buildBlockedTiles(ignoreTypes?: EntityType[], ignoreId?: string): Set<string> {
    const ignoredTypes = ignoreTypes ?? [];
    const blocked = new Set<string>();

    for (const e of this.state.entities) {
      if (ignoreId && e.id === ignoreId) continue;
      if (ignoredTypes.includes(e.type)) continue;
      if (e.hp <= 0) continue;
      if ([EntityType.WALL, EntityType.HOUSE, EntityType.MINE, EntityType.BASE, EntityType.ENEMY_BASE].includes(e.type)) {
        const tx = Math.floor(e.x);
        const ty = Math.floor(e.y);
        if (tx >= 0 && tx < MAP_SIZE && ty >= 0 && ty < MAP_SIZE) {
          blocked.add(`${tx},${ty}`);
        }
      }
    }

    return blocked;
  }

  // A* pathfinding on integer tile grid. Returns array of tile centers {x,y} or null.
  findPath(
    startX: number,
    startY: number,
    goalX: number,
    goalY: number,
    ignoreId?: string,
    ignoreTypes?: EntityType[],
    blockedTiles?: Set<string>
  ): Vector2[] | null {
    const start = { x: Math.floor(startX), y: Math.floor(startY) };
    const goal = { x: Math.floor(goalX), y: Math.floor(goalY) };

    const key = (n: { x: number; y: number }) => `${n.x},${n.y}`;

    const inBounds = (x: number, y: number) => x >= 0 && x < MAP_SIZE && y >= 0 && y < MAP_SIZE;

    const heuristic = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

    const neighbors = [
      { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
      { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 }
    ];

    const openSet: { node: {x:number;y:number}, f: number }[] = [];
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>();

    const startKey = key(start);
    const goalKey = key(goal);

    openSet.push({ node: start, f: heuristic(start, goal) });
    gScore.set(startKey, 0);

    const popLowest = () => {
      let idx = 0;
      let best = openSet[0];
      for (let i = 1; i < openSet.length; i++) {
        if (openSet[i].f < best.f) { best = openSet[i]; idx = i; }
      }
      return openSet.splice(idx, 1)[0];
    };

    while (openSet.length > 0) {
      const current = popLowest().node;
      const currentKey = key(current);
      if (currentKey === goalKey) {
        // reconstruct path
        const path: {x:number;y:number}[] = [];
        let curK: string | undefined = currentKey;
        while (curK && curK !== startKey) {
          const parts = curK.split(',').map(Number);
          path.push({ x: parts[0] + 0.5, y: parts[1] + 0.5 });
          curK = cameFrom.get(curK);
        }
        // add start
        path.push({ x: start.x + 0.5, y: start.y + 0.5 });
        return path.reverse();
      }

      for (const n of neighbors) {
        const nx = current.x + n.x;
        const ny = current.y + n.y;
        if (!inBounds(nx, ny)) continue;
        if (!this.isValidTerrain(nx, ny)) continue;

        // Allow stepping into goal tile even if it's currently occupied by the target
        const centerX = nx + 0.5;
        const centerY = ny + 0.5;
        const neighborKey = `${nx},${ny}`;
        if (neighborKey !== goalKey) {
          if (blockedTiles) {
            if (blockedTiles.has(neighborKey)) continue;
          } else if (this.isPositionBlocked(centerX, centerY, ignoreId, ignoreTypes)) {
            continue;
          }
        }

        const tentativeG = (gScore.get(currentKey) ?? Infinity) + ((n.x === 0 || n.y === 0) ? 1 : 1.4);
        const prevG = gScore.get(neighborKey) ?? Infinity;
        if (tentativeG < prevG) {
          cameFrom.set(neighborKey, currentKey);
          gScore.set(neighborKey, tentativeG);
          const f = tentativeG + heuristic({ x: nx, y: ny }, goal);
          // add to openSet if not present
          if (!openSet.find(o => o.node.x === nx && o.node.y === ny)) {
            openSet.push({ node: { x: nx, y: ny }, f });
          }
        }
      }
    }

    return null;
  }

  findBlockingWall(source: Entity, target: Entity): Entity | undefined {
    const walls = this.state.entities.filter(e => e.type === EntityType.WALL && e.hp > 0);
    if (walls.length === 0) return undefined;

    const ax = source.x;
    const ay = source.y;
    const bx = target.x;
    const by = target.y;
    const distToTarget = getDistance(source, target);

    let bestWall: Entity | undefined;
    let bestDist = Infinity;

    for (const wall of walls) {
      const distToWall = getDistance(source, wall);
      if (distToWall > WALL_TARGET_MAX_DISTANCE) continue;
      if (distToWall >= distToTarget) continue;

      const wallRadius = wall.radius || 0.8;
      const lineDist = distancePointToSegment(wall.x, wall.y, ax, ay, bx, by);
      if (lineDist > wallRadius + WALL_BLOCK_TOLERANCE) continue;

      if (distToWall < bestDist) {
        bestDist = distToWall;
        bestWall = wall;
      }
    }

    return bestWall;
  }

  findNearestWall(source: Entity, maxDistance: number): Entity | undefined {
    let bestWall: Entity | undefined;
    let bestDist = Infinity;
    for (const wall of this.state.entities) {
      if (wall.type !== EntityType.WALL || wall.hp <= 0) continue;
      const dist = getDistance(source, wall);
      if (dist <= maxDistance && dist < bestDist) {
        bestDist = dist;
        bestWall = wall;
      }
    }
    return bestWall;
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

    const blockedTilesDefault = this.buildBlockedTiles();
    const blockedTilesIgnoreEnemyBase = this.buildBlockedTiles([EntityType.ENEMY_BASE]);

    this.state.entities.forEach(entity => {
      if (entity.attackCooldown && entity.attackCooldown > 0) {
        entity.attackCooldown -= deltaTime;
      }

      if (entity.type === EntityType.UNIT || entity.type === EntityType.ZOMBIE) {
        let target: Entity | undefined;

        if (entity.type === EntityType.ZOMBIE) {
          // Target all player entities (bases, units, houses)
          const allPlayerIds = Object.keys(this.state.players);
          const primaryTarget = this.findClosestTarget(entity, allPlayerIds, [EntityType.WALL]);
          if (primaryTarget) {
            const lockedTarget = entity.targetId
              ? this.state.entities.find(e => e.id === entity.targetId && e.hp > 0)
              : undefined;
            target = (lockedTarget && lockedTarget.type === EntityType.WALL) ? lockedTarget : primaryTarget;
          }
        } else {
          target = this.findClosestTarget(entity, ['enemy']);
        }

        if (target) {
          const speed = Math.max(0.1, entity.speed || 1);
          const ignoreTypes = entity.type === EntityType.ZOMBIE ? [EntityType.ENEMY_BASE] : undefined;
          const blockedTiles = entity.type === EntityType.ZOMBIE ? blockedTilesIgnoreEnemyBase : blockedTilesDefault;
          entity.pathCooldown = Math.max(0, (entity.pathCooldown ?? 0) - deltaTime);

          // Pathfinding: compute path if needed (target changed or no path), throttled by cooldown
          const needsNewPath = !entity.path || entity.targetId !== target.id || entity.pathIndex === undefined || entity.pathIndex >= (entity.path?.length || 0);
          if (needsNewPath && entity.pathCooldown <= 0) {
            let desiredTarget = target;
            let path = this.findPath(entity.x, entity.y, target.x, target.y, entity.id, ignoreTypes, blockedTiles);
            let pathTime = path ? getPathLength(path) / speed : Infinity;
            const directTime = getDistance(entity, target) / speed;

            if (entity.type === EntityType.ZOMBIE && target.type !== EntityType.WALL) {
              const wallTarget = this.findBlockingWall(entity, target);
              if (wallTarget) {
                const distToWall = getDistance(entity, wallTarget);
                const shouldBreakWall = !path || pathTime > directTime * 1.25 || distToWall <= WALL_BREAK_CLOSE_DISTANCE;
                if (shouldBreakWall) {
                  desiredTarget = wallTarget;
                  path = this.findPath(entity.x, entity.y, wallTarget.x, wallTarget.y, entity.id, ignoreTypes, blockedTiles);
                }
              }
              if (!path) {
                const nearbyWall = this.findNearestWall(entity, WALL_TARGET_MAX_DISTANCE);
                if (nearbyWall) {
                  desiredTarget = nearbyWall;
                  path = this.findPath(entity.x, entity.y, nearbyWall.x, nearbyWall.y, entity.id, ignoreTypes, blockedTiles);
                }
              }
            }

            if (path && path.length > 0) {
              entity.path = path;
              entity.pathIndex = 0;
            } else {
              // No path found - clear path so we fallback to direct movement
              entity.path = undefined;
              entity.pathIndex = undefined;
            }

            entity.targetId = desiredTarget.id;
            entity.pathCooldown = PATH_RECALC_INTERVAL;
            target = desiredTarget;
          } else if (entity.targetId && entity.targetId !== target.id) {
            const lockedTarget = this.state.entities.find(e => e.id === entity.targetId && e.hp > 0);
            if (lockedTarget) {
              target = lockedTarget;
            }
          }

          const dist = getDistance(entity, target);
          const targetRadius = target.radius || 0;
          const effectiveTargetRadius =
            target.type === EntityType.WALL ? Math.min(targetRadius, 0.6) : targetRadius;

          // Drop wall targets that are now out of range
          if (target.type === EntityType.WALL && dist > WALL_TARGET_MAX_DISTANCE) {
            entity.targetId = undefined;
            entity.path = undefined;
            entity.pathIndex = undefined;
            entity.pathCooldown = 0;
            if (entity.type === EntityType.ZOMBIE) {
              const allPlayerIds = Object.keys(this.state.players);
              const primaryTarget = this.findClosestTarget(entity, allPlayerIds, [EntityType.WALL]);
              if (!primaryTarget) return;
              target = primaryTarget;
            } else {
              return;
            }
          }

          // Attack as soon as in range, even if a path exists
          if (entity.range && dist <= entity.range + effectiveTargetRadius + ATTACK_RANGE_BUFFER) {
            const dx = target.x - entity.x;
            const dy = target.y - entity.y;
            entity.vx = 0;
            entity.vy = 0;
            entity.facing = getFacingFromVector(dx, dy);
            entity.path = undefined;
            entity.pathIndex = undefined;

            if (!entity.attackCooldown || entity.attackCooldown <= 0) {
              target.hp -= (entity.damage || 0);
              target.lastAttackerId = entity.ownerId;
              entity.attackCooldown = 1.0;
            }
          } else if (entity.path && entity.pathIndex !== undefined && entity.pathIndex < entity.path.length) {
            // Follow next waypoint
            const waypoint = entity.path[entity.pathIndex];
            const dx = waypoint.x - entity.x;
            const dy = waypoint.y - entity.y;
            const length = Math.sqrt(dx*dx + dy*dy);
            if (length > 0) {
              const moveStep = speed * deltaTime;
              const step = Math.min(moveStep, length);
              const stepX = (dx / length) * step;
              const stepY = (dy / length) * step;
              const newX = entity.x + stepX;
              const newY = entity.y + stepY;
              if (this.isValidTerrain(newX, newY) && !this.isPositionBlocked(newX, newY, entity.id, ignoreTypes)) {
                entity.x = newX;
                entity.y = newY;
                entity.vx = dx / length;
                entity.vy = dy / length;
                entity.facing = getFacingFromVector(dx, dy);
              } else {
                // blocked; drop path so it will be recomputed after cooldown
                entity.vx = 0;
                entity.vy = 0;
                entity.path = undefined;
                entity.pathIndex = undefined;
                entity.pathCooldown = PATH_RECALC_INTERVAL;
                if (entity.type === EntityType.ZOMBIE) {
                  const nearbyWall = this.findNearestWall(entity, WALL_BREAK_CLOSE_DISTANCE);
                  if (nearbyWall) {
                    entity.targetId = nearbyWall.id;
                    entity.pathCooldown = 0;
                  }
                }
              }

              // If close to waypoint, advance
              if (Math.sqrt(Math.pow(waypoint.x - entity.x,2) + Math.pow(waypoint.y - entity.y,2)) < 0.2) {
                entity.pathIndex = (entity.pathIndex ?? 0) + 1;
              }
            }
          } else if (entity.range && dist > entity.range + effectiveTargetRadius) {
            // No path: fallback to direct movement towards target, but respect blocking
            const dx = target.x - entity.x;
            const dy = target.y - entity.y;
            const length = Math.sqrt(dx * dx + dy * dy);
            if (length > 0) {
              const moveSpeed = speed * deltaTime;
              const vx = (dx / length) * moveSpeed;
              const vy = (dy / length) * moveSpeed;
              const newX = entity.x + vx;
              const newY = entity.y + vy;
              if (this.isValidTerrain(newX, newY) && !this.isPositionBlocked(newX, newY, entity.id, ignoreTypes)) {
                entity.x = newX;
                entity.y = newY;
                entity.vx = dx / length;
                entity.vy = dy / length;
                entity.facing = getFacingFromVector(dx, dy);
              } else {
                entity.vx = 0;
                entity.vy = 0;
                entity.path = undefined;
                entity.pathIndex = undefined;
                entity.pathCooldown = PATH_RECALC_INTERVAL;
                if (entity.type === EntityType.ZOMBIE) {
                  const nearbyWall = this.findNearestWall(entity, WALL_BREAK_CLOSE_DISTANCE);
                  if (nearbyWall) {
                    entity.targetId = nearbyWall.id;
                    entity.pathCooldown = 0;
                  }
                }
              }
            }
          }
        }
      }
    });

    this.state.entities = this.state.entities.filter(e => {
        if (e.hp <= 0) {
            // When a zombie dies, give bounty to the player who killed it
            if (e.type === EntityType.ZOMBIE && e.lastAttackerId) {
                const killer = this.state.players[e.lastAttackerId];
                if (killer && !killer.defeated) {
                    killer.gold += ZOMBIE_BOUNTY;
                }
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

  findClosestTarget(source: Entity, targetOwners: string[], excludeTypes?: EntityType[]): Entity | undefined {
    let closest: Entity | undefined;
    let minDst = Infinity;
    const excluded = excludeTypes ?? [];

    for (const e of this.state.entities) {
      if (targetOwners.includes(e.ownerId) && e.hp > 0) {
        if (excluded.includes(e.type)) continue;
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
