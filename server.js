import express from 'express';
import { createServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);
app.use(express.static(path.join(__dirname, 'public')));

// Increased timeout settings
server.timeout = 10800000; // 3 hours in milliseconds (10800000 ms = 3 hours)

const wss = new WebSocketServer({ 
  server,
  // WebSocket-specific timeout settings
  perMessageDeflate: false,
  clientTracking: true
});

// Set keepalive interval for WebSocket connections
wss.on('connection', function connection(ws) {
  // Set WebSocket keepalive
  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  
  ws.subscribedChannels = new Set();
  ws.userId = null;

  ws.on('message', function message(data) {
    const parsed = JSON.parse(data);
    const { action, channel, message, userId, targetUsers } = parsed;

    switch (action) {
      case 'identify':
        ws.userId = userId;
        userSockets.set(userId, ws);
        console.log(`🧍 User ${userId} identified`);
        break;

      case 'subscribe':
        if (!channels.has(channel)) channels.set(channel, new Set());
        channels.get(channel).add(ws);
        ws.subscribedChannels.add(channel);
        console.log(`📡 Subscribed to: ${channel}`);
        break;

      case 'unsubscribe':
        if (channels.has(channel)) {
          channels.get(channel).delete(ws);
          if (channels.get(channel).size === 0) channels.delete(channel);
        }
        ws.subscribedChannels.delete(channel);
        break;

      case 'message':
        if (targetUsers && Array.isArray(targetUsers)) {
            targetUsers.forEach(uid => {
            const userSocket = userSockets.get(uid);
            if (userSocket && userSocket.readyState === WebSocket.OPEN) {
                userSocket.send(JSON.stringify({ private: true, from: ws.userId ?? 'system', message }));
            }
            });
        } else if (channel && channels.has(channel)) {
            channels.get(channel).forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ channel, message }));
            }
            });
        } else {
            console.log('⚠️ No target users or channels found for message:', message);
        }
        break;

      default:
        console.error('❌ Unknown action:', action);
    }
  });

  ws.on('close', () => {
    ws.subscribedChannels.forEach(channel => {
      if (channels.has(channel)) {
        channels.get(channel).delete(ws);
        if (channels.get(channel).size === 0) channels.delete(channel);
      }
    });
    if (ws.userId) userSockets.delete(ws.userId);
    console.log(`❌ User ${ws.userId} disconnected`);
  });
});

// WebSocket keepalive interval (check every 30 seconds)
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log(`💀 Terminating dead connection for user ${ws.userId}`);
      return ws.terminate();
    }
    
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

server.listen(6001, () => {
  console.log('✅ WebSocket Server running at ws://localhost:6001');
  console.log('⏰ Timeout settings:');
  console.log('   - HTTP Server timeout: 10800000ms (3 hours)');
  console.log('   - WebSocket keepalive: 30000ms (30 seconds)');
});