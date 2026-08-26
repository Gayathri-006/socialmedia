ALTER TABLE users ADD COLUMN IF NOT EXISTS follower_count INTEGER NOT NULL DEFAULT 0;

UPDATE users u
SET follower_count = (
  SELECT COUNT(*) FROM follows f WHERE f.following_id = u.id
);

CREATE INDEX IF NOT EXISTS idx_follows_following_id ON follows(following_id);
CREATE INDEX IF NOT EXISTS idx_follows_follower_id ON follows(follower_id);

-- Posts by author, newest first — used by GET /posts/user/:userId
-- and the worker's cold-cache rebuild query.
CREATE INDEX IF NOT EXISTS idx_posts_user_created ON posts (user_id, created_at DESC);

-- Comments by post, oldest first — used by GET /comments/:postId on every cache-miss.
CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments (post_id, created_at ASC);

-- Idempotency: prevents duplicate posts if a client retries a POST
-- (network blip, double-tap, etc). Nullable + partial unique index so
-- existing rows and clients that don't send a key are unaffected.
ALTER TABLE posts ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_posts_idempotency_key
  ON posts (user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;