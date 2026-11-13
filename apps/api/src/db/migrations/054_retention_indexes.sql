-- Migration 054: indexes for the daily retention purge (lib/retention.ts). Each purge selects the rows older than a cut-off by one
-- timestamp column; without these it would scan whole tables (analytics_events grows with every anonymous request).
CREATE INDEX IF NOT EXISTS analytics_events_created_idx ON analytics_events (created_at);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications (created_at);
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);
CREATE INDEX IF NOT EXISTS chat_locations_expires_idx ON chat_locations (expires_at);
CREATE INDEX IF NOT EXISTS plan_shares_expires_idx ON plan_shares (expires_at);
CREATE INDEX IF NOT EXISTS otp_codes_expires_idx ON otp_codes (expires_at);
