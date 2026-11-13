-- Migration 050: Paid & Ticketed Events (Workshops, Tours, Masterclasses)
-- Backlog 15: Hosts can charge for ticketed events via Razorpay; digital tickets with verification codes.

ALTER TABLE activities
  ADD COLUMN IF NOT EXISTS is_paid boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ticket_price_paise integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS ticket_currency text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS max_tickets integer DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS tickets_sold integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS payout_upi_id text DEFAULT NULL;

CREATE TABLE IF NOT EXISTS activity_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_code text NOT NULL UNIQUE,
  price_paise integer NOT NULL,
  platform_fee_paise integer NOT NULL DEFAULT 0,
  host_payout_paise integer NOT NULL,
  currency text NOT NULL DEFAULT 'INR',
  status text NOT NULL DEFAULT 'valid' CHECK (status IN ('valid', 'used', 'refunded', 'cancelled')),
  payment_platform text NOT NULL DEFAULT 'razorpay',
  razorpay_order_id text,
  razorpay_payment_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  used_at timestamptz,
  checked_in_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_activity_tickets_activity ON activity_tickets(activity_id, status);
CREATE INDEX IF NOT EXISTS idx_activity_tickets_user ON activity_tickets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_activity_tickets_code ON activity_tickets(ticket_code);
CREATE INDEX IF NOT EXISTS idx_activities_is_paid ON activities(is_paid) WHERE is_paid = true;

-- Update notification kind check constraint to include ticket_purchased
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN (
    'join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled',
    'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat',
    'recurring_next', 'plan_comment', 'buddy_request', 'buddy_accepted',
    'photo_reaction', 'rsvp_update', 'running_late',
    'id_verification_approved', 'id_verification_rejected',
    'ticket_purchased'
  ));
