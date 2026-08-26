const express = require('express');
require('dotenv').config();

const pool = require('./db');
const redis = require('./redis');

const app = express();
app.use(express.json());

// -------------------------------------------------------------------------
// LIVENESS: "is the process up at all". Never checks dependencies — if this
// fails, the orchestrator should restart the container. Keep it instant.
// Mounted immediately (before Redis is ready) so liveness checks never
// depend on Redis — that's what /readyz is for.
// -------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// -------------------------------------------------------------------------
// READINESS: "can this replica actually serve traffic right now". Checks
// real dependencies (Postgres, Redis) with short timeouts.
// -------------------------------------------------------------------------
app.get('/readyz', async (req, res) => {
  const checks = { postgres: false, redis: false };

  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    checks.postgres = true;
  } catch (e) {
    checks.postgres = false;
  }

  try {
    await Promise.race([
      redis.ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
    ]);
    checks.redis = true;
  } catch (e) {
    checks.redis = false;
  }

  const ready = checks.postgres && checks.redis;
  res.status(ready ? 200 : 503).json({ ready, checks });
});

const PORT = process.env.PORT || 3000;
const BACKLOG = 4096; // match net.core.somaxconn so the OS queue isn't the bottleneck

let server;

// -------------------------------------------------------------------------
// BOOTSTRAP: waits for Redis to actually be connected BEFORE requiring the
// route files. This matters because routes (posts/comments/likes) pull in
// rateLimiter.js, whose RedisStore tries to load a Lua script into Redis
// the instant it's constructed — if that happens before the client is
// connected (and disableOfflineQueue is true in redis.js), it fails
// immediately instead of queuing. Delaying the require() until after
// redis.ready resolves guarantees correct ordering regardless of how fast
// each container's Redis connection happens to complete.
// -------------------------------------------------------------------------
async function start() {
  try {
    await redis.ready;
  } catch (err) {
    console.error('❌ Failed to connect to Redis at startup:', err);
    process.exit(1); // fail fast — Docker will restart the container and retry
  }

  const authRoutes = require('./routes/auth');
  const postRoutes = require('./routes/posts');
  const commentRoutes = require('./routes/comments');
  const likeRoutes = require('./routes/likes');
  const followRoutes = require('./routes/follows');

  app.use('/api/auth', authRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/comments', commentRoutes);
  app.use('/api/likes', likeRoutes);
  app.use('/api/follows', followRoutes);

  server = app.listen(PORT, '0.0.0.0', BACKLOG, () => {
    console.log(`Server running on port ${PORT} (PID: ${process.pid}, backlog: ${BACKLOG})`);
  });
}

start();

// -------------------------------------------------------------------------
// GRACEFUL SHUTDOWN: on SIGTERM (what Docker sends on `stop`/redeploy/scale
// down), stop accepting NEW connections but let in-flight requests finish
// before actually exiting.
// -------------------------------------------------------------------------
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — draining in-flight requests before exit...`);

  const forceExitTimer = setTimeout(() => {
    console.error('Shutdown grace period exceeded — forcing exit');
    process.exit(1);
  }, 15000);

  if (!server) {
    process.exit(0);
    return;
  }

  server.close(async (err) => {
    if (err) {
      console.error('Error during server.close():', err);
    }
    try {
      await pool.end();
      console.log('Postgres pool closed.');
    } catch (e) {
      console.error('Error closing Postgres pool:', e);
    }
    try {
      await redis.quit();
      console.log('Redis connection closed.');
    } catch (e) {
      console.error('Error closing Redis connection:', e);
    }
    clearTimeout(forceExitTimer);
    console.log('Graceful shutdown complete.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;