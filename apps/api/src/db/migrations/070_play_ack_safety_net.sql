-- 070: Google Play purchase acknowledgement, tracked. Google refunds a purchase automatically when it is not acknowledged
-- within 3 days, and lib/play.ts used to fire the acknowledge (or, for a Trip Pass, the consume) and ignore a failure.
-- Now every Play subscription or pass that Google reports as not yet acknowledged gets ack_state 'pending' until it is;
-- lib/play-ack.ts retries the pending ones and emails the owner once when one is still not acknowledged a day after purchase.
--   ack_state       null (nothing to track: settled before this migration, or never needed one), 'pending', 'acknowledged',
--                   'gone' (Google no longer has it as bought: refunded, cancelled before payment, unknown token)
--   ack_since       when Google's 3-day clock started (the purchase time Google reports, else when we first saw it pending)
--   ack_attempts    acknowledge (or consume) calls that failed
--   ack_next_at     when the safety net next tries; null = ack_since + PLAY_ACK_GRACE_HOURS
--   ack_error       the last failure, short, never the token
--   acknowledged_at, ack_alerted_at (the owner's one email)
-- Existing rows stay null: the one paying Play user's purchase is weeks old, so Google has long since kept or refunded it.
ALTER TABLE subscriptions
  ADD COLUMN ack_state text CHECK (ack_state IN ('pending', 'acknowledged', 'gone')),
  ADD COLUMN ack_since timestamptz,
  ADD COLUMN ack_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN ack_next_at timestamptz,
  ADD COLUMN ack_error text,
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN ack_alerted_at timestamptz;
ALTER TABLE passes
  ADD COLUMN ack_state text CHECK (ack_state IN ('pending', 'acknowledged', 'gone')),
  ADD COLUMN ack_since timestamptz,
  ADD COLUMN ack_attempts int NOT NULL DEFAULT 0,
  ADD COLUMN ack_next_at timestamptz,
  ADD COLUMN ack_error text,
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN ack_alerted_at timestamptz;
CREATE INDEX subscriptions_ack_pending_idx ON subscriptions (ack_since) WHERE ack_state = 'pending';
CREATE INDEX passes_ack_pending_idx ON passes (ack_since) WHERE ack_state = 'pending';
