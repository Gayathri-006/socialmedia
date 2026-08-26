const express = require('express');
const pool = require('../db');
const redis = require('../redis');
const authenticate = require('../middleware/auth');
const { writeLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// NOTE ON CIRCUIT BREAKER: this file uses pool.connect() to hold a single
// client across a BEGIN/COMMIT/ROLLBACK transaction. The circuit breaker
// (dbSafe.js) wraps single independent pool.query() calls and has a
// fallback that throws immediately when open — that pattern doesn't
// compose safely with a held transactional client, because the breaker
// has no way to know a transaction is in-flight and could "fail fast" on
// one statement mid-transaction, leaving the client connection dangling
// without a ROLLBACK. Wrapping transactional flows in a breaker safely
// requires wrapping the entire BEGIN...COMMIT block as one unit, which
// changes error handling semantics enough that it deserves its own
// dedicated pass rather than a quick copy-paste here.
// Rate limiting is still applied, since that protects Postgres regardless.

router.post('/:userId', writeLimiter, authenticate, async (req, res) => {
  const followingId = req.params.userId;

  if (parseInt(followingId, 10) === req.userId) {
    return res.status(400).json({ error: "Can't follow yourself" });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO follows (follower_id, following_id) VALUES ($1, $2)`,
      [req.userId, followingId]
    );

    await client.query(
      `UPDATE users SET follower_count = follower_count + 1 WHERE id = $1`,
      [followingId]
    );

    await client.query('COMMIT');

    await redis.del(`feed:${req.userId}`).catch((e) =>
      console.error('Redis feed eviction error on follow:', e)
    );

    res.status(201).json({ following: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Already following' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

router.delete('/:userId', writeLimiter, authenticate, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const delResult = await client.query(
      `DELETE FROM follows WHERE follower_id = $1 AND following_id = $2`,
      [req.userId, req.params.userId]
    );

    if (delResult.rowCount > 0) {
      await client.query(
        `UPDATE users SET follower_count = GREATEST(follower_count - 1, 0) WHERE id = $1`,
        [req.params.userId]
      );
    }

    await client.query('COMMIT');

    await redis.del(`feed:${req.userId}`).catch((e) =>
      console.error('Redis feed eviction error on unfollow:', e)
    );

    res.json({ following: false });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

module.exports = router;