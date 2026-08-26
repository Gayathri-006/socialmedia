// seed.js
// Generates a realistic synthetic dataset for load testing:
//   - USER_COUNT real users in Postgres
//   - a follow graph, including a handful of "celebrity" accounts
//     (follower_count >= CELEBRITY_THRESHOLD) so the celebrity fanout
//     code path actually gets exercised under load, not just the
//     normal fanout-on-write path
//   - 1-3 posts per user, so feed reads have real content to hydrate
//   - a signed JWT per user, matching what src/routes/auth.js issues
//
// Run from inside the app container (has pg/bcrypt/jsonwebtoken already):
//   docker compose exec -T app node seed.js > loadtest/users.json
//
// Progress logs go to stderr so stdout stays clean JSON for the redirect.

const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
require('dotenv').config();

const USER_COUNT = 5000;
const CELEBRITY_COUNT = 50;
const CELEBRITY_THRESHOLD = 1000; // must match posts.js
const MIN_FOLLOWS_PER_USER = 5;
const MAX_FOLLOWS_PER_USER = 15;
const MIN_POSTS_PER_USER = 1;
const MAX_POSTS_PER_USER = 3;
const CHUNK_SIZE = 500; // rows per batched INSERT

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function log(...args) {
  console.error(...args); // keep stdout clean for the JSON redirect
}

async function batchInsert(text, rows, columnsPerRow) {
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const values = [];
    const placeholders = chunk.map((row, rIdx) => {
      const base = rIdx * columnsPerRow;
      const ph = row.map((_, cIdx) => `$${base + cIdx + 1}`).join(', ');
      values.push(...row);
      return `(${ph})`;
    });
    await pool.query(`${text} ${placeholders.join(', ')} ON CONFLICT DO NOTHING`, values);
  }
}

async function main() {
  log(`Seeding ${USER_COUNT} users...`);

  // Hash once and reuse — password value is irrelevant for load testing,
  // hashing 5000x individually would just waste minutes for no benefit.
  const dummyHash = await bcrypt.hash('loadtest-password', 10);

  // 1. USERS
  const userRows = [];
  for (let i = 0; i < USER_COUNT; i++) {
    userRows.push([`loadtest_user_${i}_${Date.now()}`, `loadtest_${i}_${Date.now()}@example.com`, dummyHash]);
  }
  await batchInsert(
    'INSERT INTO users (username, email, password_hash) VALUES',
    userRows,
    3
  );

  const idsResult = await pool.query(
    `SELECT id FROM users WHERE username LIKE 'loadtest_user_%' ORDER BY id`
  );
  const userIds = idsResult.rows.map((r) => r.id);
  log(`Inserted ${userIds.length} users. Building follow graph...`);

  // 2. DESIGNATE CELEBRITIES (first N of our seeded users)
  const celebrityIds = userIds.slice(0, CELEBRITY_COUNT);
  const celebritySet = new Set(celebrityIds);

  // 3. FOLLOWS — every user follows a random mix of others, weighted so
  // celebrities accumulate a lot of followers (exercises the celeb path).
  const followRows = [];
  for (const followerId of userIds) {
    const followCount = randInt(MIN_FOLLOWS_PER_USER, MAX_FOLLOWS_PER_USER);
    const candidates = new Set();

    // Bias: every regular user has a good chance to follow 1-3 celebrities
    const celebFollows = randInt(0, Math.min(3, celebrityIds.length));
    for (let i = 0; i < celebFollows; i++) {
      const c = celebrityIds[randInt(0, celebrityIds.length - 1)];
      if (c !== followerId) candidates.add(c);
    }

    while (candidates.size < followCount) {
      const candidate = userIds[randInt(0, userIds.length - 1)];
      if (candidate !== followerId) candidates.add(candidate);
    }

    for (const followingId of candidates) {
      followRows.push([followerId, followingId]);
    }
  }
  await batchInsert(
    'INSERT INTO follows (follower_id, following_id) VALUES',
    followRows,
    2
  );
  log(`Inserted ${followRows.length} follow relationships. Syncing follower_count...`);

  // 4. Sync follower_count from real follow data (same logic as the migration)
  await pool.query(`
    UPDATE users u
    SET follower_count = sub.cnt
    FROM (
      SELECT following_id, COUNT(*) AS cnt
      FROM follows
      GROUP BY following_id
    ) sub
    WHERE u.id = sub.following_id
  `);

  // Force real celebrities over the threshold even if random chance fell short
  await pool.query(
    `UPDATE users SET follower_count = $1 WHERE id = ANY($2::int[]) AND follower_count < $1`,
    [CELEBRITY_THRESHOLD, celebrityIds]
  );
  log('follower_count synced.');

  // 5. POSTS — give every user some content so feeds have something to hydrate
  const postRows = [];
  for (const userId of userIds) {
    const postCount = randInt(MIN_POSTS_PER_USER, MAX_POSTS_PER_USER);
    for (let i = 0; i < postCount; i++) {
      postRows.push([userId, `Load test post ${i} from user ${userId}`]);
    }
  }
  await batchInsert('INSERT INTO posts (user_id, content) VALUES', postRows, 2);
  log(`Inserted ${postRows.length} posts.`);

  // 6. GENERATE JWTS — matches auth.js: jwt.sign({ userId }, JWT_SECRET, ...)
  log('Signing JWTs...');
  const users = userIds.map((id) => ({
    id,
    token: jwt.sign({ userId: id }, process.env.JWT_SECRET, { expiresIn: '30d' }),
  }));

  log(`Done. Writing ${users.length} user tokens to stdout.`);
  process.stdout.write(JSON.stringify(users));

  await pool.end();
}

main().catch((err) => {
  console.error('Seed script failed:', err);
  process.exit(1);
});