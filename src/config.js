import dotenv from 'dotenv';
dotenv.config();

const config = {
  // Server
  port: parseInt(process.env.PORT || '6001', 10),
  host: process.env.HOST || '0.0.0.0',

  // App credentials
  appId: process.env.APP_ID || 'digisaka',
  appKey: process.env.APP_KEY || 'digisaka-ws-key-2026',
  appSecret: process.env.APP_SECRET || 'digisaka-ws-secret-change-me-in-production',

  // CORS
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()),

  // Auth callback URL — Laravel validates private/presence channel subscriptions
  authEndpoint: process.env.AUTH_ENDPOINT || 'http://localhost:8000/api/broadcasting/auth',

  // Rate limiting (per connection)
  rateLimit: {
    points: parseInt(process.env.RATE_LIMIT_POINTS || '60', 10),    // max events
    duration: parseInt(process.env.RATE_LIMIT_DURATION || '60', 10), // per N seconds
  },

  // Heartbeat
  heartbeatInterval: parseInt(process.env.HEARTBEAT_INTERVAL || '25000', 10),

  // Limits
  maxConnectionsPerIp: parseInt(process.env.MAX_CONNECTIONS_PER_IP || '50', 10),
  maxPayloadSize: parseInt(process.env.MAX_PAYLOAD_SIZE || '65536', 10),

  // Logging
  logLevel: process.env.LOG_LEVEL || 'info',

  // Dashboard password (empty string = no protection)
  dashboardPassword: process.env.DASHBOARD_PASSWORD || '',

  // SSL
  sslCertPath: process.env.SSL_CERT_PATH || null,
  sslKeyPath: process.env.SSL_KEY_PATH || null,
};

export default config;
