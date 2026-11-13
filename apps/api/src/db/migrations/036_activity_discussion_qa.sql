-- Migration 036: Activity Discussion & Public Q&A Comments
-- Allows travelers to ask questions before joining a plan, and enables hosts/attendees to answer publicly.

CREATE TABLE IF NOT EXISTS activity_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body text NOT NULL,
  parent_comment_id uuid REFERENCES activity_comments(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_comments_activity_idx ON activity_comments (activity_id, created_at ASC);
CREATE INDEX IF NOT EXISTS activity_comments_user_idx ON activity_comments (user_id);
CREATE INDEX IF NOT EXISTS activity_comments_parent_idx ON activity_comments (parent_comment_id);

-- Add plan_comment kind to notifications
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled', 'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat', 'recurring_next', 'plan_comment'));
