# Digisaka WebSocket Server

Production-ready, Pusher-compatible WebSocket server for the Digisaka platform.  
Provides real-time communication between the **Laravel API**, **Vue admin panel**, and **Flutter mobile app**.

---

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Quick Start](#quick-start)
3. [Configuration (.env)](#configuration)
4. [Protocol Reference](#protocol-reference)
5. [Channel Types](#channel-types)
6. [REST API Reference](#rest-api-reference)
7. [Laravel Integration](#laravel-integration)
8. [Vue Client (Admin Panel)](#vue-client-admin-panel)
9. [Flutter Client (Mobile App)](#flutter-client-mobile-app)
10. [Raw WebSocket Usage](#raw-websocket-usage)
11. [Security](#security)
12. [Production Deployment](#production-deployment)
13. [Monitoring & Debugging](#monitoring--debugging)
14. [Project Structure](#project-structure)

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                   Digisaka WebSocket Server                   │
│                      (Node.js · Port 6001)                    │
│                                                              │
│  ┌────────────┐  ┌────────────────┐  ┌───────────────────┐  │
│  │ Connection  │  │    Channel     │  │    REST API       │  │
│  │  Manager    │  │    Manager     │  │  (Express)        │  │
│  │ ─Socket IDs │  │ ─public       │  │ ─/api/trigger     │  │
│  │ ─IP limits  │  │ ─private-     │  │ ─/api/broadcast   │  │
│  │ ─User map   │  │ ─presence-    │  │ ─/api/auth        │  │
│  │ ─Multi-dev  │  │ ─Auth gating  │  │ ─/api/channels    │  │
│  └────────────┘  └────────────────┘  │ ─/api/stats       │  │
│                                      │ ─/health          │  │
│  ┌────────────┐  ┌────────────────┐  └───────────────────┘  │
│  │   Auth      │  │  Rate Limiter  │                         │
│  │ ─HMAC-256   │  │ ─Per socket    │  ┌───────────────────┐  │
│  │ ─Channel    │  │ ─Sliding win   │  │   Logger          │  │
│  │  signatures │  │ ─Auto cleanup  │  │ ─JSON structured  │  │
│  └────────────┘  └────────────────┘  └───────────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
    ┌───────▼──────┐ ┌────▼─────┐ ┌──────▼───────┐
    │  Laravel API  │ │  Vue 3   │ │ Flutter App  │
    │  (server-side │ │  (admin  │ │ (mobile      │
    │   triggers)   │ │  panel)  │ │  client)     │
    └──────────────┘ └──────────┘ └──────────────┘
```

**How it works:**
- **Clients** (Vue, Flutter, browser) connect via WebSocket and subscribe to channels.
- **Laravel** pushes events through the REST API (`POST /api/trigger`).
- The server broadcasts events to all subscribers of the targeted channel(s).
- Supports **public**, **private**, and **presence** channels with HMAC auth gating.

---

## Quick Start

### Prerequisites

- Node.js **18+**
- npm

### Install & Run

```bash
cd websocket/

# Install dependencies
npm install

# Copy and configure environment
cp .env.example .env
# Edit .env with your secrets

# Start the server
npm start

# Or with auto-restart on file changes (development)
npm run dev
```

### Verify it's running

```bash
# Health check
curl http://localhost:6001/health

# Response:
# { "status": "ok", "uptime": 12.34, "connections": 0, "timestamp": "..." }
```

Open the dashboard at **http://localhost:6001/** for a visual test interface.

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env`:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `6001` | Server port |
| `HOST` | `0.0.0.0` | Bind address |
| `APP_ID` | `digisaka` | Application identifier |
| `APP_KEY` | `digisaka-ws-key-2026` | Public app key (sent by clients, used in auth headers) |
| `APP_SECRET` | *(change in prod!)* | Secret key for HMAC signing and API authentication |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins for CORS/WS verification. Use `*` for dev. |
| `AUTH_ENDPOINT` | `http://localhost:8000/...` | Laravel endpoint for channel auth callbacks |
| `RATE_LIMIT_POINTS` | `60` | Max messages per connection per window |
| `RATE_LIMIT_DURATION` | `60` | Rate limit window in seconds |
| `HEARTBEAT_INTERVAL` | `25000` | Ping interval in milliseconds |
| `MAX_CONNECTIONS_PER_IP` | `50` | Max simultaneous connections from one IP (0 = no limit) |
| `MAX_PAYLOAD_SIZE` | `65536` | Max message payload in bytes (64KB) |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `SSL_CERT_PATH` | *(empty)* | Path to SSL cert (optional; usually reverse proxy handles TLS) |
| `SSL_KEY_PATH` | *(empty)* | Path to SSL key |

### Example `.env` for production

```dotenv
PORT=6001
HOST=0.0.0.0
APP_ID=digisaka
APP_KEY=my-random-app-key-here
APP_SECRET=my-very-secure-random-secret-64chars
ALLOWED_ORIGINS=https://digisaka.online,https://digisaka.app
LOG_LEVEL=info
MAX_CONNECTIONS_PER_IP=50
```

---

## Protocol Reference

The server follows a **Pusher-compatible** event protocol. All messages are JSON.

### Connection Flow

```
Client                              Server
  |                                    |
  |──── WS Connect ──────────────────►|
  |                                    |
  |◄── connection_established ────────|  (includes socket_id)
  |                                    |
  |──── identify (user_id) ──────────►|
  |◄── identified ────────────────────|
  |                                    |
  |──── subscribe (channel) ─────────►|
  |◄── subscription_succeeded ────────|
  |                                    |
  |◄── events from server ───────────|  (triggered by Laravel or other clients)
  |                                    |
  |──── unsubscribe (channel) ───────►|
  |──── close ───────────────────────►|
```

### Client → Server Messages

#### `identify` — Associate user ID with connection

```json
{ "event": "identify", "user_id": "42" }
```

Response:
```json
{ "event": "identified", "data": "{\"user_id\":\"42\",\"socket_id\":\"123456.7890123\"}" }
```

#### `subscribe` — Join a channel

```json
{ "event": "subscribe", "channel": "alerts" }
```

For private/presence channels, include an auth token:
```json
{
  "event": "subscribe",
  "channel": "private-user.5",
  "auth": "digisaka-ws-key-2026:a1b2c3d4e5f6..."
}
```

Success response:
```json
{ "event": "subscription_succeeded", "channel": "alerts", "data": "{\"channel\":\"alerts\"}" }
```

Error response:
```json
{ "event": "subscription_error", "channel": "private-user.5", "data": "{\"code\":4401,\"message\":\"Invalid auth token\"}" }
```

#### `unsubscribe` — Leave a channel

```json
{ "event": "unsubscribe", "channel": "alerts" }
```

#### `message` — Send a message to a channel

```json
{ "event": "message", "channel": "alerts", "message": "Hello everyone" }
```

Other subscribers receive:
```json
{
  "event": "client_message",
  "channel": "alerts",
  "data": "{\"from\":\"42\",\"message\":\"Hello everyone\"}"
}
```

#### `message` (private) — Send to specific users

```json
{ "event": "message", "target_users": ["5", "12"], "message": { "text": "Hi" } }
```

Recipients receive:
```json
{
  "event": "private_message",
  "data": "{\"from\":\"42\",\"message\":{\"text\":\"Hi\"}}"
}
```

#### `client-*` — Client events (Pusher convention)

Events prefixed with `client-` are broadcast to the channel (excluding sender):

```json
{ "event": "client-typing", "channel": "presence-chat.1", "data": { "user": "John" } }
```

#### `pusher:ping` — Application-level heartbeat

```json
{ "event": "pusher:ping" }
```

Response:
```json
{ "event": "pusher:pong", "data": "{}" }
```

### Server → Client Events

| Event | Description |
|---|---|
| `connection_established` | Sent immediately on connect. Contains `socket_id` and `activity_timeout`. |
| `identified` | Confirms user identity after `identify` message. |
| `subscription_succeeded` | Confirms channel join. For presence channels, includes member list. |
| `subscription_error` | Channel subscription was rejected (auth failure or missing token). |
| `error` | General error (rate limit, invalid JSON, etc.). Contains `code` and `message`. |
| `member_added` | Presence channel: a new member joined. Contains member info. |
| `member_removed` | Presence channel: a member left. Contains member info. |
| `client_message` | A message sent by another client to the channel. |
| `private_message` | A direct message sent to this user specifically. |
| `pusher:pong` | Response to a `pusher:ping`. |
| *(custom events)* | Any event name triggered via the REST API (e.g., `new-alert`, `task-updated`). |

### Error Codes

| Code | Meaning |
|---|---|
| `4301` | Rate limit exceeded |
| `4400` | Bad request (invalid JSON, missing fields) |
| `4401` | Authentication failed (channel subscription denied) |
| `4429` | Too many connections from this IP |

---

## Channel Types

### Public Channels

Any name **without** a `private-` or `presence-` prefix. No authentication required.

```
alerts
news
demo-trials
farm-updates
```

Any client can subscribe and receive events.

### Private Channels

Prefixed with `private-`. Requires a valid **auth token** to subscribe.

```
private-user.42
private-admin.notifications
private-farm.15
```

The auth token is an HMAC-SHA256 signature:  
`signature = HMAC-SHA256(secret, socketId:channelName)`  
Format: `"appKey:signature"`

### Presence Channels

Prefixed with `presence-`. Requires auth + member info (`channel_data`).

```
presence-chat.room.1
presence-editors.doc.5
```

Features:
- **Member tracking**: Server maintains a list of who's in the channel.
- **`member_added`** event when someone joins.
- **`member_removed`** event when someone leaves.
- `subscription_succeeded` response includes the current member list.

---

## REST API Reference

All authenticated endpoints require these headers:

```
X-App-Key: <your APP_KEY>
X-App-Signature: <your APP_SECRET>
```

> **Note:** For simplified deployments, `X-App-Signature` can be the raw secret (direct match). For stricter security, use HMAC-SHA256 of the request body.

### `GET /health` *(no auth)*

Health check.

```bash
curl http://localhost:6001/health
```

```json
{ "status": "ok", "uptime": 3600.5, "connections": 12, "timestamp": "2026-03-10T..." }
```

### `POST /api/trigger`

**Push an event to channel(s).** This is the primary endpoint for server-side event broadcasting.

```bash
curl -X POST http://localhost:6001/api/trigger \
  -H "Content-Type: application/json" \
  -H "X-App-Key: digisaka-ws-key-2026" \
  -H "X-App-Signature: digisaka-ws-secret-change-me-in-production" \
  -d '{
    "channels": ["alerts", "private-admin"],
    "event": "new-alert",
    "data": { "farm_id": 5, "type": "drought", "severity": "high" }
  }'
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `channel` | string | * | Single channel name |
| `channels` | string[] | * | Multiple channel names |
| `event` | string | yes | Event name |
| `data` | any | no | Event payload |
| `socket_id` | string | no | Exclude this socket from receiving the event |

*Either `channel` or `channels` is required.

**Response:**

```json
{ "success": true, "channels": ["alerts", "private-admin"], "recipients": 8 }
```

### `POST /api/broadcast`

**Send directly to specific users** (across all their connected devices).

```bash
curl -X POST http://localhost:6001/api/broadcast \
  -H "Content-Type: application/json" \
  -H "X-App-Key: digisaka-ws-key-2026" \
  -H "X-App-Signature: digisaka-ws-secret-change-me-in-production" \
  -d '{
    "user_ids": ["5", "12", "34"],
    "event": "notification",
    "data": { "title": "New task assigned", "url": "/tasks/99" }
  }'
```

**Request body:**

| Field | Type | Required | Description |
|---|---|---|---|
| `user_ids` | string[] | yes | Target user IDs |
| `event` | string | yes | Event name |
| `data` | any | no | Event payload |

**Response:**

```json
{ "success": true, "sent": 3 }
```

### `POST /api/auth`

**Generate channel auth signatures** for private/presence channels.

```bash
curl -X POST http://localhost:6001/api/auth \
  -H "Content-Type: application/json" \
  -H "X-App-Key: digisaka-ws-key-2026" \
  -H "X-App-Signature: digisaka-ws-secret-change-me-in-production" \
  -d '{ "socket_id": "123456.7890123", "channel_name": "private-user.5" }'
```

**Response:**

```json
{ "auth": "digisaka-ws-key-2026:a1b2c3d4e5f6abcdef..." }
```

For presence channels, include `channel_data`:

```json
{
  "socket_id": "123456.7890123",
  "channel_name": "presence-chat.1",
  "channel_data": { "user_id": "5", "user_info": { "name": "Juan" } }
}
```

### `GET /api/channels`

List all active channels.

```json
{
  "totalChannels": 3,
  "channels": [
    { "name": "alerts", "type": "public", "subscribers": 25 },
    { "name": "private-admin", "type": "private", "subscribers": 2 },
    { "name": "presence-chat.1", "type": "presence", "subscribers": 4 }
  ]
}
```

### `GET /api/channels/:channel`

Get details for a specific channel. For presence channels, includes member list.

```json
{
  "name": "presence-chat.1",
  "type": "presence",
  "subscribers": 4,
  "members": [
    { "user_id": "5", "user_info": { "name": "Juan" } },
    { "user_id": "12", "user_info": { "name": "Maria" } }
  ]
}
```

### `GET /api/stats`

Full server statistics.

```json
{
  "connections": {
    "total": 48,
    "identified": 42,
    "anonymous": 6,
    "uniqueIps": 30
  },
  "channels": {
    "totalChannels": 5,
    "channels": [ "..." ]
  },
  "server": {
    "uptime": 86400.5,
    "memoryMB": 24.5,
    "timestamp": "2026-03-10T..."
  }
}
```

---

## Laravel Integration

### Setup

1. Add to your Laravel `.env`:

```dotenv
WEBSOCKET_API_URL=http://localhost:6001
WEBSOCKET_APP_KEY=digisaka-ws-key-2026
WEBSOCKET_APP_SECRET=digisaka-ws-secret-change-me-in-production
```

The service reads from `config/services.php`:
```php
'websocket' => [
    'url'    => env('WEBSOCKET_API_URL', 'http://localhost:6001'),
    'key'    => env('WEBSOCKET_APP_KEY', 'digisaka-ws-key-2026'),
    'secret' => env('WEBSOCKET_APP_SECRET', 'digisaka-ws-secret-change-me-in-production'),
],
```

### Usage: `WebSocketService`

```php
use App\Services\WebSocketService;
```

#### Trigger events on channels

```php
// Single channel
WebSocketService::trigger('alerts', 'new-alert', [
    'farm_id' => 5,
    'type' => 'drought',
    'message' => 'Low moisture detected',
]);

// Multiple channels
WebSocketService::trigger(
    ['alerts', 'private-user.12', 'private-user.34'],
    'task-assigned',
    ['task_id' => 99, 'title' => 'Inspect Farm 7']
);

// Exclude the sender (by socket ID) to prevent echo
WebSocketService::trigger('chat.room.1', 'new-message', $data, $request->socket_id);
```

#### Send directly to users

```php
// Notify specific users (reaches all their devices)
WebSocketService::toUsers([5, 12], 'notification', [
    'title' => 'Approval needed',
    'body' => 'Demo trial #42 is waiting for your approval.',
    'url' => '/approval/42',
]);
```

#### Authorize private/presence channels

```php
// In your broadcasting auth controller:
$auth = WebSocketService::authorizeChannel(
    $request->socket_id,
    $request->channel_name,
    $channelData // for presence channels
);

return response()->json($auth);
```

#### Get server stats

```php
$stats = WebSocketService::stats();
// Returns: ['connections' => [...], 'channels' => [...], 'server' => [...]]

$channels = WebSocketService::channels();
// Returns: ['totalChannels' => 5, 'channels' => [...]]
```

### Real-World Examples

#### In a Controller (real-time alert notification)

```php
public function storeAlert(Request $request)
{
    $alert = Alert::create($request->validated());

    // Push to all users subscribed to the 'alerts' channel
    WebSocketService::trigger('alerts', 'new-alert', [
        'id' => $alert->id,
        'type' => $alert->alert_type,
        'message' => $alert->alert_message,
        'farm_id' => $alert->farm_id,
        'severity' => $alert->severity,
    ]);

    return response()->json(['success' => true, 'data' => $alert]);
}
```

#### In a Job (background processing)

```php
class NotifyApprovers implements ShouldQueue
{
    public function handle()
    {
        $approverIds = User::role('approver')->pluck('id')->toArray();

        WebSocketService::toUsers($approverIds, 'pending-approval', [
            'count' => DemoTrial::where('status', 'pending')->count(),
        ]);
    }
}
```

#### In an Observer

```php
class DemoTrialObserver
{
    public function updated(DemoTrial $trial)
    {
        if ($trial->isDirty('status')) {
            WebSocketService::trigger(
                "private-user.{$trial->user_id}",
                'trial-status-changed',
                [
                    'trial_id' => $trial->id,
                    'old_status' => $trial->getOriginal('status'),
                    'new_status' => $trial->status,
                ]
            );
        }
    }
}
```

---

## Vue Client (Admin Panel)

### Import

```js
import ws from '@/utilities/websocket'
```

### Initialize

```js
// In your main App.vue or layout, after user login:
ws.initWebSocket({
  url: 'wss://websocket.digisaka.app',
  userId: currentUser.id,
})
```

### Subscribe to channels

```js
// Public channel — chainable .on() API
ws.subscribe('alerts')
  .on('new-alert', (data) => {
    console.log('New alert:', data)
    showNotification(data.message)
  })
  .on('alert-resolved', (data) => {
    removeAlert(data.id)
  })

// Listen for all events on a channel
ws.subscribe('updates')
  .on('*', (data, eventName, channel) => {
    console.log(`[${channel}] ${eventName}:`, data)
  })
```

### Unsubscribe

```js
ws.unsubscribe('alerts')
```

### Send messages

```js
// Broadcast to a channel
ws.sendToChannel('chat.room.1', { text: 'Hello!', user: 'Admin' })

// Private message to specific users
ws.sendPrivateMessage(['5', '12'], { text: 'Please check Farm 7' })
```

### Global event listeners

```js
// Listen for an event regardless of channel
ws.on('notification', (data, channel) => {
  showToast(data.title, data.body)
})

// Listen for all events
ws.on('*', (data, eventName, channel) => {
  console.log('Event:', eventName, 'Channel:', channel, 'Data:', data)
})

// Remove listener
ws.off('notification', myHandler)
```

### Reactive state

```js
// In a Vue component:
const isOnline = computed(() => ws.state.isConnected)
const socketId = computed(() => ws.state.socketId)
const messages = computed(() => ws.state.messages)
```

### Disconnect

```js
ws.disconnect()
```

### Identify user (manual)

```js
ws.identify(userId)
```

---

## Flutter Client (Mobile App)

### Import

```dart
import 'package:digisaka/core/services/websocket_service.dart';
```

### Connect

```dart
final ws = WebSocketService();
ws.connect(userId: currentUser.id);
```

### Subscribe to channels

```dart
// Subscribe and listen for specific events (chainable)
ws.subscribe('alerts')
  .on('new-alert', (data) {
    print('New alert: $data');
  })
  .on('alert-resolved', (data) {
    print('Alert resolved: ${data['id']}');
  });

// Wildcard — any event on this channel
ws.subscribe('updates')
  .on('*', (data) {
    print('Update event: $data');
  });
```

### Unsubscribe

```dart
ws.unsubscribe('alerts');
```

### Send messages

```dart
// Broadcast to channel
ws.sendMessage('chat.room.1', {'text': 'Hello!', 'user': 'Field Staff'});

// Private message to users
ws.sendPrivateMessage([5, 12], {'text': 'Check Farm 7'});

// Client event (Pusher convention)
ws.sendClientEvent('presence-chat.1', 'typing', {'user': 'Juan'});
```

### Global event listeners

```dart
// Listen for an event from any channel
ws.on('notification', (data, channel) {
  showLocalNotification(data['title'], data['body']);
});

// Remove listener
ws.off('notification', myCallback);
```

### Streams (reactive)

```dart
// Raw message stream — all events
ws.stream.listen((msg) {
  print('Received: ${msg['event']} on ${msg['channel']}');
});

// Connection state stream
ws.connectionStream.listen((isConnected) {
  print('WebSocket connected: $isConnected');
});
```

### Access socket ID

```dart
print(ws.socketId); // e.g. "123456.7890123"
```

### Disconnect

```dart
ws.disconnect();          // Manual — stops auto-reconnect
ws.disconnect(manual: false); // Temporary — will auto-reconnect
```

### Lifecycle

The service automatically:
- **Disconnects** when the app goes to background.
- **Reconnects** when the app resumes.
- **Resubscribes** to all channels after reconnecting.
- Uses **exponential backoff** (1s, 2s, 4s, 8s, ... up to 30s max).

### Cleanup

```dart
// When the user logs out
ws.dispose();
```

---

## Raw WebSocket Usage

For any language/platform, connect via the standard WebSocket protocol:

### JavaScript (browser/Node.js)

```js
const ws = new WebSocket('wss://websocket.digisaka.app');

ws.onopen = () => {
  // Wait for connection_established, then identify
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);

  if (msg.event === 'connection_established') {
    const data = JSON.parse(msg.data);
    console.log('Socket ID:', data.socket_id);

    // Identify
    ws.send(JSON.stringify({ event: 'identify', user_id: '42' }));

    // Subscribe
    ws.send(JSON.stringify({ event: 'subscribe', channel: 'alerts' }));
  }

  if (msg.event === 'new-alert') {
    console.log('Alert:', JSON.parse(msg.data));
  }
};
```

### Python

```python
import json
import asyncio
import websockets

async def main():
    async with websockets.connect('wss://websocket.digisaka.app') as ws:
        # Receive connection_established
        msg = json.loads(await ws.recv())
        socket_id = json.loads(msg['data'])['socket_id']
        print(f'Connected: {socket_id}')

        # Identify
        await ws.send(json.dumps({'event': 'identify', 'user_id': '42'}))
        await ws.recv()  # identified

        # Subscribe
        await ws.send(json.dumps({'event': 'subscribe', 'channel': 'alerts'}))
        await ws.recv()  # subscription_succeeded

        # Listen for events
        async for message in ws:
            data = json.loads(message)
            print(f"Event: {data['event']}, Data: {data.get('data')}")

asyncio.run(main())
```

### cURL (trigger from server)

```bash
curl -X POST https://websocket.digisaka.app/api/trigger \
  -H "Content-Type: application/json" \
  -H "X-App-Key: your-app-key" \
  -H "X-App-Signature: your-app-secret" \
  -d '{"channel": "alerts", "event": "test", "data": {"msg": "hello"}}'
```

---

## Security

### Authentication Modes

The REST API supports two authentication modes:

1. **Simple secret match** (default for Laravel integration):
   ```
   X-App-Key: <APP_KEY>
   X-App-Signature: <APP_SECRET>
   ```

2. **HMAC-SHA256** (stricter, for exposed environments):
   ```
   X-App-Key: <APP_KEY>
   X-App-Signature: HMAC-SHA256(APP_SECRET, requestBody)
   ```

### Channel Authentication

Private and presence channels require a valid signature:

```
auth = "APP_KEY:" + HMAC-SHA256(APP_SECRET, "socketId:channelName")
```

For presence channels:
```
auth = "APP_KEY:" + HMAC-SHA256(APP_SECRET, "socketId:channelName:channelDataJSON")
```

### Best Practices

- **Change `APP_SECRET`** from the default before deploying.
- **Set `ALLOWED_ORIGINS`** to your actual domains (not `*`).
- **Use TLS** — either terminate at the server (SSL_CERT_PATH) or via a reverse proxy (nginx/Cloudflare).
- **Rate limiting** is enforced per-connection (default: 60 messages/minute).
- **IP connection limits** prevent single-IP abuse (default: 50 connections/IP).
- **Never expose `APP_SECRET`** in client-side code. Channel auth should go through your Laravel backend.

---

## Production Deployment

### With PM2 (recommended)

```bash
npm install -g pm2

# Start
pm2 start server.js --name digisaka-ws

# Auto-restart on crash & server reboot
pm2 save
pm2 startup

# View logs
pm2 logs digisaka-ws

# Monitor
pm2 monit
```

### With systemd (Linux)

```ini
# /etc/systemd/system/digisaka-ws.service
[Unit]
Description=Digisaka WebSocket Server
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/var/www/websocket
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable digisaka-ws
sudo systemctl start digisaka-ws
```

### Nginx Reverse Proxy

```nginx
# wss://websocket.digisaka.app → localhost:6001
upstream websocket {
    server 127.0.0.1:6001;
}

server {
    listen 443 ssl http2;
    server_name websocket.digisaka.app;

    ssl_certificate     /etc/letsencrypt/live/websocket.digisaka.app/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/websocket.digisaka.app/privkey.pem;

    # WebSocket upgrade
    location / {
        proxy_pass http://websocket;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }
}
```

### Production `.env` Checklist

- [ ] `APP_SECRET` — changed to a strong random value (64+ chars)
- [ ] `APP_KEY` — changed to a unique key
- [ ] `ALLOWED_ORIGINS` — set to actual domains only
- [ ] `LOG_LEVEL` — set to `info` or `warn`
- [ ] `MAX_CONNECTIONS_PER_IP` — tuned for expected traffic
- [ ] SSL handled by reverse proxy (no `SSL_CERT_PATH` needed if nginx/Cloudflare)

---

## Monitoring & Debugging

### Dashboard

Open `http://localhost:6001/` in a browser for a real-time dashboard with:
- Connection status and socket ID
- Live stats (connections, channels, memory, uptime)
- Subscribe/unsubscribe to channels
- Send messages
- REST API trigger testing panel

### Health Check

```bash
# Simple check for uptime monitors (Pingdom, UptimeRobot, etc.)
GET http://localhost:6001/health
```

### Server Stats

```bash
# Full stats (authenticated)
curl http://localhost:6001/api/stats \
  -H "X-App-Key: <key>" \
  -H "X-App-Signature: <secret>"
```

### Log Levels

Set `LOG_LEVEL` in `.env`:

| Level | Output |
|---|---|
| `debug` | Everything — message details, heartbeats, subscriptions |
| `info` | Connections, disconnections, subscriptions, API triggers |
| `warn` | Auth failures, rate limits, rejected connections |
| `error` | Uncaught exceptions, socket errors |

Logs are structured JSON, one line per entry:
```json
{"timestamp":"2026-03-10T12:00:00.000Z","level":"INFO","message":"Client connected","socketId":"123456.7890123","ip":"192.168.1.5"}
```

### From Laravel

```php
$stats = WebSocketService::stats();
$channels = WebSocketService::channels();
```

---

## Project Structure

```
websocket/
├── server.js              # Main entry point — Express + WebSocket server
├── package.json           # Dependencies & scripts
├── .env                   # Local config (git-ignored)
├── .env.example           # Config template
├── public/
│   └── index.html         # Dashboard test page
└── src/
    ├── config.js           # Environment-based configuration
    ├── logger.js           # Structured JSON logger with levels
    ├── auth.js             # HMAC-SHA256 auth, socket IDs, API middleware
    ├── connection-manager.js  # Socket tracking, IP limits, user identification
    ├── channel-manager.js     # Public/private/presence channels, broadcasts
    ├── rate-limiter.js        # Sliding-window per-connection rate limiter
    └── api.js                 # Express REST routes (/api/trigger, /health, etc.)
```

### Module Responsibilities

| Module | What it does |
|---|---|
| **server.js** | Wires everything together. Creates HTTP server, WebSocket server, handles connection lifecycle, message routing, heartbeat, graceful shutdown. |
| **config.js** | Loads `.env` via dotenv. Exports a typed config object. |
| **logger.js** | `debug/info/warn/error` methods. JSON output to stdout/stderr. Filterable by level. |
| **auth.js** | `generateSocketId()`, `generateChannelAuth()`, `verifyChannelAuth()`, `apiAuthMiddleware()`. |
| **connection-manager.js** | Maps socketId → ws. Tracks IPs, enforces per-IP limits, user identification, multi-device lookup. |
| **channel-manager.js** | Maps channel → subscribers. Auth gating for private/presence. Presence member tracking. Broadcast and user-targeted sends. |
| **rate-limiter.js** | Sliding window. `consume(key)` returns `{allowed, remaining, retryAfterMs}`. Auto-cleanup of expired entries. |
| **api.js** | Express Router. Health, trigger, broadcast, auth, channels, stats endpoints. All authenticated except `/health`. |

---

## Backward Compatibility

The server accepts both the **new protocol** (`event` field) and the **legacy protocol** (`action` field) for seamless migration:

| New (Pusher-style) | Legacy (v1) | Both work? |
|---|---|---|
| `{ "event": "identify", "user_id": "5" }` | `{ "action": "identify", "userId": "5" }` | Yes |
| `{ "event": "subscribe", "channel": "x" }` | `{ "action": "subscribe", "channel": "x" }` | Yes |
| `{ "event": "unsubscribe", "channel": "x" }` | `{ "action": "unsubscribe", "channel": "x" }` | Yes |
| `{ "event": "message", "channel": "x", ... }` | `{ "action": "message", "channel": "x", ... }` | Yes |

The new protocol adds: `connection_established`, `subscription_succeeded`, auth for private channels, `client-*` events, and the REST API.

---

*Built for Digisaka by Leads Agri Product Corporation.*
