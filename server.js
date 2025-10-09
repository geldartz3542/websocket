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

server.timeout = 10800000;

const wss = new WebSocketServer({ server });

// Store channels and user sockets
const channels = new Map(); // channel -> Set of ws clients
const userSockets = new Map(); // userId -> ws client

wss.on('connection', function connection(ws) {
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

server.listen(8080, () => {
  console.log('✅ WebSocket Server running at ws://localhost:8080');
});
