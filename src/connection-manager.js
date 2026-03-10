import { generateSocketId } from './auth.js';
import logger from './logger.js';

/**
 * Manages all WebSocket connections with unique socket IDs.
 */
class ConnectionManager {
  constructor() {
    this.connections = new Map();   // socketId -> ws
    this.ipCounts = new Map();      // ip -> count
  }

  /**
   * Register a new connection.
   * @param {WebSocket} ws
   * @param {import('http').IncomingMessage} req
   * @param {number} maxPerIp  0 = unlimited
   * @returns {{ socketId: string } | null}  null if rejected
   */
  add(ws, req, maxPerIp = 0) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || 'unknown';

    // Check IP limit
    if (maxPerIp > 0) {
      const currentCount = this.ipCounts.get(ip) || 0;
      if (currentCount >= maxPerIp) {
        logger.warn('Connection rejected — IP limit reached', { ip, limit: maxPerIp });
        return null;
      }
    }

    const socketId = generateSocketId();

    // Attach metadata to ws
    ws.socketId = socketId;
    ws.clientIp = ip;
    ws.userId = null;
    ws.subscribedChannels = new Set();
    ws.isAlive = true;
    ws.connectedAt = Date.now();

    this.connections.set(socketId, ws);
    this.ipCounts.set(ip, (this.ipCounts.get(ip) || 0) + 1);

    logger.info('Connection established', { socketId, ip });
    return { socketId };
  }

  /**
   * Remove a connection.
   */
  remove(ws) {
    if (!ws.socketId) return;

    this.connections.delete(ws.socketId);

    // Decrement IP count
    if (ws.clientIp) {
      const count = (this.ipCounts.get(ws.clientIp) || 1) - 1;
      if (count <= 0) {
        this.ipCounts.delete(ws.clientIp);
      } else {
        this.ipCounts.set(ws.clientIp, count);
      }
    }

    logger.info('Connection closed', {
      socketId: ws.socketId,
      userId: ws.userId,
      duration: Date.now() - ws.connectedAt,
    });
  }

  /**
   * Look up connection by socket ID.
   */
  get(socketId) {
    return this.connections.get(socketId);
  }

  /**
   * Look up connection by user ID.
   */
  getByUserId(userId) {
    for (const ws of this.connections.values()) {
      if (ws.userId == userId) return ws;
    }
    return null;
  }

  /**
   * Get all connections for a user ID (supports multiple devices).
   */
  getAllByUserId(userId) {
    const results = [];
    for (const ws of this.connections.values()) {
      if (ws.userId == userId) results.push(ws);
    }
    return results;
  }

  /**
   * Identify a connection with a user ID.
   */
  identify(ws, userId) {
    ws.userId = userId;
    logger.debug('User identified', { socketId: ws.socketId, userId });
  }

  /**
   * Total active connections.
   */
  get count() {
    return this.connections.size;
  }

  /**
   * Stats object.
   */
  getStats() {
    let identifiedCount = 0;
    for (const ws of this.connections.values()) {
      if (ws.userId) identifiedCount++;
    }

    return {
      total: this.connections.size,
      identified: identifiedCount,
      anonymous: this.connections.size - identifiedCount,
      uniqueIps: this.ipCounts.size,
    };
  }
}

export default ConnectionManager;
