// ═══════════════════════════════════════════════════════
//  Digisaka WebSocket Server — Production Entry Point
//  Pusher-compatible protocol · REST API · Auth · Channels
// ═══════════════════════════════════════════════════════
import express from 'express';
import { createServer as createHttpServer } from 'http';
import { createServer as createHttpsServer } from 'https';
import { readFileSync } from 'fs';
import { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import config from './src/config.js';
import logger from './src/logger.js';
import ChannelManager from './src/channel-manager.js';
import ConnectionManager from './src/connection-manager.js';
import RateLimiter from './src/rate-limiter.js';
import createApiRouter from './src/api.js';

// ─── Setup ────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

logger.setLevel(config.logLevel);
logger.info('Starting Digisaka WebSocket Server', {
  appId: config.appId,
  port: config.port,
  logLevel: config.logLevel,
});

// ─── Express App ──────────────────────────────────────
const app = express();

// Capture raw body for HMAC verification
app.use(express.json({
  limit: '1mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString(); },
}));

// CORS
app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (config.allowedOrigins.includes('*') || config.allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-App-Key, X-App-Signature, Authorization');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ─── Dashboard Auth (cookie-based) ────────────────────
const COOKIE_NAME = 'ws_dash_token';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function isAuthenticated(req) {
  if (!config.dashboardPassword) return true;
  const cookies = parseCookies(req);
  return cookies[COOKIE_NAME] === config.dashboardPassword;
}

function loginPage(error = '') {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Digisaka WebSocket — Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
    background: #0f1117;
    color: #e4e6f0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .card {
    background: #161922;
    border: 1px solid #2a2f42;
    border-radius: 12px;
    padding: 40px 36px;
    width: 100%;
    max-width: 380px;
    text-align: center;
  }
  .logo {
    font-size: 22px;
    font-weight: 700;
    color: #6c8cff;
    margin-bottom: 6px;
  }
  .logo span { color: #6b7194; font-weight: 400; font-size: 14px; }
  .desc {
    color: #6b7194;
    font-size: 13px;
    margin-bottom: 28px;
  }
  .error {
    background: rgba(248,113,113,0.08);
    border: 1px solid rgba(248,113,113,0.2);
    color: #f87171;
    font-size: 13px;
    padding: 8px 14px;
    border-radius: 6px;
    margin-bottom: 16px;
  }
  input {
    width: 100%;
    padding: 11px 14px;
    font-size: 14px;
    font-family: inherit;
    background: #1c2030;
    border: 1px solid #2a2f42;
    border-radius: 8px;
    color: #e4e6f0;
    outline: none;
    margin-bottom: 16px;
    transition: border-color 0.15s;
  }
  input:focus { border-color: #6c8cff; }
  input::placeholder { color: #4a4f6a; }
  button {
    width: 100%;
    padding: 11px;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    background: #6c8cff;
    color: #fff;
    border: none;
    border-radius: 8px;
    cursor: pointer;
    transition: background 0.15s;
  }
  button:hover { background: #4c6adf; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">Digisaka <span>WebSocket</span></div>
    <div class="desc">Enter the dashboard password to continue</div>
    ${error ? '<div class="error">' + error + '</div>' : ''}
    <form method="POST" action="/auth/login">
      <input type="password" name="password" placeholder="Password" autofocus required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}

// Login POST handler (must be before static middleware)
app.use(express.urlencoded({ extended: false }));

app.post('/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === config.dashboardPassword) {
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(password)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`);
    const returnTo = parseCookies(req)['ws_return'] || '/';
    res.redirect(returnTo);
  } else {
    res.status(401).send(loginPage('Incorrect password. Please try again.'));
  }
});

app.get('/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
  res.redirect('/');
});

// Gate: protect dashboard and documentation
function dashboardGate(req, res, next) {
  // Don't gate API, health, WS upgrade, or auth routes
  if (
    req.path.startsWith('/api/') ||
    req.path.startsWith('/auth/') ||
    req.path === '/health'
  ) return next();

  // Only gate HTML pages (/, /documentation, /index.html)
  const gated = ['/', '/index.html', '/documentation', '/documentation.html'];
  if (!gated.includes(req.path)) return next();

  if (!isAuthenticated(req)) {
    res.setHeader('Set-Cookie', `ws_return=${encodeURIComponent(req.path)}; Path=/; SameSite=Strict; Max-Age=300`);
    return res.status(401).send(loginPage());
  }
  next();
}

app.use(dashboardGate);

// Static dashboard page
app.use(express.static(path.join(__dirname, 'public')));

// Documentation page
app.get('/documentation', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'documentation.html'));
});

// ─── Core Managers ────────────────────────────────────
const channelManager = new ChannelManager();
const connectionManager = new ConnectionManager();
const rateLimiter = new RateLimiter(config.rateLimit.points, config.rateLimit.duration);

// ─── REST API Routes ──────────────────────────────────
app.use(createApiRouter(channelManager, connectionManager));

// ─── HTTP(S) Server ───────────────────────────────────
let server;
if (config.sslCertPath && config.sslKeyPath) {
  try {
    server = createHttpsServer({
      cert: readFileSync(config.sslCertPath),
      key: readFileSync(config.sslKeyPath),
    }, app);
    logger.info('SSL enabled (terminating TLS at server)');
  } catch (err) {
    logger.error('Failed to load SSL certificates, falling back to HTTP', { error: err.message });
    server = createHttpServer(app);
  }
} else {
  server = createHttpServer(app);
}

server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

// ─── WebSocket Server ─────────────────────────────────
const wss = new WebSocketServer({
  server,
  maxPayload: config.maxPayloadSize,
  verifyClient: ({ origin }, done) => {
    if (config.allowedOrigins.includes('*')) return done(true);
    if (origin && config.allowedOrigins.includes(origin)) return done(true);
    // Allow connections without origin header (mobile apps, server-side clients)
    if (!origin) return done(true);

    logger.warn('Connection rejected — origin not allowed', { origin });
    done(false, 403, 'Origin not allowed');
  },
});

// ─── WebSocket Connection Handler ─────────────────────
wss.on('connection', (ws, req) => {
  // Register connection (enforces per-IP limit)
  const result = connectionManager.add(ws, req, config.maxConnectionsPerIp);
  if (!result) {
    ws.close(4429, 'Too many connections from this IP');
    return;
  }

  const { socketId } = result;

  // Send connection_established event (Pusher-compatible)
  send(ws, {
    event: 'pusher:connection_established',
    data: JSON.stringify({
      socket_id: socketId,
      activity_timeout: Math.floor(config.heartbeatInterval / 1000),
    }),
  });

  logger.info('Client connected', { socketId, ip: ws.ip });

  // Heartbeat
  ws.on('pong', () => { ws.isAlive = true; });

  // ── Message Handler ───────────────────────────────
  ws.on('message', (raw) => {
    // Rate limit
    const rl = rateLimiter.consume(socketId);
    if (!rl.allowed) {
      send(ws, {
        event: 'error',
        data: JSON.stringify({
          code: 4301,
          message: `Rate limit exceeded. Retry in ${Math.ceil(rl.retryAfterMs / 1000)}s`,
        }),
      });
      return;
    }

    // Parse message
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      send(ws, {
        event: 'error',
        data: JSON.stringify({ code: 4400, message: 'Invalid JSON' }),
      });
      return;
    }

    const { event, action, data, channel, auth, channel_data } = parsed;
    const eventName = event || action;

    logger.debug('Message received', { socketId, event: eventName, channel });

    switch (eventName) {
      // ── Identify user ─────────────────────────────
      case 'identify': {
        const userId = parsed.userId || parsed.user_id || data?.user_id;
        if (userId) {
          connectionManager.identify(ws, String(userId));
          send(ws, {
            event: 'identified',
            data: JSON.stringify({ user_id: String(userId), socket_id: socketId }),
          });
          logger.info('User identified', { socketId, userId });
        }
        break;
      }

      // ── Subscribe to channel ──────────────────────
      case 'pusher:subscribe':
      case 'subscribe': {
        const ch = channel || data?.channel;
        if (!ch) {
          send(ws, {
            event: 'error',
            data: JSON.stringify({ code: 4400, message: 'Missing channel name' }),
          });
          break;
        }

        const authToken = auth || data?.auth || null;
        const chData = channel_data || data?.channel_data || null;
        const subResult = channelManager.subscribe(ws, ch, authToken, chData);

        if (subResult.success) {
          const responseData = { channel: ch };
          if (subResult.members) responseData.members = subResult.members;

          send(ws, {
            event: 'pusher_internal:subscription_succeeded',
            channel: ch,
            data: JSON.stringify(responseData),
          });
          logger.info('Subscribed', { socketId, channel: ch });
        } else {
          send(ws, {
            event: 'pusher:error',
            channel: ch,
            data: JSON.stringify({ code: 4401, message: subResult.error }),
          });
          logger.warn('Subscription failed', { socketId, channel: ch, error: subResult.error });
        }
        break;
      }

      // ── Unsubscribe from channel ──────────────────
      case 'pusher:unsubscribe':
      case 'unsubscribe': {
        const ch = channel || data?.channel;
        if (ch) {
          channelManager.unsubscribe(ws, ch);
          logger.info('Unsubscribed', { socketId, channel: ch });
        }
        break;
      }

      // ── Pusher ping/pong (activity timeout) ───────
      case 'pusher:ping': {
        send(ws, { event: 'pusher:pong', data: '{}' });
        break;
      }

      // ── Client-sent event or legacy message ───────
      case 'message':
      default: {
        // Handle legacy "message" action format for backward compat
        if (eventName === 'message') {
          const ch = channel || data?.channel;
          const msg = parsed.message ?? data;
          const targetUsers = parsed.targetUsers || parsed.target_users;

          if (targetUsers && Array.isArray(targetUsers)) {
            // Direct messaging to specific users
            channelManager.sendToUsers(
              targetUsers.map(String),
              {
                event: 'private_message',
                data: JSON.stringify({
                  from: ws.userId || socketId,
                  message: msg,
                }),
              },
              connectionManager,
            );
          } else if (ch) {
            // Broadcast to channel (exclude sender)
            channelManager.broadcast(ch, {
              event: 'client_message',
              channel: ch,
              data: JSON.stringify({
                from: ws.userId || socketId,
                message: msg,
              }),
            }, socketId);
          }
          break;
        }

        // Client events (prefixed with "client-") — Pusher convention
        if (typeof eventName === 'string' && eventName.startsWith('client-')) {
          const ch = channel || data?.channel;
          if (ch && ws.subscribedChannels?.has(ch)) {
            channelManager.broadcast(ch, {
              event: eventName,
              channel: ch,
              data: typeof data === 'string' ? data : JSON.stringify(data || {}),
            }, socketId);
          }
          break;
        }

        // Unknown event — ignore silently in production, log in debug
        logger.debug('Unknown event', { socketId, event: eventName });
        break;
      }
    }
  });

  // ── Disconnect ──────────────────────────────────────
  ws.on('close', (code, reason) => {
    const userId = ws.userId;
    channelManager.removeFromAll(ws);
    connectionManager.remove(ws);
    rateLimiter.remove(socketId);
    logger.info('Client disconnected', { socketId, userId, code });

    // If user was identified and has no remaining connections, notify Laravel
    if (userId && connectionManager.getAllByUserId(userId).length === 0) {
      notifyUserOffline(userId);
    }
  });

  ws.on('error', (err) => {
    logger.error('Socket error', { socketId, error: err.message });
  });
});

// ─── Heartbeat Interval ───────────────────────────────
const heartbeatInterval = setInterval(() => {
  let terminated = 0;
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      terminated++;
      logger.debug('Terminating dead connection', { socketId: ws.socketId });
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
  if (terminated > 0) {
    logger.info('Heartbeat sweep', { terminated, remaining: wss.clients.size });
  }
}, config.heartbeatInterval);

// Rate limiter cleanup every 5 minutes
const cleanupInterval = setInterval(() => {
  rateLimiter.cleanup();
}, 5 * 60 * 1000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
  clearInterval(cleanupInterval);
});

// ─── Helper ───────────────────────────────────────────
function send(ws, payload) {
  if (ws.readyState === 1) { // WebSocket.OPEN
    ws.send(JSON.stringify(payload));
  }
}

/**
 * Notify Laravel that an identified user has gone offline (all connections closed).
 * Fires and forgets — errors are logged but don't affect the WS server.
 */
async function notifyUserOffline(userId) {
  const url = config.disconnectWebhookUrl;
  if (!url) return;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-App-Key': config.appKey,
        'X-App-Signature': config.appSecret,
      },
      body: JSON.stringify({ user_id: String(userId) }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      logger.info('User offline webhook sent', { userId });
    } else {
      logger.warn('User offline webhook failed', { userId, status: res.status });
    }
  } catch (err) {
    logger.error('User offline webhook error', { userId, error: err.message });
  }
}

// ─── Graceful Shutdown ────────────────────────────────
function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });

  wss.close(() => {
    server.close(() => {
      logger.info('Server stopped cleanly');
      process.exit(0);
    });
  });

  // Force exit after 10 seconds
  setTimeout(() => {
    logger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 10_000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: String(reason) });
});

// ─── Start ────────────────────────────────────────────
server.listen(config.port, config.host, () => {
  const protocol = config.sslCertPath ? 'wss' : 'ws';
  logger.info(`Digisaka WebSocket Server running`, {
    url: `${protocol}://${config.host}:${config.port}`,
    rest: `http://${config.host}:${config.port}/api`,
    dashboard: `http://${config.host}:${config.port}/`,
    appId: config.appId,
  });
});
