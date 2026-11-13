-- Backlog 21, 23, 24: Connections (Friends/Follow), Travel Buddy Matching, and Referral System (+7 days Plus)

CREATE TABLE IF NOT EXISTS connections (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);

CREATE INDEX IF NOT EXISTS connections_friend_idx ON connections (friend_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code text UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- Generate default 8-character referral code for users without one
UPDATE users
SET referral_code = upper(substring(replace(gen_random_uuid()::text, '-', ''), 1, 8))
WHERE referral_code IS NULL;
