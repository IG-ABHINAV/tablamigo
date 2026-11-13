-- 022_growth_monetization_analytics.sql: Profile boost, incognito mode, trip pass bundles, and activation analytics

-- 1. Profile boost: ranks user first in nearby travelers and city lists for 24h
ALTER TABLE users ADD COLUMN IF NOT EXISTS boosted_until timestamptz DEFAULT NULL;
CREATE INDEX IF NOT EXISTS users_boosted_until_idx ON users(boosted_until) WHERE boosted_until IS NOT NULL;

-- 2. Incognito mode: Plus users can browse other traveler profiles anonymously without leaving profile view records
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_incognito boolean NOT NULL DEFAULT false;

-- 3. Trip pass bundles: allows holding multiple 14-day trip passes to activate on demand
ALTER TABLE users ADD COLUMN IF NOT EXISTS trip_passes_available integer NOT NULL DEFAULT 0;

-- 4. Analytics events: tracks product activation funnel metrics (signup -> first trip -> first join -> first meetup)
CREATE TABLE IF NOT EXISTS analytics_events (
  id serial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  event_name varchar(64) NOT NULL,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_events_user_idx ON analytics_events(user_id);
CREATE INDEX IF NOT EXISTS analytics_events_name_created_idx ON analytics_events(event_name, created_at DESC);
