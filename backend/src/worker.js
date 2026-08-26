const redis = require('./redis');
const pool = require('./db');

const FEED_CACHE_TTL = 300;

async function startWorker() {
  console.log('🤖 Background Pipeline Worker listening for tasks...');

  const blockingClient = redis.duplicate();
  await blockingClient.connect();

  while (true) {
    try {
      const job = await blockingClient.brPop('queue:fanout', 0);
      if (!job) continue;

      const payload = JSON.parse(job.element);

      // --- TASK 1: FANOUT ON WRITE ---
      if (payload.type === 'fanout') {
        const { authorId, postId } = payload;
        
        const followersRes = await pool.query(
          'SELECT follower_id FROM follows WHERE following_id = $1',
          [authorId]
        );

        if (followersRes.rows.length > 0) {
          const multi = redis.multi();
          followersRes.rows.forEach((row) => {
            const followerFeedKey = `feed:${row.follower_id}`;
            multi.lPush(followerFeedKey, postId.toString());
            multi.lTrim(followerFeedKey, 0, 49);
          });
          await multi.exec();
        }
      }

      // --- TASK 2: COLD CACHE REBUILD ---
      if (payload.type === 'rebuild') {
        const { userId } = payload;
        const feedKey = `feed:${userId}`;
        const statusKey = `status:${feedKey}`;

        const result = await pool.query(
          `SELECT posts.id FROM posts
           WHERE posts.user_id = $1
              OR posts.user_id IN (SELECT following_id FROM follows WHERE follower_id = $1)
           ORDER BY posts.created_at DESC
           LIMIT 50`,
          [userId]
        );

        const postIds = result.rows.map((r) => r.id.toString());

        if (postIds.length > 0) {
          const multi = redis.multi();
          multi.del(feedKey); // Clear old structures
          multi.rPush(feedKey, postIds);
          multi.expire(feedKey, FEED_CACHE_TTL);
          await multi.exec();
        }
        
        // Remove tracking lock so it can be verified again down the line
        await redis.del(statusKey);
      }

    } catch (err) {
      console.error('❌ Worker Execution Error:', err);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

startWorker();