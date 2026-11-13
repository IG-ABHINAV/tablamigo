-- 042_activation_funnel_analytics.sql: Indexes and optimizations for activation funnel analytics & cohort retention
-- Tracks user journey: signup -> onboarding_complete -> first_action (plan/trip/dm) -> first_join -> first_meetup (checkin)

CREATE INDEX IF NOT EXISTS analytics_events_user_event_idx ON analytics_events(user_id, event_name, created_at);
CREATE INDEX IF NOT EXISTS activity_members_checked_in_idx ON activity_members(checked_in_at) WHERE checked_in_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_members_user_joined_idx ON activity_members(user_id, joined_at);
CREATE INDEX IF NOT EXISTS users_created_onboarded_idx ON users(created_at, onboarded);
CREATE INDEX IF NOT EXISTS trips_user_created_idx ON trips(user_id, created_at);
CREATE INDEX IF NOT EXISTS activities_host_created_idx ON activities(host_id, created_at);
