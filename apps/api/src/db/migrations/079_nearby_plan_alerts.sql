-- 079: "Notify me when someone near me posts" (Explore's empty state, lib/nearby-alerts.ts, 12 Nov 2026). Off unless the person
-- switches it on. A new plan within 50 km of their saved location then reaches them as a push (notification_log kind
-- 'nearby_plan', ref = the plan id, one per plan), with the email ladder as the fallback when they have no push token.
ALTER TABLE users ADD COLUMN IF NOT EXISTS nearby_plan_alerts boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS users_nearby_plan_alerts_idx ON users USING gist (location) WHERE nearby_plan_alerts;
