import { Router } from 'express';
import { generateChannelAuth, apiAuthMiddleware } from './auth.js';
import logger from './logger.js';

/**
 * Creates Express router with Pusher-compatible REST API.
 *
 * @param {import('./channel-manager.js').default}    channelManager
 * @param {import('./connection-manager.js').default}  connectionManager
 */
export default function createApiRouter(channelManager, connectionManager) {
  const router = Router();

  // ────────────────────────────────────────────────────
  //  PUBLIC ENDPOINTS
  // ────────────────────────────────────────────────────

  /**
   * GET /health
   * Health check — no auth required.
   */
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      connections: connectionManager.count,
    });
  });

  // ────────────────────────────────────────────────────
  //  AUTHENTICATED ENDPOINTS (require X-App-Key + X-App-Signature)
  // ────────────────────────────────────────────────────

  /**
   * POST /api/trigger
   * Trigger an event on one or more channels.
   * Body: { channel|channels, event, data, socket_id? }
   *
   * This is the main endpoint Laravel uses to push events.
   */
  router.post('/api/trigger', apiAuthMiddleware, (req, res) => {
    const { channel, channels, event, data, socket_id } = req.body;

    if (!event) {
      return res.status(400).json({ error: 'Missing required field: event' });
    }

    const targetChannels = channels || (channel ? [channel] : []);
    if (targetChannels.length === 0) {
      return res.status(400).json({ error: 'Missing required field: channel or channels' });
    }

    const payload = {
      event,
      data: typeof data === 'string' ? data : JSON.stringify(data),
      channel: null, // set per-channel below
    };

    let totalSent = 0;

    for (const ch of targetChannels) {
      payload.channel = ch;
      totalSent += channelManager.broadcast(ch, payload, socket_id || null);
    }

    logger.info('Event triggered via API', {
      event,
      channels: targetChannels,
      recipients: totalSent,
    });

    res.json({ success: true, channels: targetChannels, recipients: totalSent });
  });

  /**
   * POST /api/broadcast
   * Broadcast to specific users (by userId), regardless of channel.
   * Body: { user_ids, event, data }
   */
  router.post('/api/broadcast', apiAuthMiddleware, (req, res) => {
    const { user_ids, event, data } = req.body;

    if (!event || !user_ids || !Array.isArray(user_ids)) {
      return res.status(400).json({ error: 'Missing required fields: user_ids (array), event' });
    }

    const payload = {
      event,
      data: typeof data === 'string' ? data : JSON.stringify(data),
    };

    const sent = channelManager.sendToUsers(
      user_ids.map(String),
      payload,
      connectionManager
    );

    logger.info('Broadcast to users via API', { event, userCount: user_ids.length, sent });
    res.json({ success: true, sent });
  });

  /**
   * POST /api/auth
   * Server-side channel auth (Pusher-compatible).
   * Laravel calls this to generate auth signatures for private/presence channels.
   * Body: { socket_id, channel_name, channel_data? }
   */
  router.post('/api/auth', apiAuthMiddleware, (req, res) => {
    const { socket_id, channel_name, channel_data } = req.body;

    if (!socket_id || !channel_name) {
      return res.status(400).json({ error: 'Missing socket_id or channel_name' });
    }

    const auth = generateChannelAuth(socket_id, channel_name, channel_data || null);

    const response = { auth };
    if (channel_data) {
      response.channel_data = channel_data;
    }

    res.json(response);
  });

  // ────────────────────────────────────────────────────
  //  INFO / STATS ENDPOINTS
  // ────────────────────────────────────────────────────

  /**
   * GET /api/channels
   * List all active channels with subscriber counts.
   */
  router.get('/api/channels', apiAuthMiddleware, (req, res) => {
    res.json(channelManager.getStats());
  });

  /**
   * GET /api/channels/:channel
   * Get info for a specific channel.
   */
  router.get('/api/channels/:channel', apiAuthMiddleware, (req, res) => {
    const info = channelManager.getChannelInfo(req.params.channel);
    if (!info) {
      return res.status(404).json({ error: 'Channel not found' });
    }
    res.json(info);
  });

  /**
   * GET /api/stats
   * Server statistics.
   */
  router.get('/api/stats', apiAuthMiddleware, (req, res) => {
    res.json({
      connections: connectionManager.getStats(),
      channels: channelManager.getStats(),
      server: {
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024 * 100) / 100,
        timestamp: new Date().toISOString(),
      },
    });
  });

  return router;
}
