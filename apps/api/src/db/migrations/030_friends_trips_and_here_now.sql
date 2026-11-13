-- 030_friends_trips_and_here_now.sql: Backlog 21 (Friends & Follow Feed: upcoming trips of connections)
-- and Backlog 22 ("Who's here now" with opt-in status and snooze)

ALTER TABLE users ADD COLUMN IF NOT EXISTS here_now_opt_in boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS here_now_snooze_until timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS here_now_status text;

CREATE INDEX IF NOT EXISTS users_here_now_idx ON users (city, here_now_opt_in)
  WHERE deleted_at IS NULL AND banned_at IS NULL;
