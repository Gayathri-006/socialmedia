// loadtest/bulk_seed.js
// Directly inserts into Postgres for speed (bypassing HTTP/bcrypt for bulk volume)
// Run: node bulk_seed.js

const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const NUM_USERS = 500;
const POSTS_PER_USER = 100;   // 500 * 100 = 50,000 posts
const FOLLOWS_PER_USER = 20;  // 500 * 20 = 10,000 follows

async function bulkSeed() {
  console.log('Inserting users...');
  const userIds = [];

  for (let i = 0; i < NUM_USERS; i++) {
    const res = await pool.query(
      `INSERT INTO users (username, email, password_hash)
       VALUES ($1, $2, $3)
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [`bulk_user_${i}`, `bulk_${i}@test.com`, 'dummy_hash_not_for_login']
    );
    if (res.rows[0]) userIds.push(res.rows[0].id);
    if (i % 100 === 0) console.log(`  ${i}/${NUM_USERS} users`);
  }

  console.log(`Created ${userIds.length} users. Inserting posts...`);

  let postCount = 0;
  for (const userId of userIds) {
    const values = [];
    const placeholders = [];
    for (let p = 0; p < POSTS_PER_USER; p++) {
      const idx = p * 2;
      placeholders.push(`($${idx + 1}, $${idx + 2})`);
      values.push(userId, `Bulk post ${p} from user ${userId} - filler content to simulate realistic post length`);
    }
    await pool.query(
      `INSERT INTO posts (user_id, content) VALUES ${placeholders.join(',')}`,
      values
    );
    postCount += POSTS_PER_USER;
    if (postCount % 5000 === 0) console.log(`  ${postCount} posts inserted`);
  }

  console.log(`Inserted ${postCount} posts. Inserting follows...`);

  let followCount = 0;
  for (const userId of userIds) {
    const targets = new Set();
    while (targets.size < FOLLOWS_PER_USER && targets.size < userIds.length - 1) {
      const candidate = userIds[Math.floor(Math.random() * userIds.length)];
      if (candidate !== userId) targets.add(candidate);
    }
    for (const targetId of targets) {
      await pool.query(
        `INSERT INTO follows (follower_id, following_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [userId, targetId]
      );
      followCount++;
    }
    if (followCount % 5000 === 0) console.log(`  ${followCount} follows inserted`);
  }

  console.log(`\nDone. Total: ${userIds.length} users, ${postCount} posts, ${followCount} follows.`);
  await pool.end();
}

bulkSeed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
