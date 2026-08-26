const express = require('express');
const pool = require('../db');
const redis = require('../redis');
const authenticate = require('../middleware/auth');
const dbSafe = require('../dbSafe');
const { writeLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

const COMMENTS_CACHE_TTL = 86400; // 24 hours static life (explicitly cleared on new writes)

// 1. POST /api/comments/:postId - Add a comment, increment stats, and evict list cache
router.post('/:postId', writeLimiter, authenticate, async (req, res) => {
  const { postId } = req.params;
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  try {
    // 1. Write the new comment record to the primary database source of truth
    const result = await pool.query(
      `INSERT INTO comments (post_id, user_id, content) VALUES ($1, $2, $3) RETURNING *`,
      [postId, req.userId, content]
    );
    const newComment = result.rows[0];

    // Fetch username metadata to match client-side UI hydration requirements
    const userRes = await pool.query('SELECT username FROM users WHERE id = $1', [req.userId]);
    newComment.username = userRes.rows[0]?.username || 'unknown';

    // 2. Fragment Update: Atomically increment the comment counter on the merged post hash
    // This instantly reflects across the main feed orchestrator array pipeline
    await redis.hIncrBy(`post:${postId}`, 'comments_count', 1).catch((e) =>
      console.error('Redis metric increment error:', e)
    );

    // 3. Cache Eviction: Delete the cached comment list fragment for this post
    // This forces the next reader to pull a fresh, updated list without data stale lags
    await redis.del(`post:${postId}:comments`).catch((e) =>
      console.error('Redis list eviction error:', e)
    );

    res.status(201).json(newComment);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// 2. GET /api/comments/:postId - High-performance Cache-Aside read for comment threads
router.get('/:postId', async (req, res) => {
  const { postId } = req.params;
  const cacheKey = `post:${postId}:comments`;

  try {
    // 1. Check if the comment list fragment exists inside hot memory
    const cachedComments = await redis.get(cacheKey).catch(() => null);
    if (cachedComments) {
      res.set('X-Cache-Strategy', 'Fragment-Hit');
      return res.json(JSON.parse(cachedComments));
    }

    // 2. Cache Miss: Execute the relational query join out of Postgres.
    // Circuit-breaker protected since this is an uncached, join-heavy fallback path.
    const result = await dbSafe.query(
      `SELECT comments.*, users.username
       FROM comments
       JOIN users ON users.id = comments.user_id
       WHERE post_id = $1
       ORDER BY created_at ASC`,
      [postId]
    );

    // 3. Healing Phase: Write the stringified array fragment back into Redis memory
    // This insulates Postgres from load spikes during high-concurrency read peaks
    await redis.setEx(cacheKey, COMMENTS_CACHE_TTL, JSON.stringify(result.rows)).catch((e) =>
      console.error('Redis cache healing error:', e)
    );

    res.set('X-Cache-Strategy', 'Fragment-Miss-Healed');
    res.json(result.rows);
  } catch (err) {
    if (err.circuitOpen) {
      return res.status(503).json({ error: 'Service temporarily degraded, please retry shortly' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;