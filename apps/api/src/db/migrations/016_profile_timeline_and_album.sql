-- Migration 016: Profile timeline, privacy toggle and plan photo album
ALTER TABLE users ADD COLUMN hide_plan_history boolean NOT NULL DEFAULT false;

CREATE TABLE activity_photos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url text NOT NULL,
  caption text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activity_photos_activity_idx ON activity_photos (activity_id, created_at ASC);
CREATE INDEX activity_photos_user_idx ON activity_photos (user_id, created_at DESC);
