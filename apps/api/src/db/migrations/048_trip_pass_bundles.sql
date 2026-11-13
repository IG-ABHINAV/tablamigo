-- Migration 048: Trip Pass Bundles, Wallet, and Redemptions Tracking (Backlog 30)

CREATE TABLE IF NOT EXISTS trip_pass_wallet (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('purchase_single', 'purchase_bundle', 'referral_bonus', 'admin_comp')),
  passes_added integer NOT NULL CHECK (passes_added > 0),
  passes_remaining integer NOT NULL CHECK (passes_remaining >= 0),
  price_cents integer,
  currency text DEFAULT 'INR',
  order_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_trip_pass_wallet_user ON trip_pass_wallet(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS trip_pass_redemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wallet_id uuid REFERENCES trip_pass_wallet(id) ON DELETE SET NULL,
  trip_id uuid REFERENCES trips(id) ON DELETE SET NULL,
  days_granted integer NOT NULL DEFAULT 14,
  redeemed_at timestamptz NOT NULL DEFAULT now(),
  plus_until_after timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trip_pass_redemptions_user ON trip_pass_redemptions(user_id, redeemed_at DESC);
