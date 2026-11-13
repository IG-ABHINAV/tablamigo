-- Migration 035: Community City Tips & Local Hidden Gems (UGC Recommendations & Upvotes)
-- Backlog 25: Allows travelers to share insider recommendations, hidden gems, and helpful tips per city.

CREATE TABLE IF NOT EXISTS city_tips (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_slug text NOT NULL,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category varchar(32) NOT NULL DEFAULT 'general' CHECK (category IN ('food', 'sunset', 'coworking', 'nightlife', 'safety', 'transit', 'general')),
  title varchar(120) NOT NULL,
  body text NOT NULL,
  place_name varchar(160),
  helpful_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS city_tips_slug_idx ON city_tips (city_slug, created_at DESC);
CREATE INDEX IF NOT EXISTS city_tips_helpful_idx ON city_tips (city_slug, helpful_count DESC);
CREATE INDEX IF NOT EXISTS city_tips_user_idx ON city_tips (user_id);

CREATE TABLE IF NOT EXISTS city_tip_upvotes (
  tip_id uuid NOT NULL REFERENCES city_tips(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tip_id, user_id)
);
