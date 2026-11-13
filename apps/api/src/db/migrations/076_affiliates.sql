-- 076: creator partner (affiliate) programme (lib/affiliate-ledger.ts, lib/affiliates.ts, 3 Nov 2026). A partner earns a share of
-- what the people they bring pay (Razorpay on the web, Google Play in the app, net of Google's fee), for as long as they are a
-- partner (status 'active') or, with commission_months set, that many months from each referral. Amounts are in hundredths of the
-- currency (paise, cents), in the currency the customer paid in: never converted, never added across currencies.
CREATE TABLE IF NOT EXISTS affiliates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The partner's code: their link (?ref=CODE, the Play install referrer) and, optionally, a web checkout coupon.
  code               text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9]{4,16}$'),
  name               text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  email              citext,
  -- The partner's own Tablamigo account, when they have one: nobody earns on their own purchases.
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  commission_percent numeric(5,2) NOT NULL DEFAULT 30 CHECK (commission_percent > 0 AND commission_percent <= 50),
  -- NULL: while they are a partner. Otherwise months from each referral.
  commission_months  int CHECK (commission_months IS NULL OR commission_months BETWEEN 1 AND 120),
  -- A Razorpay offer (made in the Razorpay dashboard) applied when the code is used as a web coupon. NULL: the code attributes but
  -- gives no discount.
  razorpay_offer_id  text CHECK (razorpay_offer_id IS NULL OR razorpay_offer_id ~ '^offer_[A-Za-z0-9]{6,40}$'),
  -- Razorpay Route linked account, for automated payouts later. Unused today.
  route_account_id   text CHECK (route_account_id IS NULL OR route_account_id ~ '^acc_[A-Za-z0-9]{6,40}$'),
  payout_note        text CHECK (payout_note IS NULL OR length(payout_note) <= 300),
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One partner per customer, first touch wins.
CREATE TABLE IF NOT EXISTS affiliate_referrals (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  affiliate_id uuid NOT NULL REFERENCES affiliates(id),
  source       text NOT NULL CHECK (source IN ('web_link', 'play_install_referrer', 'signup_code', 'coupon')),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS affiliate_referrals_affiliate ON affiliate_referrals (affiliate_id);

-- One bank/UPI transfer to one partner. The UTR (or UPI RRN) is unique: one transfer is never recorded twice. Commissions in INR
-- and USD are paid in that currency; any other currency is paid in INR at the payout day's rate (owner, 3 Nov 2026): source_* keep
-- what was owed and fx_rate the INR per unit the admin entered.
CREATE TABLE IF NOT EXISTS affiliate_payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES affiliates(id),
  currency     text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  source_currency     text CHECK (source_currency IS NULL OR source_currency ~ '^[A-Z]{3}$'),
  source_amount_minor bigint,
  fx_rate             numeric(14,6) CHECK (fx_rate IS NULL OR fx_rate > 0),
  CHECK ((source_currency IS NULL) = (fx_rate IS NULL) AND (source_currency IS NULL) = (source_amount_minor IS NULL)),
  utr          text NOT NULL UNIQUE CHECK (utr ~ '^[A-Z0-9]{12,22}$'),
  note         text,
  paid_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  paid_at      timestamptz NOT NULL DEFAULT now()
);

-- One row per charge (event_key 'rzp:pay:<payment id>' or 'play:order:<order id>'), and one 'clawback' row (negative) when a charge
-- that was already paid out is refunded or charged back: it comes off the partner's next payout.
CREATE TABLE IF NOT EXISTS affiliate_commissions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id     uuid NOT NULL REFERENCES affiliates(id),
  user_id          uuid REFERENCES users(id) ON DELETE SET NULL,
  provider         text NOT NULL CHECK (provider IN ('razorpay', 'google_play')),
  kind             text NOT NULL DEFAULT 'charge' CHECK (kind IN ('charge', 'clawback')),
  event_key        text NOT NULL UNIQUE,
  product          text,
  gross_minor      bigint NOT NULL,
  fee_minor        bigint NOT NULL DEFAULT 0,
  net_minor        bigint NOT NULL,
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Where the amount came from: Razorpay's payment, Google's developer revenue, Google's order total less tax and fee, or (Google's
  -- order unreadable) the plan's list price less the fee, which the admin shows as an estimate.
  amount_source    text NOT NULL,
  percent          numeric(5,2) NOT NULL,
  commission_minor bigint NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'void')),
  void_reason      text,
  voided_at        timestamptz,
  payout_id        uuid REFERENCES affiliate_payouts(id),
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'charge' AND commission_minor > 0) OR (kind = 'clawback' AND commission_minor < 0)),
  CHECK ((status = 'paid') = (payout_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS affiliate_commissions_owed ON affiliate_commissions (affiliate_id, currency) WHERE status = 'pending';

-- Charges refunded or charged back before any commission was recorded for them (a refund that arrives before a late webhook or
-- RTDN): a later accrual for the same event finds it here and records nothing.
CREATE TABLE IF NOT EXISTS affiliate_voided_events (
  event_key  text PRIMARY KEY,
  reason     text NOT NULL,
  voided_at  timestamptz NOT NULL DEFAULT now()
);
