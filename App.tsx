import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import GameCanvas from './components/GameCanvas';
import { GameEngine } from './services/GameEngine';
import { networkManager } from './services/NetworkManager';
import { UNIT_TYPES, HOUSE_COST, COLORS, MINE_COST, WALL_COST, FIRE_WALL_COST } from './constants';
import { PlayerState, PeerMessage, LobbyPlayer, GameOptions } from './types';

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

const DEFAULT_GAME_OPTIONS: GameOptions = {
  gameMode: 'coop',
  difficulty: 'normal',
  fogOfWar: false
};

const App: React.FC = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [buildMode, setBuildMode] = useState(false);
  const [buildType, setBuildType] = useState<'house' | 'mine' | 'wall' | 'fire'>('house');
  const [roomId, setRoomId] = useState('');
  const [isHost, setIsHost] = useState(false);
  const [isMultiplayer, setIsMultiplayer] = useState(false);
  const [isInLobby, setIsInLobby] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [connectedPlayers, setConnectedPlayers] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [codeCopied, setCodeCopied] = useState(false);
  const [localPlayerId, setLocalPlayerId] = useState('p1');
  const [showSettings, setShowSettings] = useState(false);
  const [showSoloOptions, setShowSoloOptions] = useState(false);
  const [gameOptions, setGameOptions] = useState<GameOptions>(DEFAULT_GAME_OPTIONS);
  
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
  const gameOptionsRef = useRef<GameOptions>(gameOptions);
  
  useEffect(() => { isHostRef.current = isHost; }, [isHost]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { localPlayerIdRef.current = localPlayerId; }, [localPlayerId]);
  useEffect(() => { lobbyPlayersRef.current = lobbyPlayers; }, [lobbyPlayers]);
  useEffect(() => { gameOptionsRef.current = gameOptions; }, [gameOptions]);

  // Helper to broadcast lobby state to all players
  const broadcastLobbyState = (players: LobbyPlayer[], options: GameOptions = gameOptionsRef.current) => {
    networkManager.broadcast({
      type: 'ACTION',
      payload: { action: 'lobbySync', players, options }
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
          if (action.options) {
            setGameOptions(action.options);
          }
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
              isHost: false,
              team: getDefaultTeamForId(playerId, gameOptionsRef.current.gameMode)
            };
            setLobbyPlayers(prev => {
              const updated = applyTeamDefaults([...prev.filter(p => p.id !== playerId), newPlayer], gameOptionsRef.current.gameMode);
              // Broadcast updated lobby to all players
              setTimeout(() => broadcastLobbyState(updated, gameOptionsRef.current), 50);
              return updated;
            });
          }
        }
        else if (action.action === 'updateTeam' && networkManager.getIsHost()) {
          const { playerId, team } = action;
          if (!playerId || !team) return;
          setLobbyPlayers(prev => {
            const updated = prev.map(p => (p.id === playerId ? { ...p, team } : p));
            setTimeout(() => broadcastLobbyState(updated, gameOptionsRef.current), 50);
            return updated;
          });
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
        } else if (action.action === 'buildFireWall' && engineRef.current) {
          console.log('Network: Host building firewall for', action.playerId);
          engineRef.current.buildFireWall(action.playerId, action.x, action.y);
        } else if (action.action === 'removeWall' && engineRef.current) {
          console.log('Network: Host removing wall for', action.playerId);
          engineRef.current.removeWall(action.playerId, action.x, action.y);
        } else if (action.action === 'requestPause' && networkManager.getIsHost()) {
          console.log('Network: Pause requested by', action.playerId);
          handleSetPaused(true);
        } else if (action.action === 'requestResume' && networkManager.getIsHost()) {
          console.log('Network: Resume requested by', action.playerId);
          handleSetPaused(false);
        } else if (action.action === 'requestRematch' && networkManager.getIsHost()) {
          console.log('Network: Rematch requested by', action.playerId);
          handleRematchHost();
        } else if (action.action === 'startGame' && action.playerCount) {
          // Guest receives start game signal from host with player count and their player ID
          console.log('Network: Game starting with', action.playerCount, 'players! Assigned player ID:', action.playerId);
          
          // Set the player ID from the message (backup in case earlier assignment was missed)
          if (action.playerId) {
            setLocalPlayerId(action.playerId);
          }
          
          // Create engine with correct player count for the guest
          engineRef.current = new GameEngine(undefined, action.playerCount, action.lobbyPlayers, action.options);
          engineRef.current.state.paused = false;
          
          setIsInLobby(false);
          setIsPlaying(true);
          setGameOver(false);
          setWinner(null);
          setIsSpectating(false);
          setBuildMode(false);
          setBuildType('house');
        } else if (action.action === 'rematch' && action.playerCount) {
          console.log('Network: Rematch starting with', action.playerCount, 'players! Assigned player ID:', action.playerId);

          if (action.playerId) {
            setLocalPlayerId(action.playerId);
          }

          engineRef.current = new GameEngine(undefined, action.playerCount, action.lobbyPlayers, action.options);
          engineRef.current.state.paused = false;
          setIsInLobby(false);
          setIsPlaying(true);
          setGameOver(false);
          setWinner(null);
          setIsSpectating(false);
          setBuildMode(false);
          setBuildType('house');
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

  const getDefaultTeamForId = (playerId: string, mode: GameOptions['gameMode']) => {
    if (mode !== 'pvp') return 1;
    const idNum = Number(playerId.replace('p', ''));
    return Number.isNaN(idNum) || idNum <= 0 ? 1 : idNum;
  };

  const applyTeamDefaults = (players: LobbyPlayer[], mode: GameOptions['gameMode']) => {
    return players.map((player, index) => {
      if (mode !== 'pvp') {
        return { ...player, team: 1 };
      }
      const fallback = getDefaultTeamForId(player.id, mode) || (index + 1);
      return { ...player, team: player.team ?? fallback };
    });
  };

  const updateLobbyOptions = (partial: Partial<GameOptions>) => {
    const next = { ...gameOptionsRef.current, ...partial };
    setGameOptions(next);
    if (!isInLobby || !isHost) return;
    setLobbyPlayers(prev => {
      const updatedPlayers = partial.gameMode ? applyTeamDefaults(prev, partial.gameMode) : prev;
      setTimeout(() => broadcastLobbyState(updatedPlayers, next), 50);
      return updatedPlayers;
    });
  };

  const handleCycleTeam = (playerId: string) => {
    const players = lobbyPlayersRef.current.length ? lobbyPlayersRef.current : lobbyPlayers;
    const current = players.find(p => p.id === playerId);
    const currentTeam = current?.team ?? getDefaultTeamForId(playerId, gameOptions.gameMode);
    const nextTeam = currentTeam >= 8 ? 1 : currentTeam + 1;

    if (isHost) {
      setLobbyPlayers(prev => {
        const updated = prev.map(p => (p.id === playerId ? { ...p, team: nextTeam } : p));
        setTimeout(() => broadcastLobbyState(updated, gameOptionsRef.current), 50);
        return updated;
      });
    } else {
      networkManager.sendAction({ action: 'updateTeam', playerId, team: nextTeam });
    }
  };

  const handleOpenSoloOptions = () => {
    setGameOptions(prev => ({ ...prev, gameMode: 'coop' }));
    setShowSoloOptions(true);
  };

  const handleStartSolo = () => {
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
      isHost: true,
      team: 1
    };
    setLobbyPlayers([soloPlayer]);
    
    // Create new engine with 1 player for solo mode, passing player info
    const soloOptions: GameOptions = { ...gameOptionsRef.current, gameMode: 'coop' };
    engineRef.current = new GameEngine(undefined, 1, [soloPlayer], soloOptions);
    engineRef.current.state.paused = false;
    setShowSoloOptions(false);
  };

  const handleQuitToMenu = () => {
    if (isHost && isMultiplayer) {
      if (!confirm('As the host, leaving will end the game for everyone. Are you sure?')) {
        return;
      }
    }
    setShowSettings(false);
    setIsPlaying(false);
    setGameOver(false);
    setWinner(null);
    setIsMultiplayer(false);
    setIsHost(false);
    setIsInLobby(false);
    setIsSpectating(false);
    setBuildMode(false);
    setBuildType('house');
    setRoomId('');
    setConnectedPlayers(0);
    setConnectionStatus('disconnected');
    setLobbyPlayers([]);
    setLocalPlayerId('p1');
    setShowSoloOptions(false);
    setGameOptions(DEFAULT_GAME_OPTIONS);
    networkManager.disconnect();
  };

  const startRematch = (players: LobbyPlayer[], options: GameOptions) => {
    const totalPlayers = players.length;
    engineRef.current = new GameEngine(undefined, totalPlayers, players, options);
    engineRef.current.state.paused = false;
    setIsInLobby(false);
    setIsPlaying(true);
    setGameOver(false);
    setWinner(null);
    setIsSpectating(false);
    setBuildMode(false);
    setBuildType('house');
  };

  const handleRematchHost = () => {
    const players = lobbyPlayersRef.current.length ? lobbyPlayersRef.current : lobbyPlayers;
    const options = gameOptionsRef.current;
    startRematch(players, options);

    networkManager.sendToEachPeer((peerId, playerId) => ({
      type: 'ACTION',
      payload: {
        action: 'rematch',
        playerCount: players.length,
        playerId,
        lobbyPlayers: players,
        options
      }
    }));

    setTimeout(() => {
      if (engineRef.current) {
        networkManager.sendSync(engineRef.current.state);
      }
    }, 100);
  };

  const handleRematchRequest = () => {
    if (isHost) {
      handleRematchHost();
      return;
    }
    networkManager.sendAction({ action: 'requestRematch', playerId: localPlayerId });
  };

  const handleSetPaused = (paused: boolean) => {
    if (!engineRef.current) return;
    engineRef.current.state.paused = paused;
    if (isMultiplayer) {
      networkManager.sendSync(engineRef.current.state);
    }
  };

  const handlePauseToggle = (paused: boolean) => {
    if (isMultiplayer && !isHost) {
      networkManager.sendAction({ action: paused ? 'requestPause' : 'requestResume', playerId: localPlayerId });
      return;
    }
    handleSetPaused(paused);
  };

  const handleHostGame = async () => {
    if (!playerName.trim()) {
      setErrorMessage('Please enter your name');
      return;
    }
    setShowSoloOptions(false);
    
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
      isHost: true,
      team: getDefaultTeamForId('p1', gameOptionsRef.current.gameMode)
    };
    setLobbyPlayers(applyTeamDefaults([hostPlayer], gameOptionsRef.current.gameMode));
    
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
    engineRef.current = new GameEngine(undefined, totalPlayers, lobbyPlayers, gameOptionsRef.current);
    engineRef.current.state.paused = false;
    
    setIsInLobby(false);
    setIsPlaying(true);
    
    // Send personalized start game message to each player with their player ID and lobby info
    networkManager.sendToEachPeer((peerId, playerId) => ({
      type: 'ACTION',
      payload: { action: 'startGame', playerCount: totalPlayers, playerId: playerId, lobbyPlayers: lobbyPlayers, options: gameOptionsRef.current }
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
    setGameOptions(DEFAULT_GAME_OPTIONS);
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
    setShowSoloOptions(false);
    
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
          } else if (buildType === 'fire') {
            if (isMultiplayer && !isHost) {
              networkManager.sendAction({
                action: 'buildFireWall',
                playerId: localPlayerId,
                x,
                y
              });
            } else {
              engine.buildFireWall(localPlayerId, x, y);
            }
          }
          // Don't auto-close build mode, let them build multiple
      }
  };

  if (gameOver) {
      const mode = engine.state.options?.gameMode;
      const fallbackTeamRaw = Number(localPlayerId.replace('p', ''));
      const fallbackTeam = Number.isNaN(fallbackTeamRaw) || fallbackTeamRaw <= 0 ? 1 : fallbackTeamRaw;
      const localTeam = engine.state.players[localPlayerId]?.team ?? fallbackTeam;
      const winningTeam = winner && winner.startsWith('TEAM ') ? Number(winner.replace('TEAM ', '')) : null;
      const isLocalTeamWinner = winningTeam !== null && localTeam === winningTeam;
      const isPlayersWin = winner === 'PLAYERS';
      const isVictory = mode === 'pvp' ? isLocalTeamWinner : isPlayersWin;
      const headline = isVictory ? 'VICTORY' : 'DEFEAT';
      const subtext = mode === 'pvp'
        ? (isVictory ? `Team ${winningTeam} wins!` : 'Your team was eliminated.')
        : (isPlayersWin ? 'The hive was destroyed!' : 'bases were overrun.');

      return (
        <div className="h-screen w-screen bg-black flex flex-col items-center justify-center text-white font-mono">
            <h1 className={`text-6xl mb-4 font-bold ${isVictory ? 'text-green-500' : 'text-red-500'}`}>{headline}</h1>
            <p className="mb-8">{subtext}</p>
            <div className="flex gap-4">
              <button 
                  onClick={isMultiplayer ? handleRematchRequest : handleStartSolo}
                  className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold"
              >
                  {isMultiplayer ? (isHost ? 'Rematch' : 'Request Rematch') : 'Play Again'}
              </button>
              <button 
                  onClick={handleQuitToMenu}
                  className="px-6 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded font-bold"
              >
                  Quit to Menu
              </button>
            </div>
        </div>
      );
  }

  // Check if local player is defeated but game continues
  const localPlayer = engine.state.players[localPlayerId];
  const isLocalPlayerDefeated = localPlayer?.defeated === true;
  const isPaused = !!engine.state.paused;
  const isPvpMode = engine.state.options?.gameMode === 'pvp';
  const objectiveText = isPvpMode ? 'ELIMINATE OTHER TEAMS' : 'DESTROY THE HIVE (TOP RIGHT)';

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
              <p className="mb-6 text-gray-400">{isPvpMode ? 'Your team is still fighting!' : 'Your teammates are still fighting!'}</p>
              
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

        {/* Game Options */}
        <div className="bg-gray-800/50 border border-gray-700 rounded-lg p-4 mb-6 w-96">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-gray-400">Game Options</span>
            {!isHost && <span className="text-xs text-gray-500">Host only</span>}
          </div>
          <div className="space-y-3">
            <div>
              <div className="text-[10px] text-gray-400 mb-1">Mode</div>
              <div className="flex gap-2">
                <button
                  onClick={() => updateLobbyOptions({ gameMode: 'coop' })}
                  disabled={!isHost}
                  className={`px-3 py-1 rounded text-xs font-bold border transition-all ${
                    gameOptions.gameMode === 'coop'
                      ? 'bg-blue-600/60 border-blue-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
                  } ${!isHost ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  CO-OP
                </button>
                <button
                  onClick={() => updateLobbyOptions({ gameMode: 'pvp' })}
                  disabled={!isHost}
                  className={`px-3 py-1 rounded text-xs font-bold border transition-all ${
                    gameOptions.gameMode === 'pvp'
                      ? 'bg-rose-600/60 border-rose-500 text-white'
                      : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
                  } ${!isHost ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  PVP
                </button>
              </div>
            </div>

            <div>
              <div className="text-[10px] text-gray-400 mb-1">Difficulty</div>
              <div className="flex gap-2">
                {(['normal', 'elite', 'legendary'] as GameOptions['difficulty'][]).map(level => (
                  <button
                    key={level}
                    onClick={() => updateLobbyOptions({ difficulty: level })}
                    disabled={!isHost}
                    className={`px-3 py-1 rounded text-xs font-bold uppercase border transition-all ${
                      gameOptions.difficulty === level
                        ? 'bg-amber-600/60 border-amber-500 text-white'
                        : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
                    } ${!isHost ? 'opacity-60 cursor-not-allowed' : ''}`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] text-gray-400">Fog of War</div>
                <div className="text-[10px] text-gray-500">Team visibility only.</div>
              </div>
              <button
                onClick={() => updateLobbyOptions({ fogOfWar: !gameOptions.fogOfWar })}
                disabled={!isHost}
                className={`w-12 h-6 rounded-full border transition-all ${
                  gameOptions.fogOfWar ? 'bg-emerald-600 border-emerald-500' : 'bg-gray-700 border-gray-600'
                } ${!isHost ? 'opacity-60 cursor-not-allowed' : ''}`}
              >
                <span className={`block w-5 h-5 bg-white rounded-full transition-transform ${
                  gameOptions.fogOfWar ? 'translate-x-6' : 'translate-x-1'
                }`}></span>
              </button>
            </div>
          </div>
        </div>

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
                {gameOptions.gameMode === 'pvp' && (
                  <button
                    onClick={() => handleCycleTeam(player.id)}
                    disabled={player.id !== localPlayerId}
                    className={`w-7 h-7 rounded border text-xs font-bold ${
                      player.id === localPlayerId
                        ? 'bg-gray-800 border-gray-600 text-white hover:bg-gray-700'
                        : 'bg-gray-900 border-gray-800 text-gray-500 cursor-not-allowed'
                    }`}
                    title={player.id === localPlayerId ? 'Click to change team' : 'Only the player can change their team'}
                  >
                    {player.team ?? getDefaultTeamForId(player.id, gameOptions.gameMode)}
                  </button>
                )}
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
    if (showSoloOptions) {
      return (
        <div className="h-screen w-screen bg-neutral-900 flex flex-col items-center justify-center text-white font-mono relative overflow-hidden">
          <div className="absolute inset-0 opacity-10 pointer-events-none">
            <div className="absolute top-10 right-10 w-64 h-64 bg-emerald-900 rounded-full blur-3xl"></div>
            <div className="absolute bottom-10 left-10 w-64 h-64 bg-blue-900 rounded-full blur-3xl"></div>
          </div>

          <h1 className="text-4xl font-bold mb-2 tracking-tight">SOLO OPTIONS</h1>
          <p className="text-gray-400 mb-6">Choose your settings before starting.</p>

          <div className="bg-gray-800/60 border border-gray-700 rounded-xl p-5 w-96 space-y-5">
            <div>
              <div className="text-xs text-gray-400 mb-2">Difficulty</div>
              <div className="flex gap-2">
                {(['normal', 'elite', 'legendary'] as GameOptions['difficulty'][]).map(level => (
                  <button
                    key={level}
                    onClick={() => setGameOptions(prev => ({ ...prev, difficulty: level }))}
                    className={`px-3 py-2 rounded text-xs font-bold uppercase border transition-all ${
                      gameOptions.difficulty === level
                        ? 'bg-amber-600/60 border-amber-500 text-white'
                        : 'bg-gray-800 border-gray-700 text-gray-300 hover:bg-gray-700'
                    }`}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs text-gray-400">Fog of War</div>
                <div className="text-[10px] text-gray-500">Only reveal areas near your forces.</div>
              </div>
              <button
                onClick={() => setGameOptions(prev => ({ ...prev, fogOfWar: !prev.fogOfWar }))}
                className={`w-14 h-7 rounded-full border transition-all ${
                  gameOptions.fogOfWar ? 'bg-emerald-600 border-emerald-500' : 'bg-gray-700 border-gray-600'
                }`}
              >
                <span className={`block w-6 h-6 bg-white rounded-full transition-transform ${
                  gameOptions.fogOfWar ? 'translate-x-7' : 'translate-x-1'
                }`}></span>
              </button>
            </div>
          </div>

          <div className="flex gap-3 mt-6">
            <button
              onClick={() => setShowSoloOptions(false)}
              className="px-5 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded font-bold"
            >
              Back
            </button>
            <button
              onClick={handleStartSolo}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded font-bold"
            >
              Start Game
            </button>
          </div>
        </div>
      );
    }

    return (
      <div className="h-screen w-screen bg-neutral-900 flex flex-col items-center justify-center text-white font-mono relative overflow-hidden">
        {/* Background Art */}
        <div className="absolute inset-0 opacity-10 pointer-events-none">
            <div className="absolute top-10 right-10 w-64 h-64 bg-green-900 rounded-full blur-3xl"></div>
            <div className="absolute bottom-10 left-10 w-64 h-64 bg-blue-900 rounded-full blur-3xl"></div>
        </div>

        <h1 className="text-5xl font-bold mb-2 tracking-tighter">WORLD<span className="text-blue-500">'S END</span></h1>
        <p className="text-gray-400 mb-8 max-w-md text-center">
            Defend your base. Build houses to expand your army. Destroy the Zombie Hive.
        </p>

        <div className="flex flex-col gap-4 w-80">
             <button 
                onClick={handleOpenSoloOptions}
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
      <div className="absolute top-0 left-0 w-full p-4 pointer-events-none flex flex-wrap justify-between items-start gap-4">
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
        <div className="flex items-center gap-2 pointer-events-auto">
          <div className="bg-red-900/50 border border-red-500/30 p-2 rounded text-red-200 text-sm font-bold animate-pulse">
              {objectiveText}
          </div>
          <button
            onClick={() => setShowSettings(true)}
            className="bg-gray-900/80 backdrop-blur border border-gray-700 p-2 rounded text-gray-200 hover:text-white hover:bg-gray-800 transition-colors"
            aria-label="Open settings"
            title="Settings"
          >
            <svg viewBox="0 0 24 24" className="w-5 h-5 fill-current" aria-hidden="true">
              <path d="M19.14 12.94a7.32 7.32 0 0 0 .05-.94 7.32 7.32 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.26 7.26 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7.26 7.26 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.7 7.86a.5.5 0 0 0 .12.64l2.03 1.58a7.32 7.32 0 0 0-.05.94 7.32 7.32 0 0 0 .05.94L2.82 14.5a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96a7.26 7.26 0 0 0 1.63.94l.36 2.54a.5.5 0 0 0 .5.42h3.84a.5.5 0 0 0 .5-.42l.36-2.54a7.26 7.26 0 0 0 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z" />
            </svg>
          </button>
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
            disabled={
              (uiState?.gold || 0) < UNIT_TYPES.SOLDIER.cost ||
              (uiState?.currentPop || 0) + (UNIT_TYPES.SOLDIER.popCost ?? 1) > (uiState?.maxPop || 0)
            }
          />
          <UnitButton 
            name="Tank" 
            cost={UNIT_TYPES.TANK.cost} 
            color="bg-indigo-600" 
            onClick={() => handleBuyUnit('TANK')}
            disabled={
              (uiState?.gold || 0) < UNIT_TYPES.TANK.cost ||
              (uiState?.currentPop || 0) + (UNIT_TYPES.TANK.popCost ?? 1) > (uiState?.maxPop || 0)
            }
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

          {/* Build Firewall Button */}
          <button 
            onClick={() => { setBuildType('fire'); setBuildMode(true); }}
            className={`
                relative w-20 h-20 rounded-lg flex flex-col items-center justify-center border-2 transition-all
                ${buildMode && buildType === 'fire'
                    ? 'bg-orange-600/50 border-orange-500 text-white -translate-y-2 shadow-[0_0_15px_rgba(249,115,22,0.5)]' 
                    : 'bg-gray-800 border-gray-600 hover:bg-gray-700 text-gray-300'
                }
            `}
            disabled={(uiState?.gold || 0) < FIRE_WALL_COST}
          >
            <div className="text-xs font-bold mb-1">FIREWALL</div>
            <div className="text-xs text-yellow-400">${FIRE_WALL_COST}</div>
            <div className="text-[10px] text-gray-400 mt-1">BURN</div>
          </button>
      </div>

      {/* Build Mode Instructions */}
      {buildMode && (
          <div className="absolute bottom-32 left-1/2 -translate-x-1/2 bg-black/70 px-4 py-2 rounded text-white text-sm pointer-events-none">
              {(() => {
                const label = buildType === 'fire' ? 'firewall' : buildType;
                if (buildType === 'wall' || buildType === 'fire') {
                  return `Click on the grid to place a ${label}. Shift-click or right-click to remove walls. Press ESC to cancel.`;
                }
                return `Click on the grid near your base to build a ${label}. Shift-click or right-click to remove walls. Press ESC to cancel.`;
              })()}
          </div>
      )}

      {isPaused && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <div className="bg-black/70 border border-gray-700 px-6 py-2 rounded text-white font-bold tracking-widest">
            PAUSED
          </div>
        </div>
      )}

      {showSettings && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-50">
          <div className="bg-gray-900 border border-gray-700 rounded-lg p-6 w-80 text-white">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold">Settings</h2>
              <button
                onClick={() => setShowSettings(false)}
                className="text-gray-400 hover:text-white"
                aria-label="Close settings"
              >
                X
              </button>
            </div>
            <div className="flex flex-col gap-3">
              <button
                onClick={() => handlePauseToggle(!isPaused)}
                className={`w-full py-2 rounded font-bold ${isPaused ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-amber-700 hover:bg-amber-600'} text-white`}
              >
                {isPaused ? 'Resume' : 'Pause'}
              </button>
              <button
                onClick={() => {
                  setShowSettings(false);
                  handleQuitToMenu();
                }}
                className="w-full py-2 bg-red-700 hover:bg-red-600 text-white rounded font-bold"
              >
                Quit to Menu
              </button>
            </div>
          </div>
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
