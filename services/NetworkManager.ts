import Peer, { DataConnection } from 'peerjs';
import { PeerMessage } from '../types';

export type ConnectionCallback = (peerId: string) => void;
export type MessageCallback = (peerId: string, message: PeerMessage) => void;
export type ErrorCallback = (error: Error) => void;

export class NetworkManager {
  private peer: Peer | null = null;
  private connections: Map<string, DataConnection> = new Map();
  private peerToPlayer: Map<string, string> = new Map(); // peerId -> playerId
  private nextPlayerId: number = 2; // Start at 2 since host is always p1
  private isHost: boolean = false;
  private roomId: string = '';
  
  // Callbacks
  private onConnectionCallback: ConnectionCallback | null = null;
  private onMessageCallback: MessageCallback | null = null;
  private onErrorCallback: ErrorCallback | null = null;
  private onDisconnectCallback: ConnectionCallback | null = null;

  constructor() {}

  /**
   * Host a new game session
   */
  async hostGame(roomId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      this.isHost = true;
      this.roomId = roomId;
      
      // Create peer with the room ID as the peer ID
      this.peer = new Peer(roomId);
      
      this.peer.on('open', (id) => {
        console.log('[NetworkManager] Hosting game with ID:', id);
        resolve(id);
      });

      this.peer.on('connection', (conn) => {
        this.handleNewConnection(conn);
      });

      this.peer.on('error', (err) => {
        console.error('[NetworkManager] Peer error:', err);
        this.onErrorCallback?.(err);
        reject(err);
      });
    });
  }

  /**
   * Join an existing game session
   */
  async joinGame(roomId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.isHost = false;
      this.roomId = roomId;
      
      // Generate a unique player ID
      const playerId = `player_${Math.random().toString(36).substring(7)}`;
      this.peer = new Peer(playerId);
      
      this.peer.on('open', () => {
        console.log('[NetworkManager] Connecting to room:', roomId);
        
        // Connect to the host
        const conn = this.peer!.connect(roomId, { reliable: true });
        
        conn.on('open', () => {
          console.log('[NetworkManager] Connected to host!');
          this.handleNewConnection(conn);
          resolve();
        });

        conn.on('error', (err) => {
          console.error('[NetworkManager] Connection error:', err);
          reject(err);
        });
      });

      this.peer.on('error', (err) => {
        console.error('[NetworkManager] Peer error:', err);
        this.onErrorCallback?.(err);
        reject(err);
      });
    });
  }

  /**
   * Handle a new connection (both for host receiving and client connecting)
   */
  private handleNewConnection(conn: DataConnection) {
    console.log('[NetworkManager] New connection from:', conn.peer, 'open:', conn.open);
    
    this.connections.set(conn.peer, conn);
    
    conn.on('data', (data) => {
      console.log('[NetworkManager] Received data from', conn.peer, ':', data);
      this.onMessageCallback?.(conn.peer, data as PeerMessage);
    });

    conn.on('close', () => {
      console.log('[NetworkManager] Connection closed:', conn.peer);
      this.connections.delete(conn.peer);
      this.onDisconnectCallback?.(conn.peer);
    });

    // Fire callback after a small delay to ensure connection is fully ready
    setTimeout(() => {
      console.log('[NetworkManager] Connection ready, firing callback for:', conn.peer);
      this.onConnectionCallback?.(conn.peer);
    }, 50);
  }

  /**
   * Send a message to a specific peer
   */
  sendToPeer(peerId: string, message: PeerMessage) {
    const conn = this.connections.get(peerId);
    if (conn && conn.open) {
      console.log('[NetworkManager] Sending to peer', peerId, ':', message);
      conn.send(message);
    } else {
      console.warn('[NetworkManager] Cannot send - connection not ready for peer:', peerId, 'open:', conn?.open);
    }
  }

  /**
   * Broadcast a message to all connected peers
   */
  broadcast(message: PeerMessage) {
    this.connections.forEach((conn) => {
      if (conn.open) {
        conn.send(message);
      }
    });
  }

  /**
   * Send a game state sync message
   */
  sendSync(state: any) {
    const message: PeerMessage = {
      type: 'SYNC',
      payload: state
    };
    this.broadcast(message);
  }

  /**
   * Send a player action message
   */
  sendAction(action: any) {
    const message: PeerMessage = {
      type: 'ACTION',
      payload: action
    };
    this.broadcast(message);
  }

  /**
   * Get the number of connected peers
   */
  getConnectionCount(): number {
    return this.connections.size;
  }

  /**
   * Assign a player ID to a peer and return it
   */
  assignPlayerToPeer(peerId: string): string {
    const playerId = `p${this.nextPlayerId}`;
    this.peerToPlayer.set(peerId, playerId);
    this.nextPlayerId++;
    return playerId;
  }

  /**
   * Get the player ID for a peer
   */
  getPlayerIdForPeer(peerId: string): string | undefined {
    return this.peerToPlayer.get(peerId);
  }

  /**
   * Get all assigned player IDs
   */
  getAssignedPlayerIds(): string[] {
    return Array.from(this.peerToPlayer.values());
  }

  /**
   * Send a personalized message to each connected peer
   * Callback receives (peerId, playerId) and returns the message to send
   */
  sendToEachPeer(messageBuilder: (peerId: string, playerId: string) => PeerMessage) {
    this.peerToPlayer.forEach((playerId, peerId) => {
      const message = messageBuilder(peerId, playerId);
      this.sendToPeer(peerId, message);
    });
  }

  /**
   * Check if this instance is the host
   */
  getIsHost(): boolean {
    return this.isHost;
  }

  /**
   * Get the room ID
   */
  getRoomId(): string {
    return this.roomId;
  }

  /**
   * Set callback for new connections
   */
  onConnection(callback: ConnectionCallback) {
    this.onConnectionCallback = callback;
  }

  /**
   * Set callback for incoming messages
   */
  onMessage(callback: MessageCallback) {
    this.onMessageCallback = callback;
  }

  /**
   * Set callback for errors
   */
  onError(callback: ErrorCallback) {
    this.onErrorCallback = callback;
  }

  /**
   * Set callback for disconnections
   */
  onDisconnect(callback: ConnectionCallback) {
    this.onDisconnectCallback = callback;
  }

  /**
   * Disconnect and clean up
   */
  disconnect() {
    this.connections.forEach((conn) => conn.close());
    this.connections.clear();
    this.peerToPlayer.clear();
    this.nextPlayerId = 2;
    this.peer?.destroy();
    this.peer = null;
    this.isHost = false;
    this.roomId = '';
  }
}

// Singleton instance for easy access across the app
export const networkManager = new NetworkManager();
