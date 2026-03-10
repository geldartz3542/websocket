import crypto from 'crypto';
import config from './config.js';
import logger from './logger.js';

/**
 * Generate a unique socket ID (Pusher-style: "123456.7890123")
 */
export function generateSocketId() {
  const part1 = Math.floor(Math.random() * 1000000000);
  const part2 = Math.floor(Math.random() * 10000000);
  return `${part1}.${part2}`;
}

/**
 * Validate an API request's HMAC signature.
 * Signature = HMAC-SHA256(appSecret, body)
 *
 * @param {string} appKey    The app key from request
 * @param {string} signature The signature from request header
 * @param {string} body      The raw request body
 * @returns {boolean}
 */
export function validateSignature(appKey, signature, body) {
  if (appKey !== config.appKey) {
    logger.warn('Invalid app key', { appKey });
    return false;
  }

  const expected = crypto
    .createHmac('sha256', config.appSecret)
    .update(body)
    .digest('hex');

  return crypto.timingSafeEqual(
    Buffer.from(signature, 'hex'),
    Buffer.from(expected, 'hex')
  );
}

/**
 * Generate the auth signature for a private/presence channel.
 * Compatible with Pusher's auth format:
 *   signature = HMAC-SHA256(secret, socketId:channelName)
 *
 * @param {string} socketId
 * @param {string} channel
 * @param {object|null} channelData  For presence channels
 * @returns {string}  "appKey:signature"
 */
export function generateChannelAuth(socketId, channel, channelData = null) {
  let stringToSign = `${socketId}:${channel}`;

  if (channelData) {
    stringToSign += `:${JSON.stringify(channelData)}`;
  }

  const signature = crypto
    .createHmac('sha256', config.appSecret)
    .update(stringToSign)
    .digest('hex');

  return `${config.appKey}:${signature}`;
}

/**
 * Verify client-provided channel auth token.
 *
 * @param {string} socketId
 * @param {string} channel
 * @param {string} authToken   "appKey:signature"
 * @param {object|null} channelData
 * @returns {boolean}
 */
export function verifyChannelAuth(socketId, channel, authToken, channelData = null) {
  const expected = generateChannelAuth(socketId, channel, channelData);
  if (authToken.length !== expected.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(authToken),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

/**
 * Middleware: Validate REST API requests.
 * Expects header: X-App-Key, X-App-Signature
 */
export function apiAuthMiddleware(req, res, next) {
  const appKey = req.headers['x-app-key'];
  const signature = req.headers['x-app-signature'];

  if (!appKey || !signature) {
    return res.status(401).json({
      error: 'Missing authentication headers (X-App-Key, X-App-Signature)',
    });
  }

  // For simple deployments, allow key+secret match without HMAC
  // (when X-App-Signature equals the raw secret — simpler for Laravel integration)
  if (appKey === config.appKey && signature === config.appSecret) {
    return next();
  }

  // Full HMAC validation for stricter security
  try {
    const body = typeof req.rawBody === 'string' ? req.rawBody : JSON.stringify(req.body);
    if (validateSignature(appKey, signature, body)) {
      return next();
    }
  } catch (e) {
    logger.debug('HMAC validation failed, trying direct secret match', { error: e.message });
  }

  return res.status(403).json({ error: 'Invalid authentication' });
}
