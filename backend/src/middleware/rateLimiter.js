const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const redis = require('../redis');

// Active by default; disabled only when explicitly set to 'false'
const isRateLimitEnabled = process.env.ENABLE_RATE_LIMIT !== 'false';

let feedLimiter, writeLimiter;

if (!isRateLimitEnabled) {
  // Pass-through middleware for load testing
  feedLimiter = (req, res, next) => next();
  writeLimiter = (req, res, next) => next();
} else {
  // Production Redis-backed rate limiters
  feedLimiter = rateLimit({
    store: new RedisStore({
      sendCommand: (...args) => redis.sendCommand(args),
      prefix: 'rl:feed:',
    }),
    windowMs: 60 * 1000,     // 1 minute window
    max: 120,                // 120 requests/min per user
    standardHeaders: true,   
    legacyHeaders: false,
    keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
    message: { error: 'Too many requests, please slow down.' },
  });

  writeLimiter = rateLimit({
    store: new RedisStore({
      sendCommand: (...args) => redis.sendCommand(args),
      prefix: 'rl:write:',
    }),
    windowMs: 60 * 1000,
    max: 20, 
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => (req.userId ? String(req.userId) : ipKeyGenerator(req.ip)),
    message: { error: 'Too many requests, please slow down.' },
  });
}

module.exports = { feedLimiter, writeLimiter };