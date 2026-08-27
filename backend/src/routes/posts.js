const express = require('express');
const pool = require('../db');
const redis = require('../redis');
const authenticate = require('../middleware/auth');
const dbSafe = require('../dbSafe');
const { feedLimiter, writeLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

const FEED_CACHE_TTL = 300;
const POST_FRAGMENT_TTL = 86400;
const CELEBRITY_THRESHOLD = 1000;
const CELEB_LIST_TTL = 600; // Cache followed celeb IDs for 10 minutes

// =========================================================================
// Redis hash sanitization helper
// =========================================================================
// node-redis's hSet only accepts string/number/Buffer values. Rows coming
// back from pg contain real JS Date objects (timestamp columns) and can
// contain `null` (e.g. idempotency_key when a client doesn't send one).
// Spreading either straight into hSet throws synchronously. This was the
// root cause of every single post-creation request 500ing in load testing,
// 100% of the time, completely independent of load — because idempotency_key
// is null on every request that doesn't set the Idempotency-Key header.
function sanitizePostForRedis(row, extra = {}) {
  return {
    id: row.id.toString(),
    user_id: row.user_id.toString(),
    content: row.content,
    username: row.username || '',
    idempotency_key: row.idempotency_key ?? '',
    created_at: row.created_at instanceof Date
      ? row.created_at.toISOString()
      : String(row.created_at),
    likes_count: '0',
    comments_count: '0',
    ...extra,
  };
}

// =========================================================================
// FEED HYDRATION (Single Redis Hash per Post: content + stats merged)
// =========================================================================
async function getHydratedPosts(postIds) {
  if (!postIds || postIds.length === 0) return [];

  const multi = redis.multi();
  postIds.forEach((id) => {
    multi.hGetAll(`post:${id}`);
  });

  const rawResults = await multi.exec();
  const hydratedMap = {};
  const missingPostIds = [];

  for (let i = 0; i < postIds.length; i++) {
    const id = postIds[i];
    const data = rawResults[i];

    if (data && data.id) {
      hydratedMap[id] = {
        ...data,
        likes_count: parseInt(data.likes_count || 0, 10),
        comments_count: parseInt(data.comments_count || 0, 10),
      };
    } else {
      missingPostIds.push(parseInt(id, 10));
    }
  }

  // Batch query all missing post fragments in a single database round-trip.
  // Uses the circuit breaker: if Postgres is struggling, this fails fast
  // instead of hanging every replica's request pool.
  if (missingPostIds.length > 0) {
    const dbResult = await dbSafe.query(
      `SELECT posts.*, users.username 
       FROM posts 
       JOIN users ON users.id = posts.user_id 
       WHERE posts.id = ANY($1::int[])`,
      [missingPostIds]
    );

    const redisMulti = redis.multi();
    dbResult.rows.forEach((row) => {
      const idStr = row.id.toString();
      const hydrated = { ...row, likes_count: 0, comments_count: 0 };
      hydratedMap[idStr] = hydrated;

      // BUGFIX: was spreading `row` directly (Date + possible null values).
      // This was previously failing silently on every cache-fill (masked by
      // the .catch(() => {}) below), meaning the Redis cache for cold-missed
      // posts never actually got populated — every miss stayed a miss forever.
      redisMulti.hSet(`post:${idStr}`, sanitizePostForRedis(row));
      redisMulti.expire(`post:${idStr}`, POST_FRAGMENT_TTL);
    });
    await redisMulti.exec().catch(() => {});
  }

  // Maintain original sorted timeline sequence order
  return postIds
    .map((id) => hydratedMap[id])
    .filter((post) => post && post.id);
}

// =========================================================================
// POST CREATION ROUTE (Optimized Celebrity Tracking)
// =========================================================================
// BUGFIX: middleware order was `writeLimiter, authenticate`. Express runs
// middleware left-to-right, so the rate limiter ran BEFORE authenticate
// had a chance to set req.userId. Its keyGenerator — 
// `req.userId ? String(req.userId) : ipKeyGenerator(req.ip)` — therefore
// always saw req.userId as undefined and fell back to keying by IP. Since
// every k6 VU in local load testing shares the same source IP, all 100
// "distinct" users collapsed into ONE shared rate-limit bucket, capping
// total successes at exactly writeLimiter's max (20) no matter how many
// real distinct users were actually authenticated. Swapping the order so
// authenticate runs first fixes this: req.userId is populated before the
// limiter's keyGenerator ever runs.
router.post('/', authenticate, writeLimiter, async (req, res) => {
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'content required' });

  // Optional idempotency key from client (e.g. generated once per user
  // action, resent unchanged on retry). If a post with this key already
  // exists for this user, return it instead of creating a duplicate —
  // protects against double-submits from network retries/double-taps.
  const idempotencyKey = req.get('Idempotency-Key') || null;

  try {
    if (idempotencyKey) {
      const existing = await pool.query(
        `SELECT * FROM posts WHERE user_id = $1 AND idempotency_key = $2`,
        [req.userId, idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return res.status(200).json(existing.rows[0]); // not 201 — nothing new was created
      }
    }

    const result = await pool.query(
      `INSERT INTO posts (user_id, content, idempotency_key) VALUES ($1, $2, $3) RETURNING *`,
      [req.userId, content, idempotencyKey]
    );
    const newPost = result.rows[0];

    const userRes = await pool.query(
      'SELECT username, follower_count FROM users WHERE id = $1',
      [req.userId]
    );
    const authorRow = userRes.rows[0];
    newPost.username = authorRow?.username;

    const postIdStr = newPost.id.toString();

    // BUGFIX: was `{...newPost, id: ..., user_id: ..., likes_count: '0',
    // comments_count: '0'}` — spread `newPost` includes created_at as a real
    // Date object and idempotency_key as `null` on every request that
    // doesn't send an Idempotency-Key header. node-redis's hSet throws
    // synchronously on either, which was caught below and returned as a
    // 500 on 100% of post-creation requests, regardless of load.
    await redis.hSet(`post:${postIdStr}`, sanitizePostForRedis(newPost));
    await redis.expire(`post:${postIdStr}`, POST_FRAGMENT_TTL);

    await redis.lPush(`feed:${req.userId}`, postIdStr);
    await redis.lTrim(`feed:${req.userId}`, 0, 49);

    const followerCount = authorRow?.follower_count || 0;

    if (followerCount < CELEBRITY_THRESHOLD) {
      const jobPayload = JSON.stringify({
        type: 'fanout',
        authorId: req.userId,
        postId: postIdStr,
      });
      await redis.lPush('queue:fanout', jobPayload);
    } else {
      // CELEBRITY PATH: Maintain an isolated timeline for the celebrity in Redis
      await redis.sAdd('celebrity_authors', req.userId.toString());
      await redis.lPush(`celebrity:posts:${req.userId}`, postIdStr);
      await redis.lTrim(`celebrity:posts:${req.userId}`, 0, 19);
    }

    res.status(201).json(newPost);
  } catch (err) {
    if (err.code === '23505' && idempotencyKey) {
      // Race condition: another concurrent request with the same key won.
      // Fetch and return that post instead of surfacing a 500.
      const existing = await pool.query(
        `SELECT * FROM posts WHERE user_id = $1 AND idempotency_key = $2`,
        [req.userId, idempotencyKey]
      );
      if (existing.rows.length > 0) {
        return res.status(200).json(existing.rows[0]);
      }
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// =========================================================================
// FEED READ ROUTE (rate-limited + circuit-breaker protected)
// =========================================================================
// BUGFIX: same middleware-order issue as above — was
// `feedLimiter, authenticate`, now `authenticate, feedLimiter`.
router.get('/feed', authenticate, feedLimiter, async (req, res) => {
  const feedKey = `feed:${req.userId}`;
  const statusKey = `status:${feedKey}`;
  const celebCacheKey = `user:${req.userId}:followed_celebs`;

  try {
    // 1. Fetch home timeline from Redis
    let postIds = await redis.lRange(feedKey, 0, 49).catch(() => []);

    // 2. Cold Cache Background Regeneration Trigger
    if (postIds.length === 0) {
      const isRebuilding = await redis.get(statusKey).catch(() => null);
      if (!isRebuilding) {
        await redis.setEx(statusKey, 15, 'processing');
        const rebuildPayload = JSON.stringify({ type: 'rebuild', userId: req.userId });
        await redis.lPush('queue:fanout', rebuildPayload);
      }
    }

    // 3. Redis-Optimized Celebrity Merge Logic
    let celebIds = [];
    const cachedCelebs = await redis.get(celebCacheKey).catch(() => null);

    if (cachedCelebs) {
      celebIds = JSON.parse(cachedCelebs);
    } else {
      // Cache miss on the celeb mapping list -> fetch once and keep in memory.
      // Circuit-breaker protected: this join is the query most likely to
      // slow down under load, so it's the one most worth failing fast on.
      const followingCelebs = await dbSafe.query(
        `SELECT u.id FROM users u
         JOIN follows f ON f.following_id = u.id
         WHERE f.follower_id = $1 AND u.follower_count >= $2`,
        [req.userId, CELEBRITY_THRESHOLD]
      ).catch(() => ({ rows: [] }));

      celebIds = followingCelebs.rows.map((r) => r.id.toString());
      await redis.setEx(celebCacheKey, CELEB_LIST_TTL, JSON.stringify(celebIds));
    }

    let mergedPostIds = postIds;

    // If user follows celebs, fetch their recent posts entirely from Redis memory structures
    if (celebIds.length > 0) {
      const multiCeleb = redis.multi();
      celebIds.forEach((id) => {
        multiCeleb.lRange(`celebrity:posts:${id}`, 0, 19);
      });
      const celebResults = await multiCeleb.exec();

      // Flatten out all recovered post IDs arrays into a single list
      const celebPostIds = celebResults.flat().filter(Boolean);

      mergedPostIds = [...new Set([...postIds, ...celebPostIds])].slice(0, 50);
    }

    // 4. Memory Hydration
    const posts = await getHydratedPosts(mergedPostIds);

    res.set('X-Cache-Strategy', postIds.length > 0 ? 'Pure-Cache-Stream' : 'Async-Warmup-Dispatched');
    res.json(posts);
  } catch (err) {
    if (err.circuitOpen) {
      return res.status(503).json({ error: 'Service temporarily degraded, please retry shortly' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/user/:userId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id FROM posts WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [req.params.userId]
    );
    const postIds = result.rows.map((r) => r.id.toString());
    const posts = await getHydratedPosts(postIds);
    res.json(posts);
  } catch (err) {
    if (err.circuitOpen) {
      return res.status(503).json({ error: 'Service temporarily degraded, please retry shortly' });
    }
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;