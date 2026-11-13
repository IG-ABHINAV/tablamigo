-- Migration 039: Plan Photo Album Reactions and Social Highlights
-- Enables travelers to like and react to photos posted in plan albums

CREATE TABLE IF NOT EXISTS activity_photo_reactions (
  photo_id uuid NOT NULL REFERENCES activity_photos(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji text NOT NULL DEFAULT '❤️' CHECK (emoji IN ('❤️', '🔥', '🙌', '👏', '😍')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (photo_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_activity_photo_reactions_photo ON activity_photo_reactions(photo_id);

-- Add photo_reaction kind to notifications
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled', 'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat', 'recurring_next', 'plan_comment', 'buddy_request', 'buddy_accepted', 'photo_reaction'));
