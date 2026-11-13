-- Migration 040: Plan RSVP States (Going, Maybe, Waitlist) and Weekend/Category Filtering
-- Enhances RSVP handling with dedicated Maybe interest state, attendee breakdowns, and notifications

CREATE INDEX IF NOT EXISTS idx_activity_members_rsvp ON activity_members(activity_id, rsvp_status);
CREATE INDEX IF NOT EXISTS idx_activities_category_starts ON activities(category, starts_at) WHERE status = 'active';

-- Add rsvp_update kind to notifications
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled', 'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat', 'recurring_next', 'plan_comment', 'buddy_request', 'buddy_accepted', 'photo_reaction', 'rsvp_update'));
