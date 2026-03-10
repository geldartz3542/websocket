import WebSocket from 'ws';
import { verifyChannelAuth } from './auth.js';
import logger from './logger.js';

/**
 * Channel types (determined by name prefix):
 *   - public:    any name without prefix          (e.g., "alerts", "news")
 *   - private:   prefixed with "private-"         (e.g., "private-user.123")
 *   - presence:  prefixed with "presence-"        (e.g., "presence-chat.room.1")
 */
class ChannelManager {
  constructor() {
    this.channels = new Map(); // channelName -> Map<socketId, { ws, memberInfo? }>
  }

  // ── Channel type detection ──────────────────────────

  static isPrivate(channel) {
    return channel.startsWith('private-');
  }

  static isPresence(channel) {
    return channel.startsWith('presence-');
  }

  static requiresAuth(channel) {
    return ChannelManager.isPrivate(channel) || ChannelManager.isPresence(channel);
  }

  // ── Subscribe ───────────────────────────────────────

  /**
   * Subscribe a client to a channel.
   *
   * @param {WebSocket} ws           The client socket
   * @param {string}    channel      Channel name
   * @param {string}    [auth]       Auth token for private/presence channels
   * @param {object}    [channelData] Member info for presence channels
   * @returns {{ success: boolean, error?: string, members?: object[] }}
   */
  subscribe(ws, channel, auth = null, channelData = null) {
    // ── Auth check for private/presence channels
    if (ChannelManager.requiresAuth(channel)) {
      if (!auth) {
        return { success: false, error: 'Auth token required for private/presence channels' };
      }

      const valid = verifyChannelAuth(ws.socketId, channel, auth, channelData);
      if (!valid) {
        logger.warn('Channel auth failed', { socketId: ws.socketId, channel });
        return { success: false, error: 'Invalid auth token' };
      }
    }

    // ── Join the channel
    if (!this.channels.has(channel)) {
      this.channels.set(channel, new Map());
    }

    const members = this.channels.get(channel);
    const memberInfo = channelData ? JSON.parse(channelData) : null;

    members.set(ws.socketId, { ws, memberInfo });
    ws.subscribedChannels.add(channel);

    logger.debug('Subscribed', { socketId: ws.socketId, channel, members: members.size });

    // ── Presence: notify existing members about new join
    if (ChannelManager.isPresence(channel) && memberInfo) {
      this.broadcast(channel, {
        event: 'member_added',
        channel,
        data: memberInfo,
      }, ws.socketId);

      // Return current member list
      const currentMembers = [];
      for (const [, entry] of members) {
        if (entry.memberInfo) currentMembers.push(entry.memberInfo);
      }
      return { success: true, members: currentMembers };
    }

    return { success: true };
  }

  // ── Unsubscribe ─────────────────────────────────────

  unsubscribe(ws, channel) {
    const members = this.channels.get(channel);
    if (!members) return;

    const entry = members.get(ws.socketId);
    members.delete(ws.socketId);
    ws.subscribedChannels.delete(channel);

    // Presence: notify remaining members
    if (ChannelManager.isPresence(channel) && entry?.memberInfo) {
      this.broadcast(channel, {
        event: 'member_removed',
        channel,
        data: entry.memberInfo,
      });
    }

    // Clean up empty channel
    if (members.size === 0) {
      this.channels.delete(channel);
    }

    logger.debug('Unsubscribed', { socketId: ws.socketId, channel });
  }

  // ── Remove connection from all channels ─────────────

  removeFromAll(ws) {
    for (const channel of [...ws.subscribedChannels]) {
      this.unsubscribe(ws, channel);
    }
  }

  // ── Broadcast ───────────────────────────────────────

  /**
   * Send a message to all subscribers of a channel.
   *
   * @param {string}      channel       Channel name
   * @param {object}      payload       The JSON message to send
   * @param {string|null} excludeSocketId  Socket to exclude (sender)
   * @returns {number}    Number of clients the message was sent to
   */
  broadcast(channel, payload, excludeSocketId = null) {
    const members = this.channels.get(channel);
    if (!members) return 0;

    const data = JSON.stringify(payload);
    let sent = 0;

    for (const [socketId, entry] of members) {
      if (socketId === excludeSocketId) continue;
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(data);
        sent++;
      }
    }

    logger.debug('Broadcast', { channel, event: payload.event, recipients: sent });
    return sent;
  }

  /**
   * Send to specific user(s) across all their connections.
   *
   * @param {string[]} userIds
   * @param {object}   payload
   * @param {import('./connection-manager.js').default} connectionManager
   * @returns {number}
   */
  sendToUsers(userIds, payload, connectionManager) {
    const data = JSON.stringify(payload);
    let sent = 0;

    for (const userId of userIds) {
      const sockets = connectionManager.getAllByUserId(userId);
      for (const ws of sockets) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(data);
          sent++;
        }
      }
    }

    return sent;
  }

  // ── Stats ───────────────────────────────────────────

  getStats() {
    const channelStats = [];

    for (const [name, members] of this.channels) {
      channelStats.push({
        name,
        type: ChannelManager.isPresence(name) ? 'presence'
            : ChannelManager.isPrivate(name) ? 'private'
            : 'public',
        subscribers: members.size,
      });
    }

    return {
      totalChannels: this.channels.size,
      channels: channelStats,
    };
  }

  /**
   * Get info for a specific channel.
   */
  getChannelInfo(channel) {
    const members = this.channels.get(channel);
    if (!members) return null;

    const info = {
      name: channel,
      subscribers: members.size,
      type: ChannelManager.isPresence(channel) ? 'presence'
          : ChannelManager.isPrivate(channel) ? 'private'
          : 'public',
    };

    // Include member list for presence channels
    if (ChannelManager.isPresence(channel)) {
      info.members = [];
      for (const [, entry] of members) {
        if (entry.memberInfo) info.members.push(entry.memberInfo);
      }
    }

    return info;
  }
}

export default ChannelManager;
