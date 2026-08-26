const CircuitBreaker = require('opossum');
const pool = require('./db');

// Wraps every Postgres query in a circuit breaker. If queries start
// failing or timing out repeatedly, the breaker "opens" and fails fast
// for a cooldown period instead of letting requests queue up behind a
// struggling database — this prevents one slow dependency from
// cascading into total request pileup across all app replicas.
const breakerOptions = {
  timeout: 3000,             // if a query takes >3s, treat it as a failure
  errorThresholdPercentage: 50, // open the breaker if 50% of recent calls fail
  resetTimeout: 10000,       // after 10s, try again (half-open state)
  rollingCountTimeout: 10000,
  rollingCountBuckets: 10,
};

async function rawQuery(text, params) {
  return pool.query(text, params);
}

const breaker = new CircuitBreaker(rawQuery, breakerOptions);

breaker.on('open', () => {
  console.error('🔴 Circuit breaker OPEN — Postgres is failing, rejecting queries fast');
});
breaker.on('halfOpen', () => {
  console.warn('🟡 Circuit breaker HALF-OPEN — testing Postgres recovery');
});
breaker.on('close', () => {
  console.log('🟢 Circuit breaker CLOSED — Postgres recovered');
});

// Fallback: what to return when the breaker is open. For read paths this
// lets the app degrade gracefully (e.g. serve stale/empty data) instead
// of hanging; for write paths the caller should catch this and return 503.
breaker.fallback(() => {
  const err = new Error('Database temporarily unavailable — circuit open');
  err.circuitOpen = true;
  throw err;
});

// Drop-in replacement for pool.query — same signature
async function query(text, params) {
  return breaker.fire(text, params);
}

module.exports = { query, breaker };