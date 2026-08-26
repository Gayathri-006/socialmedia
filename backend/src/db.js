const { Pool } = require('pg');
require('dotenv').config();

// IMPORTANT: pool `max` is PER PROCESS. With N app replicas + M worker
// replicas, total possible connections to Postgres = N*APP_POOL_MAX + M*WORKER_POOL_MAX.
// That total must stay comfortably under Postgres's own `max_connections`
// (see docker-compose.yml), or you waste Postgres resources on connection
// churn/rejection instead of query work — this was previously oversubscribing
// Postgres (13 processes x 25 = up to 325 vs max_connections=300).
//
// Default here is intentionally conservative; override with POOL_MAX env var
// once the replica sweep confirms final replica counts.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.POOL_MAX || '8', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle DB client', err);
});

module.exports = pool;