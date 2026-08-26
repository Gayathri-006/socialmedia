const express = require('express');
const pool = require('../db');
const redis = require('../redis'); // 🟢 Integrated Redis client
const authenticate = require('../middleware/auth');
const dbSafe = require('../dbSafe');
const { writeLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// 1. POST /api/likes/:postId - Atomically increment like counts
router.post('/:postId', writeLimiter, authenticate, async (req, res) => {
  const { postId } = req.params;
  try {
    await pool.query(
      `INSERT INTO likes (post_id, user_id) VALUES ($1, $2)`,
      [postId, req.userId]
    );

    // 🟢 Update Fragment: Atomically increment the 'likes_count' field on the merged post hash
    // This happens entirely in Redis memory in microseconds, bypassing DB read overhead
    await redis.hIncrBy(`post:${postId}`, 'likes_count', 1).catch((e) =>
      console.error('Redis increment error:', e)
    );

    res.status(201).json({ liked: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Already liked' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 2. DELETE /api/likes/:postId - Atomically decrement like counts
router.delete('/:postId', writeLimiter, authenticate, async (req, res) => {
  const { postId } = req.params;
  try {
    const result = await pool.query(
      `DELETE FROM likes WHERE post_id = $1 AND user_id = $2`,
      [postId, req.userId]
    );

    // 🟢 Update Fragment: Only decrement if a row was actually deleted from Postgres
    if (result.rowCount > 0) {
      await redis.hIncrBy(`post:${postId}`, 'likes_count', -1).catch((e) =>
        console.error('Redis decrement error:', e)
      );
    }

    res.json({ liked: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 3. GET /api/likes/:postId/count - Cache-Aside lookup for performance spikes
router.get('/:postId/count', async (req, res) => {
  const { postId } = req.params;
  try {
    // 🟢 Try fragment cache first
    let countStr = await redis.hGet(`post:${postId}`, 'likes_count').catch(() => null);
    if (countStr !== null) {
      res.set('X-Cache-Strategy', 'Fragment-Hit');
      return res.json({ count: parseInt(countStr, 10) });
    }

    // 🔴 Cache Miss Fallback: Query database and heal the hash fragment.
    // Circuit-breaker protected since this is the uncached fallback path.
    const result = await dbSafe.query(
      `SELECT COUNT(*) FROM likes WHERE post_id = $1`,
      [postId]
    );
    const count = parseInt(result.rows[0].count, 10);
    // Write back to the fragment structure so next reads are instant
    await redis.hSet(`post:${postId}`, 'likes_count', count.toString()).catch((e) =>
      console.error('Redis sync error:', e)
    );
    res.set('X-Cache-Strategy', 'Fragment-Miss-Healed');
    res.json({ count });
  } catch (err) {
    if (err.circuitOpen) {
      return res.status(503).json({ error: 'Service temporarily degraded, please retry shortly' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;