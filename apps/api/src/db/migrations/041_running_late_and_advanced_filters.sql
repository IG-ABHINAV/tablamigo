-- Migration 041: Plan Running Late Quick Status & Advanced Discovery Filters
-- Backlog 11: "Running late" quick message & status for plan attendees
-- Backlog 30: Advanced traveler filters (verified status, travel style, languages)

-- 1. Running late tracking on activity_members
ALTER TABLE activity_members ADD COLUMN IF NOT EXISTS running_late_mins integer CHECK (running_late_mins > 0);
ALTER TABLE activity_members ADD COLUMN IF NOT EXISTS running_late_at timestamptz;
ALTER TABLE activity_members ADD COLUMN IF NOT EXISTS running_late_note text;

CREATE INDEX IF NOT EXISTS idx_activity_members_running_late ON activity_members(activity_id) WHERE running_late_mins IS NOT NULL;

-- 2. Add running_late kind to notifications
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled', 'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat', 'recurring_next', 'plan_comment', 'buddy_request', 'buddy_accepted', 'photo_reaction', 'rsvp_update', 'running_late'));

-- 3. Optimization indexes for traveler discovery
CREATE INDEX IF NOT EXISTS idx_users_verified_onboarded ON users(verified) WHERE verified = true AND onboarded = true;
CREATE INDEX IF NOT EXISTS idx_users_travel_style ON users USING gin(travel_style);
CREATE INDEX IF NOT EXISTS idx_users_languages ON users USING gin(languages);
