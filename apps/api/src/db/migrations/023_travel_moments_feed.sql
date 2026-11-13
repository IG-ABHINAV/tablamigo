-- 023_travel_moments_feed.sql: Travel Moments Feed (UGC social feed, viral sharing, likes & comments)

CREATE TABLE IF NOT EXISTS moments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city varchar(100),
  country_code varchar(2),
  location geography(Point, 4326),
  image_url text NOT NULL,
  caption text NOT NULL,
  category varchar(32) NOT NULL DEFAULT 'general',
  activity_id uuid REFERENCES activities(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS moments_user_idx ON moments(user_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS moments_city_idx ON moments(city, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS moments_created_idx ON moments(created_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS moment_likes (
  moment_id uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (moment_id, user_id)
);

CREATE INDEX IF NOT EXISTS moment_likes_moment_idx ON moment_likes(moment_id);

CREATE TABLE IF NOT EXISTS moment_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  moment_id uuid NOT NULL REFERENCES moments(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS moment_comments_moment_idx ON moment_comments(moment_id, created_at ASC) WHERE deleted_at IS NULL;

-- Allow 'moment_like' and 'moment_comment' notifications in inbox
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS moment_id uuid REFERENCES moments(id) ON DELETE CASCADE;
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join','vouch','profile_view','verified','verify_rejected','cancelled','connection','plus','moment_like','moment_comment'));
