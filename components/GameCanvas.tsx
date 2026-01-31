import React, { useRef, useEffect, useState } from 'react';
import { GameEngine } from '../services/GameEngine';
import { cartToIso, isoToCart } from '../utils/isometric';
import { TILE_SIZE, COLORS, MAP_SIZE, GOLD_GENERATION_INTERVAL, PASSIVE_GOLD_AMOUNT, MINE_INCOME, BUILD_RADIUS } from '../constants';
import { EntityType, Entity, PlayerState } from '../types';

// Helper to get correct asset path for Electron or web
function getZombieSpritePath() {
  // @ts-ignore
  if (window && window.__dirname) {
    // Electron: use absolute path
    return window.__dirname + '/assets/zombie.png';
  }
  // Web: use relative path
  return './assets/zombie.png';
}

function getHouseSpritePath() {
  // @ts-ignore
  if (window && window.__dirname) {
    return window.__dirname + '/assets/house.png';
  }
  return './assets/house.png';
}

// Zombie sprite configuration
const ZOMBIE_SPRITE = {
  src: getZombieSpritePath(),
  frameWidth: 64,   // Width of each frame
  frameHeight: 64,  // Height of each frame
  walkFrames: 4,    // Number of walk animation frames
  animationSpeed: 0.008, // Animation speed multiplier
};

interface GameCanvasProps {
  engine: GameEngine;
  playerId: string;
  buildMode: boolean;
  buildType?: 'house' | 'mine' | 'wall';
  onSelectTile: (x: number, y: number) => void;
  isHost: boolean;
}

const GameCanvas: React.FC<GameCanvasProps> = ({ engine, playerId, buildMode, buildType, onSelectTile, isHost }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const zombieSpriteRef = useRef<HTMLImageElement | null>(null);
  const houseSpriteRef = useRef<HTMLImageElement | null>(null);
  const [spriteLoaded, setSpriteLoaded] = useState(false);
  const [houseLoaded, setHouseLoaded] = useState(false);
  
  // Load zombie sprite
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      zombieSpriteRef.current = img;
      setSpriteLoaded(true);
      console.log('Zombie sprite loaded:', img.width, 'x', img.height);
      // Update config based on actual image size
      const detectedFrameWidth = img.width / 4;
      const detectedFrameHeight = img.height;
      console.log('Detected frame size:', detectedFrameWidth, 'x', detectedFrameHeight);
    };
    img.onerror = (e) => {
      console.error('Failed to load zombie sprite:', e);
    };
    img.src = ZOMBIE_SPRITE.src;
    
    // Load house sprite
    const houseImg = new Image();
    houseImg.onload = () => {
      houseSpriteRef.current = houseImg;
      setHouseLoaded(true);
      console.log('House sprite loaded');
    };
    houseImg.src = getHouseSpritePath();
    
    return () => {
      zombieSpriteRef.current = null;
      houseSpriteRef.current = null;
    };
  }, []);
  
  // Calculate initial offset - will be set once we know player's base
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const lastCenteredPlayerId = useRef<string | null>(null);

  // Center camera on local player's base when playerId changes or state is ready
  useEffect(() => {
    // Only recenter if playerId changed or we haven't centered yet
    if (lastCenteredPlayerId.current === playerId) return;
    
    const player = engine.state.players[playerId];
    if (player && player.basePosition) {
      const basePos = player.basePosition;
      const iso = cartToIso(basePos.x, basePos.y);
      setOffset({ 
        x: -iso.x, 
        y: -iso.y + window.innerHeight / 4
      });
      lastCenteredPlayerId.current = playerId;
      console.log('Camera centered on player:', playerId, 'at base:', basePos);
    }
  }, [engine.state.players, playerId]);

  const requestRef = useRef<number>();
  const lastTimeRef = useRef<number>(0);

  // Camera Dragging
  const isDragging = useRef(false);
  const isMinimapDragging = useRef(false);
  const lastMousePos = useRef({ x: 0, y: 0 });

  // Passive Gold Timer (host only)
  useEffect(() => {
    if (!isHost) return;
    const interval = setInterval(() => {
      if (!engine.state.gameOver) {
        Object.values(engine.state.players).forEach((p: PlayerState) => {
            // Base passive income
            let income = PASSIVE_GOLD_AMOUNT;
            // Add income from mines
            const mineCount = engine.state.entities.filter(
              e => e.type === EntityType.MINE && e.ownerId === p.id
            ).length;
            income += mineCount * MINE_INCOME;
            p.gold += income;
        });
      }
    }, GOLD_GENERATION_INTERVAL);
    return () => clearInterval(interval);
  }, [engine, isHost]);

  // Zombie Spawning Timer (host only)
  useEffect(() => {
    if (!isHost) return;
    const interval = setInterval(() => {
        if (!engine.state.gameOver) {
            // Spawn zombies based on player count
            engine.spawnZombieWave();
        }
    }, 4000); // Spawn every 4 seconds (was 2 seconds)
    return () => clearInterval(interval);
  }, [engine, isHost]);


  const render = (time: number) => {
    if (!lastTimeRef.current) lastTimeRef.current = time;
    const deltaTime = (time - lastTimeRef.current) / 1000;
    lastTimeRef.current = time;

    // Only host runs the game simulation
    if (isHost) {
      engine.update(deltaTime);
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Clear
    ctx.fillStyle = COLORS.BACKGROUND;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    const centerX = canvas.width / 2 + offset.x;
    const centerY = canvas.height / 2 + offset.y; // Changed from height/4 to height/2 for better centering
    ctx.translate(centerX, centerY);

    // Draw walkable terrain
    ctx.fillStyle = COLORS.TERRAIN;
    
    // Get player's base position for build range
    const player = engine.state.players[playerId];
    const basePos = player?.basePosition;
    
    // Determine view bounds in cartesian to optimize (Optional, but simple loop is fine for 64x64)
    for (let x = 0; x < MAP_SIZE; x++) {
        for (let y = 0; y < MAP_SIZE; y++) {
            if (engine.isValidTerrain(x, y)) {
                const pos = cartToIso(x, y);
                
                // Check if tile is within build range (for house/mine, not wall)
                const inBuildRange = basePos && 
                  Math.sqrt(Math.pow(x + 0.5 - basePos.x, 2) + Math.pow(y + 0.5 - basePos.y, 2)) <= BUILD_RADIUS;
                
                // Highlight build range when in build mode for house/mine
                if (buildMode && buildType !== 'wall' && inBuildRange) {
                  ctx.fillStyle = 'rgba(239, 68, 68, 0.4)'; // Light red highlight for buildable area
                } else if (buildMode && buildType === 'wall') {
                  ctx.fillStyle = COLORS.TERRAIN; // No dimming for walls - they can go anywhere
                } else {
                  ctx.fillStyle = COLORS.TERRAIN;
                }
                
                ctx.beginPath();
                ctx.moveTo(pos.x, pos.y);
                ctx.lineTo(pos.x + TILE_SIZE, pos.y + TILE_SIZE / 2);
                ctx.lineTo(pos.x, pos.y + TILE_SIZE);
                ctx.lineTo(pos.x - TILE_SIZE, pos.y + TILE_SIZE / 2);
                ctx.closePath();
                ctx.fill();
                
                if (buildMode) {
                    ctx.strokeStyle = COLORS.GRID;
                    ctx.lineWidth = 1;
                    ctx.stroke();
                }
            }
        }
    }

    // Sort by depth (Y + X)
    const sortedEntities = [...engine.state.entities].sort((a, b) => (a.x + a.y) - (b.x + b.y));

    sortedEntities.forEach(entity => {
        drawEntity(ctx, entity, time);
    });

    ctx.restore();
    
    // Draw minimap (after restore so it's in screen coordinates)
    drawMinimap(ctx, canvas);
    
    requestRef.current = requestAnimationFrame(render);
  };

  const getPlayerColor = (ownerId: string): string => {
    const player = engine.state.players[ownerId];
    if (player) {
      return player.color;
    }
    return '#888888'; // Default gray for unknown
  };

  // Create offscreen canvases for zombie frames (once)
  const zombieFramesRef = useRef<HTMLCanvasElement[] | null>(null);
  
  useEffect(() => {
    if (!spriteLoaded || !zombieSpriteRef.current) return;
    
    const sprite = zombieSpriteRef.current;
    const frameW = Math.floor(sprite.naturalWidth / 4);
    const frameH = Math.floor(sprite.naturalHeight / 4);
    
    console.log('Extracting frames: sprite', sprite.naturalWidth, 'x', sprite.naturalHeight, 'frame', frameW, 'x', frameH);
    
    // Create 4 canvases for the 4 walk frames (first row)
    const frames: HTMLCanvasElement[] = [];
    for (let i = 0; i < 4; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = frameW;
      canvas.height = frameH;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Draw the sprite offset so the frame we want is at 0,0
        ctx.drawImage(sprite, -i * frameW, 0);
        
        // Debug: check if canvas has content
        const imageData = ctx.getImageData(frameW/2, frameH/2, 1, 1);
        console.log('Frame', i, 'center pixel:', imageData.data);
      }
      frames.push(canvas);
    }
    zombieFramesRef.current = frames;
    console.log('Created', frames.length, 'zombie frames');
  }, [spriteLoaded]);

  // Draw zombie using sprite sheet
  const drawZombie = (ctx: CanvasRenderingContext2D, pos: { x: number; y: number }, entity: Entity, time: number) => {
    const sprite = zombieSpriteRef.current;
    
    if (!sprite || !sprite.complete) {
      ctx.fillStyle = COLORS.ZOMBIE;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y - 12, TILE_SIZE * entity.radius, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    
    // Sprite is 4 columns x 1 row (2816 x 1536)
    const fullFrameW = Math.floor(sprite.naturalWidth / 4);  // 704
    const fullFrameH = sprite.naturalHeight;                  // 1536
    
    // Crop horizontally to just the zombie area (keep full height)
    const cropTop = 0;  // Full height - start from top
    const cropHeight = fullFrameH;  // Full height
    const cropLeft = Math.floor(fullFrameW * 0.15);  // Trim 15% from left
    const cropWidth = Math.floor(fullFrameW * 0.70);  // Take middle 70%
    
    // Animation frame - use only 3 frames, skip frame 0 (the standing pose with leg straight)
    const idHash = entity.id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const rawFrame = Math.floor((time * 0.0048 + idHash) % 3);  // 4x faster animation
    // Map: skip frame 0. Use frames 3, 2, 1 (reversed for correct walk direction)
    const frameMap = [3, 2, 1];
    const frame = frameMap[rawFrame];
    
    // Per-frame offsets to align zombie center (counteract forward movement in sprite)
    // Offsets for frames 1, 2, 3 (skipping 0)
    const frameOffsetsX: Record<number, number> = { 1: 20, 2: 10, 3: 0 };
    const frameOffsetsY: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    
    // Scale so the zombie is about 50px visible height
    const zombieVisibleHeight = 50;
    const scale = zombieVisibleHeight / (fullFrameH * 0.35);
    const destW = Math.round(cropWidth * scale);
    const destH = Math.round(cropHeight * scale);
    
    // Sprite faces RIGHT by default, flip for left movement
    const movingLeft = entity.vx !== undefined && entity.vx < 0;
    
    // Source position - cropped frame area
    const sx = frame * fullFrameW + cropLeft;
    const sy = cropTop;
    
    // Center on zombie position with per-frame offset compensation
    const centerX = Math.round(pos.x);
    const centerY = Math.round(pos.y);
    const offsetX = frameOffsetsX[frame];
    const offsetY = frameOffsetsY[frame];
    
    ctx.save();
    
    if (movingLeft) {
      ctx.translate(centerX, centerY);
      ctx.scale(-1, 1);
      ctx.drawImage(
        sprite,
        sx, sy, cropWidth, cropHeight,
        -destW / 2 - offsetX, -destH + 15 + offsetY, destW, destH
      );
    } else {
      ctx.drawImage(
        sprite,
        sx, sy, cropWidth, cropHeight,
        centerX - destW / 2 + offsetX, centerY - destH + 15 + offsetY, destW, destH
      );
    }
    
    ctx.restore();
  };

  const drawEntity = (ctx: CanvasRenderingContext2D, entity: Entity, time: number) => {
    const pos = cartToIso(entity.x, entity.y);
    
    // Shadow (skip for zombies - they have no shadow)
    if (entity.type !== EntityType.ZOMBIE) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)';
      ctx.beginPath();
      ctx.ellipse(pos.x, pos.y + 5, TILE_SIZE/2 * entity.radius, TILE_SIZE/4 * entity.radius, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // Body
    if (entity.type === EntityType.BASE) {
        ctx.fillStyle = getPlayerColor(entity.ownerId);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, TILE_SIZE * 1.2, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 3;
        ctx.stroke();
        
        // Draw player name on base
        const player = engine.state.players[entity.ownerId];
        const displayName = player?.name || entity.ownerId.toUpperCase();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px monospace';
        ctx.textAlign = 'center';
        // Truncate long names
        const truncatedName = displayName.length > 10 ? displayName.substring(0, 9) + '…' : displayName;
        ctx.fillText(truncatedName, pos.x, pos.y + 5);
    } else if (entity.type === EntityType.ENEMY_BASE) {
        ctx.fillStyle = COLORS.ZOMBIE_BASE;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, TILE_SIZE * 1.8, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 4;
        ctx.stroke();
    } else if (entity.type === EntityType.HOUSE) {
      // Draw house sprite when available, otherwise fallback to tile-aligned rectangle
      const tileSize = TILE_SIZE;
      const w = Math.round(tileSize * 1.5);
      const h = Math.round(tileSize * 1.5);
      const x = Math.round(pos.x - w / 2);
      // Anchor bottom slightly below pos.y so the building sits on the ground
      const y = Math.round(pos.y - h + Math.round(tileSize * 0.2));

      if (houseLoaded && houseSpriteRef.current) {
        const img = houseSpriteRef.current;
        // Draw image scaled to fit tile, anchored to ground
        ctx.drawImage(img, x, y, w, h);
      } else {
        // Draw simple building rectangle
        ctx.fillStyle = getPlayerColor(entity.ownerId);
        ctx.fillRect(x, y, w, h);
        // Roof line
        ctx.strokeStyle = 'black';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        // Small door
        ctx.fillStyle = '#4b5563';
        const doorW = Math.max(6, Math.round(w * 0.2));
        const doorH = Math.max(8, Math.round(h * 0.35));
        ctx.fillRect(pos.x - doorW/2, pos.y - doorH, doorW, doorH);
      }
    } else if (entity.type === EntityType.MINE) {
      // Draw mine as a tile-aligned building with coin emblem
      const tileSize = TILE_SIZE;
      const w = Math.round(tileSize * 1.5);
      const h = Math.round(tileSize * 1.5);
      const x = Math.round(pos.x - w / 2);
      const y = Math.round(pos.y - h + Math.round(tileSize * 0.2)); // anchor bottom slightly lower

      // Building body
      ctx.fillStyle = '#fbbf24'; // gold/amber
      ctx.fillRect(x, y, w, h);
      // Border
      ctx.strokeStyle = '#92400e';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      // Coin emblem centered on building front
      ctx.fillStyle = '#fef08a';
      const coinR = Math.round(Math.min(w, h) * 0.18);
      ctx.beginPath();
      ctx.arc(pos.x, y + Math.round(h*0.35), coinR, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#92400e';
      ctx.font = `bold ${Math.max(10, coinR)}px Arial`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', pos.x, y + Math.round(h*0.35));
    } else if (entity.type === EntityType.ZOMBIE) {
        // Draw animated zombie
        drawZombie(ctx, pos, entity, time);
    } else if (entity.type === EntityType.WALL) {
        // Draw wall as a gray stone block
        const size = TILE_SIZE * 0.5;
        ctx.fillStyle = '#6b7280'; // Gray stone color
        ctx.beginPath();
        ctx.moveTo(pos.x, pos.y - size);
        ctx.lineTo(pos.x + size, pos.y - size/2);
        ctx.lineTo(pos.x, pos.y);
        ctx.lineTo(pos.x - size, pos.y - size/2);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#374151'; // Dark gray border
        ctx.lineWidth = 2;
        ctx.stroke();
        // Add brick texture lines
        ctx.strokeStyle = '#4b5563';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(pos.x - size * 0.5, pos.y - size * 0.65);
        ctx.lineTo(pos.x + size * 0.5, pos.y - size * 0.65);
        ctx.stroke();
    } else {
        // Player units
        ctx.fillStyle = getPlayerColor(entity.ownerId);

        ctx.beginPath();
        ctx.arc(pos.x, pos.y - 12, TILE_SIZE * entity.radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1;
        ctx.stroke();
    }

    // Health Bar (skip for zombies as they have their own positioning)
    if (entity.hp < entity.maxHp && entity.type !== EntityType.ZOMBIE) {
        const hpPct = entity.hp / entity.maxHp;
        const barWidth = 30;
        ctx.fillStyle = '#333';
        ctx.fillRect(pos.x - barWidth/2, pos.y - 40, barWidth, 5);
        ctx.fillStyle = hpPct > 0.5 ? '#22c55e' : (hpPct > 0.25 ? '#eab308' : '#ef4444');
        ctx.fillRect(pos.x - barWidth/2, pos.y - 40, barWidth * hpPct, 5);
    }
    
    // Health Bar for zombies (adjusted position)
    if (entity.hp < entity.maxHp && entity.type === EntityType.ZOMBIE) {
        const hpPct = entity.hp / entity.maxHp;
        const barWidth = 24;
        const size = TILE_SIZE * entity.radius;
        ctx.fillStyle = '#333';
        ctx.fillRect(pos.x - barWidth/2, pos.y - size * 2 - 10, barWidth, 4);
        ctx.fillStyle = '#22c55e';
        ctx.fillRect(pos.x - barWidth/2, pos.y - size * 2 - 10, barWidth * hpPct, 4);
    }
  };
  
  // Minimap constants (used in both drawing and click handling)
  const minimapSize = 150;
  const minimapPadding = 10;
  
  // Draw minimap
  const drawMinimap = (ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement) => {
    const minimapX = canvas.width - minimapSize - minimapPadding;
    const minimapY = canvas.height - minimapSize - minimapPadding;
    const scale = minimapSize / MAP_SIZE;
    
    // Background
    ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
    ctx.fillRect(minimapX, minimapY, minimapSize, minimapSize);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    ctx.lineWidth = 1;
    ctx.strokeRect(minimapX, minimapY, minimapSize, minimapSize);
    
    // Draw terrain
    ctx.fillStyle = 'rgba(100, 100, 100, 0.5)';
    for (let x = 0; x < MAP_SIZE; x += 2) {
      for (let y = 0; y < MAP_SIZE; y += 2) {
        if (engine.isValidTerrain(x, y)) {
          ctx.fillRect(minimapX + x * scale, minimapY + y * scale, scale * 2, scale * 2);
        }
      }
    }
    
    // Draw entities
    engine.state.entities.forEach(entity => {
      const ex = minimapX + entity.x * scale;
      const ey = minimapY + entity.y * scale;
      
      if (entity.type === EntityType.BASE) {
        ctx.fillStyle = getPlayerColor(entity.ownerId);
        ctx.beginPath();
        ctx.arc(ex, ey, 4, 0, Math.PI * 2);
        ctx.fill();
      } else if (entity.type === EntityType.ENEMY_BASE) {
        ctx.fillStyle = COLORS.ZOMBIE_BASE;
        ctx.beginPath();
        ctx.arc(ex, ey, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 1;
        ctx.stroke();
      } else if (entity.type === EntityType.ZOMBIE) {
        ctx.fillStyle = COLORS.ZOMBIE;
        ctx.fillRect(ex - 1, ey - 1, 2, 2);
      } else if (entity.type === EntityType.UNIT) {
        ctx.fillStyle = getPlayerColor(entity.ownerId);
        ctx.fillRect(ex - 1, ey - 1, 3, 3);
      } else if (entity.type === EntityType.HOUSE) {
        ctx.fillStyle = getPlayerColor(entity.ownerId);
        ctx.fillRect(ex - 2, ey - 2, 4, 4);
      } else if (entity.type === EntityType.MINE) {
        ctx.fillStyle = '#fbbf24'; // Gold color for mines
        ctx.fillRect(ex - 2, ey - 2, 4, 4);
      } else if (entity.type === EntityType.WALL) {
        ctx.fillStyle = '#6b7280'; // Gray for walls
        ctx.fillRect(ex - 1, ey - 1, 3, 3);
      }
    });
    
    // Draw current viewport indicator
    // Convert current camera offset back to world coordinates (reverse of what we do in navigation)
    const viewCenterIso = { x: -offset.x, y: -offset.y };
    const viewCenter = isoToCart(viewCenterIso.x, viewCenterIso.y);
    
    // Approximate viewport size in world units (rough estimate based on screen size and tile size)
    const viewWidth = (canvas.width / TILE_SIZE) * 0.7;
    const viewHeight = (canvas.height / TILE_SIZE) * 0.7;
    
    // Calculate viewport rect size (fixed size)
    const viewRectW = viewWidth * scale;
    const viewRectH = viewHeight * scale;
    
    // Calculate center position and clamp so the box stays fully within minimap
    const centerX = minimapX + viewCenter.x * scale;
    const centerY = minimapY + viewCenter.y * scale;
    
    // Clamp the center so the full box stays within bounds
    const clampedCenterX = Math.max(minimapX + viewRectW / 2, Math.min(minimapX + minimapSize - viewRectW / 2, centerX));
    const clampedCenterY = Math.max(minimapY + viewRectH / 2, Math.min(minimapY + minimapSize - viewRectH / 2, centerY));
    
    const viewRectX = clampedCenterX - viewRectW / 2;
    const viewRectY = clampedCenterY - viewRectH / 2;
    
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(viewRectX, viewRectY, viewRectW, viewRectH);
  };

  useEffect(() => {
    requestRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(requestRef.current!);
  }, [engine, buildMode, offset]);

  // Helper to navigate camera based on minimap position
  const navigateFromMinimap = (clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const clickX = clientX - rect.left;
    const clickY = clientY - rect.top;
    
    const minimapX = rect.width - minimapSize - minimapPadding;
    const minimapY = rect.height - minimapSize - minimapPadding;
    const scale = minimapSize / MAP_SIZE;
    
    // Calculate viewport size in minimap coordinates (same as drawing code)
    const viewWidth = (rect.width / TILE_SIZE) * 0.7;
    const viewHeight = (rect.height / TILE_SIZE) * 0.7;
    const viewRectW = viewWidth * scale;
    const viewRectH = viewHeight * scale;
    
    // Clamp click position so the viewport box stays within minimap bounds
    // The center of the box should be at the mouse position, but clamped
    const clampedX = Math.max(minimapX + viewRectW / 2, Math.min(minimapX + minimapSize - viewRectW / 2, clickX));
    const clampedY = Math.max(minimapY + viewRectH / 2, Math.min(minimapY + minimapSize - viewRectH / 2, clickY));
    
    // Convert minimap position to world coordinates
    const worldX = (clampedX - minimapX) / scale;
    const worldY = (clampedY - minimapY) / scale;
    
    // Convert world coordinates to isometric screen position and center camera
    const iso = cartToIso(worldX, worldY);
    setOffset({ 
      x: -iso.x, 
      y: -iso.y
    });
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    // Check if click is on minimap
    const minimapX = rect.width - minimapSize - minimapPadding;
    const minimapY = rect.height - minimapSize - minimapPadding;
    
    if (clickX >= minimapX && clickX <= minimapX + minimapSize &&
        clickY >= minimapY && clickY <= minimapY + minimapSize) {
      // Start minimap dragging
      isMinimapDragging.current = true;
      navigateFromMinimap(e.clientX, e.clientY);
      return;
    }
    
    isDragging.current = true;
    lastMousePos.current = { x: e.clientX, y: e.clientY };

    if (buildMode) {
         const centerX = rect.width / 2 + offset.x;
         const centerY = rect.height / 2 + offset.y;
         
         const isoClickX = e.clientX - rect.left - centerX;
         const isoClickY = e.clientY - rect.top - centerY;
         
         const cart = isoToCart(isoClickX, isoClickY);
         onSelectTile(cart.x, cart.y);
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isMinimapDragging.current) {
      navigateFromMinimap(e.clientX, e.clientY);
    } else if (isDragging.current) {
        const dx = e.clientX - lastMousePos.current.x;
        const dy = e.clientY - lastMousePos.current.y;
        setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
        lastMousePos.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseUp = () => {
    isDragging.current = false;
    isMinimapDragging.current = false;
  };

  return (
    <canvas
      ref={canvasRef}
      width={window.innerWidth}
      height={window.innerHeight}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      className="cursor-move"
    />
  );
};

export default GameCanvas;