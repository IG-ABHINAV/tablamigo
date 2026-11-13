-- 067: when the app last asked this person for a store rating (lib/review-ask.ts, POST /me/review-ask).
--
-- One timestamp per person, shared by every surface (the Android and iOS store sheet, the web app's "Rate us on Google Play"
-- card), so one ask covers all of their devices for 60 days and a reinstall or a second phone doesn't ask again.
-- review_ask_surface only says where the last ask was made.
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_asked_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS review_ask_surface text CHECK (review_ask_surface IN ('android', 'ios', 'web'));

-- The ask is earned by sending 3 chat messages (any chat); the claim counts them per sender, which no index covered.
CREATE INDEX IF NOT EXISTS messages_sender_idx ON messages (sender_id) WHERE sender_id IS NOT NULL AND kind <> 'system';
