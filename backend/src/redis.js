const { createClient } = require('redis');

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  disableOfflineQueue: true, // Prevents memory leaks by failing immediately if Redis drops offline
  socket: {
    connectTimeout: 5000,    // Hard cut-off on connection lag (5s)
    keepAlive: 30000,        // Minimizes frequent TCP handshakes
    reconnectStrategy: (retries) => {
      // Clean exponential backoff
      return Math.min(retries * 50, 2000);
    }
  }
});

client.on('error', (err) => console.error('❌ Redis Client Error:', err));

// IMPORTANT: exported as `client.ready` so callers (server.js) can await
// actual connection before wiring up anything that depends on Redis being
// live — e.g. the rate limiter's RedisStore, which tries to load its Lua
// script into Redis the instant it's constructed. Without this, module
// load order alone doesn't guarantee connection order, since require()
// is synchronous but .connect() is not.
client.ready = client.connect().then(() => {
  console.log('🚀 Main client successfully connected to Redis');
  return client;
});

module.exports = client;