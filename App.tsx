import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import GameCanvas from './components/GameCanvas';
import { GameEngine } from './services/GameEngine';
import { networkManager } from './services/NetworkManager';
import { UNIT_TYPES, HOUSE_COST, COLORS, MINE_COST, WALL_COST } from './constants';
import { PlayerState, PeerMessage, LobbyPlayer } from './types';

// Generate a simple room ID for sharing
const generateRoomId = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// Available colors for players to choose
const AVAILABLE_COLORS = [
  { name: 'Blue', hex: '#3b82f6' },
  { name: 'Red', hex: '#ef4444' },
  { name: 'Green', hex: '#22c55e' },
  { name: 'Yellow', hex: '#eab308' },
  { name: 'Purple', hex: '#8b5cf6' },
  { name: 'Pink', hex: '#ec4899' },
  { name: 'Cyan', hex: '#06b6d4' },
  { name: 'Orange', hex: '#f97316' },
];

const appVersion = __APP_VERSION__;

const App: React.FC = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [buildMode, setBuildMode] = useState(false);
  const [buildType, setBuildType] = useState<'house' | 'mine' | 'wall'>('house');
  const [roomId, setRoomId] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [isInLobby, setIsInLobby] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [connectedPlayers, setConnectedPlayers] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [localPlayerId, setLocalPlayerId] = useState('p1');
  
  // Lobby state
  const [playerName, setPlayerName] = useState('');
  const [playerColor, setPlayerColor] = useState(AVAILABLE_COLORS[0].hex);
  const [lobbyPlayers, setLobbyPlayers] = useState<LobbyPlayer[]>([]);
  const [isSpectating, setIsSpectating] = useState(false);
  
  // Use ref for engine to allow recreation with player count
  const engineRef = useRef<GameEngine | null>(null);
  
  // Create engine on demand
  const getEngine = () => {
    if (!engineRef.current) {
      engineRef.current = new GameEngine();
    }
    return engineRef.current;
  };
  
  const engine = getEngine();
  
  // Local state to force React re-renders for UI updates (Gold, Pop)
  const [uiState, setUiState] = useState<PlayerState | null>(null);
  const [gameOver, setGameOver] = useState(false);
  const [winner, setWinner] = useState<string | null>(null);
  
  // Refs to allow network listeners to access latest state without re-binding
  const isHostRef = useRef(isHost);
  const isPlayingRef = useRef(isPlaying);
  const localPlayerIdRef = useRef(localPlayerId);
  const lobbyPlayersRef = useRef<LobbyPlayer[]>([]);
  
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { localPlayerIdRef.current = localPlayerId; }, [localPlayerId]);
  useEffect(() => { lobbyPlayersRef.current = lobbyPlayers; }, [lobbyPlayers]);

  // Helper to broadcast lobby state to all players
  const broadcastLobbyState = (players: LobbyPlayer[]) => {
    networkManager.broadcast({
      type: 'ACTION',
      payload: { action: 'lobbySync', players }
    });
  };

  // Set up network message handling - run once on mount
  useEffect(() => {
    networkManager.onConnection((peerId) => {
      console.log('Network: New connection from', peerId);
      setConnectedPlayers(networkManager.getConnectionCount());
      setConnectionStatus('connected');
      
      // If host, assign a player ID to the new player and send it with retry
      if (networkManager.getIsHost()) {
        const assignedPlayerId = networkManager.assignPlayerToPeer(peerId);
        console.log('Network: Assigning', assignedPlayerId, 'to peer', peerId);
        
        // Send player assignment with retries to ensure it arrives
        const sendAssignment = (attempt: number) => {
          console.log('Network: Sending player assignment, attempt', attempt);
          networkManager.sendToPeer(peerId, { 
            type: 'ACTION', 
            payload: { action: 'assignPlayer', playerId: assignedPlayerId } 
          });
          // Retry a few times to ensure delivery
          if (attempt < 3) {
            setTimeout(() => sendAssignment(attempt + 1), 300);
          }
        };
        // Start sending after a delay
        setTimeout(() => sendAssignment(1), 200);
      }
    });

    networkManager.onMessage((peerId, message: PeerMessage) => {
      console.log('Network: Received message from', peerId, message);
      if (message.type === 'SYNC') {
        // Guest receives full state from host
        if (!networkManager.getIsHost() && engineRef.current) {
          Object.assign(engineRef.current.state, message.payload);
        }
      } else if (message.type === 'ACTION') {
        const action = message.payload;
        
        // Handle player assignment (guest receives from host)
        if (action.action === 'assignPlayer') {
          console.log('Network: Received assignment:', action.playerId);
          setLocalPlayerId(action.playerId);
        }
        // Lobby sync - all players receive updated player list
        else if (action.action === 'lobbySync') {
          console.log('Network: Lobby sync received:', action.players);
          setLobbyPlayers(action.players);
        }
        // Guest sends their player info to host
        else if (action.action === 'playerInfo' && networkManager.getIsHost()) {
          console.log('Network: Received player info from', peerId, action);
          const playerId = networkManager.getPlayerIdForPeer(peerId);
          if (playerId) {
            const newPlayer: LobbyPlayer = {
              id: playerId,
              peerId: peerId,
              name: action.name,
              color: action.color,
              isHost: false
            };
            setLobbyPlayers(prev => {
              const updated = [...prev.filter(p => p.id !== playerId), newPlayer];
              // Broadcast updated lobby to all players
              setTimeout(() => broadcastLobbyState(updated), 50);
              return updated;
            });
          }
        }
        // Host receives actions from guests
        else if (action.action === 'spawnUnit' && engineRef.current) {
          console.log('Network: Host spawning unit for', action.playerId);
          engineRef.current.spawnUnit(action.playerId, action.unitType);
        } else if (action.action === 'buildHouse' && engineRef.current) {
          console.log('Network: Host building house for', action.playerId);
          engineRef.current.buildHouse(action.playerId, action.x, action.y);
        } else if (action.action === 'buildMine' && engineRef.current) {
          console.log('Network: Host building mine for', action.playerId);
          engineRef.current.buildMine(action.playerId, action.x, action.y);
        } else if (action.action === 'buildWall' && engineRef.current) {
          console.log('Network: Host building wall for', action.playerId);
          engineRef.current.buildWall(action.playerId, action.x, action.y);
        } else if (action.action === 'removeWall' && engineRef.current) {
          console.log('Network: Host removing wall for', action.playerId);
          engineRef.current.removeWall(action.playerId, action.x, action.y);
        } else if (action.action === 'startGame' && action.playerCount) {
          // Guest receives start game signal from host with player count and their player ID
          console.log('Network: Game starting with', action.playerCount, 'players! Assigned player ID:', action.playerId);
          
          // Set the player ID from the message (backup in case earlier assignment was missed)
          if (action.playerId) {
            setLocalPlayerId(action.playerId);
          }
          
          // Create engine with correct player count for the guest
          engineRef.current = new GameEngine(undefined, action.playerCount, action.lobbyPlayers);
          
          setIsInLobby(false);
          setIsPlaying(true);
        }
      }
    });

    networkManager.onDisconnect((peerId) => {
      console.log('Network: Disconnected from', peerId);
      setConnectedPlayers(networkManager.getConnectionCount());
      if (networkManager.getConnectionCount() === 0) {
        setConnectionStatus('disconnected');
      }
    });

    networkManager.onError((error) => {
      console.error('Network: Error', error);
      setErrorMessage(error.message);
    });

    return () => {
      networkManager.disconnect();
    };
  }, []); // Run only once on mount

  // Sync game state to connected players (host only)
  useEffect(() => {
    if (!isPlaying || !isMultiplayer || !isHost) return;

    const syncInterval = setInterval(() => {
      if (engineRef.current) {
        networkManager.sendSync(engineRef.current.state);
      }
    }, 100); // 10Hz sync rate

    return () => clearInterval(syncInterval);
  }, [isPlaying, isMultiplayer, isHost]);

  useEffect(() => {
    if (!isPlaying) return;

    const interval = setInterval(() => {
        // Sync UI with Engine State
        const player = engine.state.players[localPlayerId];
        setUiState({...player}); // Clone to trigger update
        
        if (engine.state.gameOver) {
            setGameOver(true);
            setWinner(engine.state.winner);
            setIsPlaying(false);
        }
    }, 100); // 10Hz UI update

    return () => clearInterval(interval);
  }, [isPlaying, engine, localPlayerId]);

  // ESC key to cancel build mode
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && buildMode) {
        setBuildMode(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [buildMode]);


  const handleStart = () => {
    setIsPlaying(true);
    setGameOver(false);
    setIsMultiplayer(false);
    setIsHost(false);
    setLocalPlayerId('p1');
    setIsSpectating(false);
    
    // Create solo player with name and color from the lobby input
    const soloPlayer: LobbyPlayer = {
      id: 'p1',
      peerId: 'local',
      name: playerName.trim() || 'Player 1',
      color: playerColor,
      isHost: true
    };
    setLobbyPlayers([soloPlayer]);
    
    // Create new engine with 1 player for solo mode, passing player info
    engineRef.current = new GameEngine(undefined, 1, [soloPlayer]);
  };

  const handleHostGame = async () => {
    if (!playerName.trim()) {
      setErrorMessage('Please enter your name');
      return;
    }
    
    const newRoomId = generateRoomId();
    setRoomId(newRoomId);
    setIsHost(true);
    setLocalPlayerId('p1'); // Host is always p1
    setIsMultiplayer(true);
    setConnectionStatus('connecting');
    setErrorMessage(null);
    
    // Add host to lobby players
    const hostPlayer: LobbyPlayer = {
      id: 'p1',
      peerId: newRoomId,
      name: playerName.trim(),
      color: playerColor,
      isHost: true
    };
    setLobbyPlayers([hostPlayer]);
    
    try {
      await networkManager.hostGame(newRoomId);
      setConnectionStatus('connected');
      setIsInLobby(true);
      setGameOver(false);
    } catch (error: any) {
      setErrorMessage(`Failed to host: ${error.message}`);
      setConnectionStatus('disconnected');
    }
  };

  const handleStartMultiplayerGame = () => {
    // Create engine with correct player count and lobby player info
    const totalPlayers = lobbyPlayers.length;
    engineRef.current = new GameEngine(undefined, totalPlayers, lobbyPlayers);
    
    setIsInLobby(false);
    setIsPlaying(true);
    
    // Send personalized start game message to each player with their player ID and lobby info
    networkManager.sendToEachPeer((peerId, playerId) => ({
      type: 'ACTION',
      payload: { action: 'startGame', playerCount: totalPlayers, playerId: playerId, lobbyPlayers: lobbyPlayers }
    }));
    
    // Small delay to ensure guest creates engine before receiving state
    setTimeout(() => {
      networkManager.sendSync(engineRef.current!.state);
    }, 100);
  };

  const handleCopyRoomId = () => {
    navigator.clipboard.writeText(roomId);
    setCodeCopied(true);
    setTimeout(() => setCodeCopied(false), 2000);
  };

  const handleLeaveLobby = () => {
    networkManager.disconnect();
    setIsInLobby(false);
    setIsMultiplayer(false);
    setIsHost(false);
    setRoomId('');
    setConnectedPlayers(0);
    setConnectionStatus('disconnected');
    setLobbyPlayers([]);
  };

  const handleJoinGame = async () => {
    if (!roomId.trim()) {
      setErrorMessage('Please enter a Room ID');
      return;
    }
    if (!playerName.trim()) {
      setErrorMessage('Please enter your name');
      return;
    }
    
    setIsHost(false);
    setIsMultiplayer(true);
    setConnectionStatus('connecting');
    setErrorMessage(null);
    
    try {
      await networkManager.joinGame(roomId.trim().toUpperCase());
      setConnectionStatus('connected');
      setIsInLobby(true);
      setGameOver(false);
      
      // Send our player info to the host
      setTimeout(() => {
        networkManager.sendAction({
          action: 'playerInfo',
          name: playerName.trim(),
          color: playerColor
        });
      }, 500);
    } catch (error: any) {
      setErrorMessage(`Failed to join: ${error.message}`);
      setConnectionStatus('disconnected');
      setIsMultiplayer(false);
    }
  };

  const handleBuyUnit = (type: keyof typeof UNIT_TYPES) => {
    if (isMultiplayer && !isHost) {
      // Guest sends action to host
      networkManager.sendAction({
        action: 'spawnUnit',
        playerId: localPlayerId,
        unitType: type
      });
    } else {
      engine.spawnUnit(localPlayerId, type);
    }
  };

  const handleToggleBuild = () => {
    setBuildMode(!buildMode);
  };

  const handleTileSelect = (x: number, y: number, remove?: boolean) => {
      if (buildMode) {
          if (buildType === 'house') {
            if (isMultiplayer && !isHost) {
              // Guest sends action to host
              networkManager.sendAction({
                action: 'buildHouse',
                playerId: localPlayerId,
                x,
                y
              });
            } else {
              engine.buildHouse(localPlayerId, x, y);
            }
          } else if (buildType === 'mine') {
            if (isMultiplayer && !isHost) {
              // Guest sends action to host
              networkManager.sendAction({
                action: 'buildMine',
                playerId: localPlayerId,
                x,
                y
              });
            } else {
              engine.buildMine(localPlayerId, x, y);
            }
          } else if (buildType === 'wall') {
            if (remove) {
              if (isMultiplayer && !isHost) {
                networkManager.sendAction({
                  action: 'removeWall',
                  playerId: localPlayerId,
                  x,
                  y
                });
              } else {
                engine.removeWall(localPlayerId, x, y);
              }
            } else {
              if (isMultiplayer && !isHost) {
                // Guest sends action to host
                networkManager.sendAction({
                  action: 'buildWall',
                  playerId: localPlayerId,
                  x,
                  y
                });
              } else {
                engine.buildWall(localPlayerId, x, y);
              }
            }
          }
          // Don't auto-close build mode, let them build multiple
      }
  };

  if (gameOver) {
      return (
        <div className="h-screen w-screen bg-black flex flex-col items-center justify-center text-white font-mono">
            <h1 className="text-6xl mb-4 font-bold text-red-500">{winner === 'PLAYERS' ? 'VICTORY' : 'DEFEAT'}</h1>
            <p className="mb-8">The {winner === 'PLAYERS' ? 'hive was destroyed!' : 'bases were overrun.'}</p>
            <button 
                onClick={handleStart}
                className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold"
            >
                Play Again
            </button>
        </div>
      );
  }

  // Check if local player is defeated but game continues
  const localPlayer = engine.state.players[localPlayerId];
  const isLocalPlayerDefeated = localPlayer?.defeated === true;

  if (isLocalPlayerDefeated && isPlaying && !isSpectating) {
      return (
        <div className="h-screen w-screen bg-black flex flex-col items-center justify-center text-white font-mono relative">
            {/* Show game in background for spectating */}
            <div className="absolute inset-0 opacity-30 pointer-events-none">
              <GameCanvas 
                engine={engine} 
                playerId={localPlayerId} 
                buildMode={false} 
                onSelectTile={() => {}}
                isHost={isHost}
              />
            </div>
            
            <div className="relative z-10 bg-black/80 p-8 rounded-lg border-2 border-red-500 text-center">
              <h1 className="text-5xl mb-4 font-bold text-red-500">YOU WERE DEFEATED</h1>
              <p className="text-xl mb-2 text-gray-300">Your base was destroyed!</p>
              <p className="mb-6 text-gray-400">Your teammates are still fighting!</p>
              
              <div className="flex gap-4 justify-center">
                <button 
                    onClick={() => setIsSpectating(true)}
                    className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold"
                >
                    Spectate
                </button>
                <button 
                    onClick={() => {
                      if (isHost) {
                        if (!confirm('As the host, leaving will end the game for everyone. Are you sure?')) {
                          return;
                        }
                      }
                      setIsPlaying(false);
                      setGameOver(false);
                      setIsMultiplayer(false);
                      setIsSpectating(false);
                      networkManager.disconnect();
                    }}
                    className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded font-bold"
                >
                    Leave Game
                </button>
              </div>
            </div>
        </div>
      );
  }

  // Spectating mode - full screen game view with spectator UI
  if (isSpectating && isPlaying) {
    return (
      <div className="h-screen w-screen relative">
        <GameCanvas 
          engine={engine} 
          playerId={localPlayerId} 
          buildMode={false} 
          onSelectTile={() => {}}
          isHost={isHost}
        />
        
        {/* Spectator overlay */}
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-black/70 px-6 py-2 rounded-lg border border-gray-600">
          <span className="text-white font-mono">👁️ SPECTATING</span>
        </div>
        
        <button 
          onClick={() => {
            if (isHost) {
              if (!confirm('As the host, leaving will end the game for everyone. Are you sure?')) {
                return;
              }
            }
            setIsPlaying(false);
            setGameOver(false);
            setIsMultiplayer(false);
            setIsSpectating(false);
            networkManager.disconnect();
          }}
          className="absolute bottom-4 left-4 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded font-mono text-sm"
        >
          Leave Game
        </button>
      </div>
    );
  }

  // Lobby screen for multiplayer
  if (isInLobby) {
    return (
      <div className="h-screen w-screen bg-neutral-900 flex flex-col items-center justify-center text-white font-mono relative overflow-hidden">
        {/* Background Art */}
        <div className="absolute inset-0 opacity-10 pointer-events-none">
            <div className="absolute top-10 right-10 w-64 h-64 bg-green-900 rounded-full blur-3xl"></div>
            <div className="absolute bottom-10 left-10 w-64 h-64 bg-blue-900 rounded-full blur-3xl"></div>
        </div>

        <h1 className="text-4xl font-bold mb-2 tracking-tighter">MULTIPLAYER LOBBY</h1>
        
        {/* Room Code Display - Different for Host vs Guest */}
        {isHost ? (
          <div className="bg-gray-800 border-2 border-green-500 rounded-lg p-6 mt-6 mb-6">
            <p className="text-sm text-gray-400 text-center mb-2">Share this code with your brothers:</p>
            <div className="flex items-center gap-3">
              <span className="text-4xl font-mono font-bold text-green-400 tracking-widest">{roomId}</span>
              <button 
                onClick={handleCopyRoomId}
                className={`px-4 py-2 rounded font-bold text-sm transition-all ${
                  codeCopied 
                    ? 'bg-green-600 text-white' 
                    : 'bg-gray-700 hover:bg-gray-600 text-gray-300'
                }`}
              >
                {codeCopied ? '✓ COPIED!' : 'COPY'}
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-gray-800 border-2 border-amber-500 rounded-lg p-6 mt-6 mb-6">
            <p className="text-sm text-gray-400 text-center mb-2">Connected to room:</p>
            <span className="text-4xl font-mono font-bold text-amber-400 tracking-widest">{roomId}</span>
          </div>
        )}

        {/* Connected Players */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 mb-6 w-96">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-gray-400">Players ({lobbyPlayers.length}/8)</span>
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
              <span className="text-sm text-green-400">{isHost ? 'Hosting' : 'Connected'}</span>
            </div>
          </div>
          
          {/* Player List */}
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {lobbyPlayers.map((player) => (
              <div 
                key={player.id} 
                className={`flex items-center gap-2 rounded p-2 ${
                  player.id === localPlayerId 
                    ? 'bg-green-500/20 border border-green-500/30' 
                    : 'bg-gray-700/50'
                }`}
              >
                <div 
                  className="w-4 h-4 rounded-full border-2 border-white/30" 
                  style={{ backgroundColor: player.color }}
                ></div>
                <span className="text-sm font-bold flex-1">
                  {player.name}
                  {player.isHost && <span className="text-xs text-yellow-400 ml-2">(Host)</span>}
                  {player.id === localPlayerId && <span className="text-xs text-green-400 ml-2">(You)</span>}
                </span>
                <span className="text-xs text-gray-400">{player.id.toUpperCase()}</span>
              </div>
            ))}
            {lobbyPlayers.length < 8 && (
              <div className="flex items-center gap-2 bg-gray-800/50 border border-dashed border-gray-600 rounded p-2 opacity-50">
                <div className="w-4 h-4 rounded-full bg-gray-600"></div>
                <span className="text-sm text-gray-500">Waiting for player...</span>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col gap-3 w-72">
          {isHost ? (
            <button 
              onClick={handleStartMultiplayerGame}
              disabled={lobbyPlayers.length < 2}
              className={`w-full py-4 font-bold rounded shadow-[0_4px_0_rgb(22,101,52)] active:shadow-none active:translate-y-1 transition-all ${
                lobbyPlayers.length >= 2 
                  ? 'bg-green-600 hover:bg-green-500 text-white' 
                  : 'bg-gray-700 text-gray-500 cursor-not-allowed shadow-none'
              }`}
            >
              {lobbyPlayers.length >= 2 ? 'START GAME' : 'WAITING FOR PLAYERS...'}
            </button>
          ) : (
            <div className="w-full py-4 bg-gray-700 text-gray-400 font-bold rounded text-center">
              <span className="animate-pulse">Waiting for host to start...</span>
            </div>
          )}
          
          <button 
            onClick={handleLeaveLobby}
            className="w-full py-2 bg-gray-700 hover:bg-gray-600 text-gray-300 font-bold rounded text-sm"
          >
            LEAVE LOBBY
          </button>
        </div>

        {/* Error Message */}
        {errorMessage && (
          <p className="text-xs text-red-400 text-center mt-4">
            {errorMessage}
          </p>
        )}
      </div>
    );
  }

  if (!isPlaying) {
    return (
      <div className="h-screen w-screen bg-neutral-900 flex flex-col items-center justify-center text-white font-mono relative overflow-hidden">
        {/* Background Art */}
        <div className="absolute inset-0 opacity-10 pointer-events-none">
            <div className="absolute top-10 right-10 w-64 h-64 bg-green-900 rounded-full blur-3xl"></div>
            <div className="absolute bottom-10 left-10 w-64 h-64 bg-blue-900 rounded-full blur-3xl"></div>
        </div>

        <h1 className="text-5xl font-bold mb-2 tracking-tighter">ISO<span className="text-blue-500">DEFEND</span></h1>
        <p className="text-gray-400 mb-8 max-w-md text-center">
            Defend your base. Build houses to expand your army. Destroy the Zombie Hive.
        </p>

        <div className="flex flex-col gap-4 w-80">
             <button 
                onClick={handleStart}
                className="w-full py-4 bg-blue-600 hover:bg-blue-500 text-white font-bold rounded shadow-[0_4px_0_rgb(29,78,216)] active:shadow-none active:translate-y-1 transition-all"
            >
                START SOLO
            </button>
            <div className="h-px bg-gray-700 my-2"></div>
            
            {/* Player Name Input */}
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Your Name</label>
              <input 
                type="text" 
                placeholder="Enter your name" 
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                maxLength={16}
                className="w-full bg-gray-800 border border-gray-700 px-3 py-2 text-sm rounded text-white"
              />
            </div>
            
            {/* Color Selection */}
            <div>
              <label className="text-xs text-gray-400 mb-1 block">Your Color</label>
              <div className="flex gap-2 flex-wrap">
                {AVAILABLE_COLORS.map((color) => (
                  <button
                    key={color.hex}
                    onClick={() => setPlayerColor(color.hex)}
                    className={`w-8 h-8 rounded-full border-2 transition-all ${
                      playerColor === color.hex 
                        ? 'border-white scale-110' 
                        : 'border-gray-600 hover:border-gray-400'
                    }`}
                    style={{ backgroundColor: color.hex }}
                    title={color.name}
                  />
                ))}
              </div>
            </div>
            
            {/* Host Game */}
            <button 
                onClick={handleHostGame}
                disabled={connectionStatus === 'connecting'}
                className="w-full py-3 bg-green-600 hover:bg-green-500 disabled:bg-gray-600 text-white font-bold rounded shadow-[0_4px_0_rgb(22,101,52)] active:shadow-none active:translate-y-1 transition-all"
            >
                {connectionStatus === 'connecting' ? 'CREATING...' : 'HOST MULTIPLAYER'}
            </button>
            
            {/* Join Game */}
            <div className="flex gap-2">
                 <input 
                    type="text" 
                    placeholder="Enter Room ID" 
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value.toUpperCase())}
                    className="bg-gray-800 border border-gray-700 px-3 py-2 text-sm flex-1 rounded text-white uppercase"
                 />
                 <button 
                    onClick={handleJoinGame}
                    disabled={connectionStatus === 'connecting'}
                    className="bg-amber-600 hover:bg-amber-500 disabled:bg-gray-600 px-4 py-2 text-sm rounded text-white font-bold"
                 >
                    JOIN
                 </button>
            </div>
            
            {/* Error Message */}
            {errorMessage && (
              <p className="text-xs text-red-400 text-center">
                {errorMessage}
              </p>
            )}
            
            <p className="text-xs text-gray-500 text-center mt-2">
                Enter your name, pick a color, then host or join a game!
            </p>
        </div>

        <div className="absolute bottom-3 right-4 text-[10px] text-gray-500/80">
          v{appVersion}
        </div>
      </div>
    );
  }

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-black font-mono">
      <GameCanvas 
        engine={engine} 
        playerId={localPlayerId} 
        buildMode={buildMode}
        buildType={buildType}
        onSelectTile={handleTileSelect}
        isHost={isHost || !isMultiplayer}
      />

      {/* UI Overlay */}
      <div className="absolute top-0 left-0 w-full p-4 pointer-events-none flex justify-between items-start">
        {/* Resources */}
        <div className="bg-gray-900/80 backdrop-blur border border-gray-700 p-4 rounded-lg pointer-events-auto shadow-lg text-white">
            <div className="flex items-center gap-4 mb-2">
                <div className="flex flex-col">
                    <span className="text-xs text-gray-400 uppercase">Gold</span>
                    <span className="text-2xl font-bold text-yellow-400">${uiState?.gold || 0}</span>
                </div>
                <div className="w-px h-8 bg-gray-700"></div>
                <div className="flex flex-col">
                    <span className="text-xs text-gray-400 uppercase">Population</span>
                    <span className={`text-2xl font-bold ${(uiState?.currentPop || 0) >= (uiState?.maxPop || 0) ? 'text-red-500' : 'text-blue-400'}`}>
                        {uiState?.currentPop}/{uiState?.maxPop}
                    </span>
                </div>
            </div>
            <div className="text-xs text-gray-500">
                +${50} in 20s
            </div>
        </div>

        {/* Multiplayer Status */}
        {isMultiplayer && (
          <div className="bg-gray-900/80 backdrop-blur border border-gray-700 p-3 rounded-lg shadow-lg text-white">
            <div className="flex items-center gap-2 mb-1">
              <div className={`w-2 h-2 rounded-full ${connectionStatus === 'connected' ? 'bg-green-500' : connectionStatus === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'}`}></div>
              <span className="text-xs font-bold uppercase">
                {isHost ? 'Hosting' : 'Connected'}
              </span>
            </div>
            {isHost && (
              <div className="text-xs">
                <span className="text-gray-400">Room: </span>
                <span className="text-green-400 font-mono font-bold">{roomId}</span>
              </div>
            )}
            <div className="text-xs text-gray-400 mt-1">
              {connectedPlayers} player{connectedPlayers !== 1 ? 's' : ''} connected
            </div>
          </div>
        )}

        {/* Objective */}
        <div className="bg-red-900/50 border border-red-500/30 p-2 rounded text-red-200 text-sm font-bold animate-pulse">
            DESTROY THE HIVE (TOP RIGHT)
        </div>
      </div>

      {/* Action Bar */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 bg-gray-900/90 backdrop-blur border border-gray-700 p-2 rounded-xl flex items-end gap-2 pointer-events-auto shadow-2xl">
          {/* Unit Buttons */}
          <UnitButton 
            name="Soldier" 
            cost={UNIT_TYPES.SOLDIER.cost} 
            color="bg-blue-500" 
            onClick={() => handleBuyUnit('SOLDIER')}
            disabled={(uiState?.gold || 0) < UNIT_TYPES.SOLDIER.cost || (uiState?.currentPop || 0) >= (uiState?.maxPop || 0)}
          />
          <UnitButton 
            name="Tank" 
            cost={UNIT_TYPES.TANK.cost} 
            color="bg-indigo-600" 
            onClick={() => handleBuyUnit('TANK')}
            disabled={(uiState?.gold || 0) < UNIT_TYPES.TANK.cost || (uiState?.currentPop || 0) >= (uiState?.maxPop || 0)}
          />

          <div className="w-px h-10 bg-gray-700 mx-2"></div>

          {/* Build House Button */}
          <button 
            onClick={() => { setBuildType('house'); setBuildMode(true); }}
            className={`
                relative w-20 h-20 rounded-lg flex flex-col items-center justify-center border-2 transition-all
                ${buildMode && buildType === 'house'
                    ? 'bg-amber-600/50 border-amber-500 text-white -translate-y-2 shadow-[0_0_15px_rgba(245,158,11,0.5)]' 
                    : 'bg-gray-800 border-gray-600 hover:bg-gray-700 text-gray-300'
                }
            `}
          >
            <div className="text-xs font-bold mb-1">HOUSE</div>
            <div className="text-xs text-yellow-400">${HOUSE_COST}</div>
            <div className="text-[10px] text-gray-400 mt-1">+5 POP</div>
          </button>

          {/* Build Mine Button */}
          <button 
            onClick={() => { setBuildType('mine'); setBuildMode(true); }}
            className={`
                relative w-20 h-20 rounded-lg flex flex-col items-center justify-center border-2 transition-all
                ${buildMode && buildType === 'mine'
                    ? 'bg-yellow-600/50 border-yellow-500 text-white -translate-y-2 shadow-[0_0_15px_rgba(234,179,8,0.5)]' 
                    : 'bg-gray-800 border-gray-600 hover:bg-gray-700 text-gray-300'
                }
            `}
            disabled={(uiState?.gold || 0) < MINE_COST}
          >
            <div className="text-xs font-bold mb-1">MINE</div>
            <div className="text-xs text-yellow-400">${MINE_COST}</div>
            <div className="text-[10px] text-gray-400 mt-1">+50 GOLD</div>
          </button>

          {/* Build Wall Button */}
          <button 
            onClick={() => { setBuildType('wall'); setBuildMode(true); }}
            className={`
                relative w-20 h-20 rounded-lg flex flex-col items-center justify-center border-2 transition-all
                ${buildMode && buildType === 'wall'
                    ? 'bg-gray-600/50 border-gray-500 text-white -translate-y-2 shadow-[0_0_15px_rgba(107,114,128,0.5)]' 
                    : 'bg-gray-800 border-gray-600 hover:bg-gray-700 text-gray-300'
                }
            `}
            disabled={(uiState?.gold || 0) < WALL_COST}
          >
            <div className="text-xs font-bold mb-1">WALL</div>
            <div className="text-xs text-yellow-400">${WALL_COST}</div>
            <div className="text-[10px] text-gray-400 mt-1">DEFENSE</div>
          </button>
      </div>

      {/* Build Mode Instructions */}
      {buildMode && (
          <div className="absolute bottom-32 left-1/2 -translate-x-1/2 bg-black/70 px-4 py-2 rounded text-white text-sm pointer-events-none">
              Click on the grid near your base to build a {buildType}. Shift-click or right-click to remove walls. Press ESC to cancel.
          </div>
      )}
    </div>
  );
};

interface UnitButtonProps {
    name: string;
    cost: number;
    color: string;
    onClick: () => void;
    disabled: boolean;
}

const UnitButton: React.FC<UnitButtonProps> = ({ name, cost, color, onClick, disabled }) => (
    <button 
        onClick={onClick}
        disabled={disabled}
        className={`
            w-16 h-16 rounded-lg flex flex-col items-center justify-center border-b-4 transition-all
            ${disabled 
                ? 'bg-gray-800 border-gray-700 text-gray-600 cursor-not-allowed' 
                : `${color} border-black/20 hover:brightness-110 active:border-b-0 active:translate-y-1 text-white`
            }
        `}
    >
        <span className="text-[10px] font-bold">{name}</span>
        <span className="text-xs">${cost}</span>
    </button>
);

export default App;
