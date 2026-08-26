const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../redis');

// IMPORTANT: uses the shared Redis instance so rate limits are enforced
// consistently across ALL app replicas, not per-container. An in-memory
// store here would let a client bypass limits simply by landing on a
// different replica via nginx's round-robin.
const feedLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redis.sendCommand(args),
    prefix: 'rl:feed:',
  }),
  windowMs: 60 * 1000,     // 1 minute window
  max: 120,                // 120 requests/min per user (2/sec sustained) — tune based on real usage
  standardHeaders: true,   // sends RateLimit-* headers so clients can self-throttle
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)), // per authenticated user, fallback to normalized IP
  message: { error: 'Too many requests, please slow down.' },
});

const writeLimiter = rateLimit({
  store: new RedisStore({
    sendCommand: (...args) => redis.sendCommand(args),
    prefix: 'rl:write:',
  }),
  windowMs: 60 * 1000,
  max: 20, // writes (posts/likes/comments) are more expensive — tighter limit
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
  message: { error: 'Too many requests, please slow down.' },
});

module.exports = { feedLimiter, writeLimiter };