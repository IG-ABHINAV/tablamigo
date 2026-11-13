-- Migration 037: Travel Buddy Matching & Suggested Companions
-- Connects travelers who share destinations, overlapping dates, and travel styles with dedicated buddy requests

CREATE TABLE IF NOT EXISTS travel_buddy_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id uuid REFERENCES trips(id) ON DELETE CASCADE,
  city_key text NOT NULL,
  intro_note text CHECK (char_length(intro_note) <= 300),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
  created_at timestamptz NOT NULL DEFAULT now(),
  responded_at timestamptz,
  CONSTRAINT uq_travel_buddy_request UNIQUE (sender_id, recipient_id, city_key)
);

CREATE INDEX IF NOT EXISTS idx_buddy_requests_recipient ON travel_buddy_requests(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_buddy_requests_sender ON travel_buddy_requests(sender_id, status);
CREATE INDEX IF NOT EXISTS idx_buddy_requests_trip ON travel_buddy_requests(trip_id);

-- Add buddy_request and buddy_accepted kinds to notifications
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled', 'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat', 'recurring_next', 'plan_comment', 'buddy_request', 'buddy_accepted'));
