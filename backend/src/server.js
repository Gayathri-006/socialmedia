const express = require('express');
require('dotenv').config();

const pool = require('./db');
const redis = require('./redis');

const app = express();

// Enable proxy trust so Express reads X-Forwarded-For headers from k6 load tests
app.set('trust proxy', true);

app.use(express.json());

// -------------------------------------------------------------------------
// LIVENESS
// -------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// -------------------------------------------------------------------------
// READINESS
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
const BACKLOG = 4096;

let server;

// -------------------------------------------------------------------------
// BOOTSTRAP
// -------------------------------------------------------------------------
async function start() {
  try {
    await redis.ready;
  } catch (err) {
    console.error('❌ Failed to connect to Redis at startup:', err);
    process.exit(1);
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

  // Global Error Handler (Logs 500 errors to terminal for debugging)
  app.use((err, req, res, next) => {
    console.error('🔥 Global Server Error:', err.stack || err.message || err);
    res.status(500).json({ error: 'Internal Server Error', details: err.message });
  });

  server = app.listen(PORT, '0.0.0.0', BACKLOG, () => {
    console.log(`Server running on port ${PORT} (PID: ${process.pid}, backlog: ${BACKLOG})`);
  });
}

start();

// -------------------------------------------------------------------------
// GRACEFUL SHUTDOWN
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