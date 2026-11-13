-- 051_saved_plans_and_offline_sync.sql: Backlog 32 (Offline Caching, Personal Notes & Plan Bookmarks Auto-Sync)
-- Enhances saved_activities with private traveler notes, offline cache timestamps, and sync tracking

ALTER TABLE saved_activities ADD COLUMN IF NOT EXISTS notes text CHECK (char_length(notes) <= 500);
ALTER TABLE saved_activities ADD COLUMN IF NOT EXISTS cached_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE saved_activities ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS saved_activities_updated_idx ON saved_activities (user_id, updated_at DESC);
