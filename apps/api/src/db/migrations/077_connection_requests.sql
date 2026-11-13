-- 077: Connect is a request the other person accepts (4 Nov 2026). Before, POST /users/:id/connect wrote a `connections` row at
-- once, so tapping Connect made two people connected with no say from the other side.
--
-- `connections` keeps meaning "accepted": every query that unlocks something for connected people (chat, moments, friends'
-- trips, trip-match) reads it and needs no change. A request waits in `connection_requests` until the recipient accepts (both
-- directions are written to `connections`), declines, or the sender cancels.
CREATE TABLE IF NOT EXISTS connection_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message       text CHECK (message IS NULL OR length(message) <= 300),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  responded_at  timestamptz,
  -- Set by a decline and kept through a cancel: for 30 days a new request from the same sender is filed as declined without
  -- telling anyone (the sender sees "Requested", as before), so declining can't be undone by cancel-and-ask-again spam.
  declined_at   timestamptz,
  CHECK (sender_id <> recipient_id),
  UNIQUE (sender_id, recipient_id)
);
CREATE INDEX IF NOT EXISTS connection_requests_inbox_idx ON connection_requests (recipient_id, created_at DESC) WHERE status = 'pending';

-- Existing connections stay connected (they were accepted under the old rule). A one-way row (A tapped Connect on B) becomes a
-- pair, so both sides see "Connected" and neither is shown a Connect button for someone already connected to them.
INSERT INTO connections (user_id, friend_id, created_at)
SELECT c.friend_id, c.user_id, c.created_at FROM connections c
ON CONFLICT DO NOTHING;

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN (
    'join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled',
    'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat',
    'recurring_next', 'plan_comment', 'buddy_request', 'buddy_accepted',
    'photo_reaction', 'rsvp_update', 'running_late',
    'id_verification_approved', 'id_verification_rejected', 'ticket_purchased', 'plan_views',
    'connection_request', 'connection_accepted'
  ));
