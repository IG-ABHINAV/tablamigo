-- Migration 034: Saved / Bookmarked Plans (Offline Caching & Bookmarks)
-- Backlog 32, 7: Allows solo travelers to save/bookmark plans to revisit later or browse offline

CREATE TABLE IF NOT EXISTS saved_activities (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, activity_id)
);

CREATE INDEX IF NOT EXISTS saved_activities_user_idx ON saved_activities (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS saved_activities_activity_idx ON saved_activities (activity_id);
