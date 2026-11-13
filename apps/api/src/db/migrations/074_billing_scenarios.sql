-- 074: billing scenarios (docs/billing-scenarios.md, 2 Nov 2026). Additive and safe on live rows.
-- users.billing_disputed_at: a chargeback was raised on one of this account's web payments (SC-13). While set, no Plus from
-- web purchases or comps, and web checkout is refused; only an admin clears it (SC-14/15). billing_dispute_ref names it.
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_disputed_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS billing_dispute_ref text;
-- subscriptions.ended_reason: 'refund' | 'dispute' | 'halted'. Set = this row never gives Plus again, whatever the store later
-- reports about the paid period (a refunded subscription still shows its paid-up end at Razorpay).
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS ended_reason text;
-- Rows already ended by a refund before this column existed (raw.tablamigo_refund_id; lib/razorpay.ts endSubscriptionRow keeps writing it).
UPDATE subscriptions SET ended_reason = 'refund' WHERE ended_reason IS NULL AND raw ? 'tablamigo_refund_id';
-- One row per chargeback we have acted on (lib/billing-disputes.ts). The first sighting locks the account and ends what the
-- payment paid for; later events and the hourly sweep only alert the owner of a new status, so an admin's clear sticks.
CREATE TABLE IF NOT EXISTS billing_disputes (
  id           text PRIMARY KEY,                 -- Razorpay dispute id (disp_...)
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  payment_id   text NOT NULL,
  status       text,
  amount_minor bigint,
  currency     text,
  respond_by   timestamptz,
  handled_at   timestamptz,                      -- the account was locked and what it paid for ended; null = still to do
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS billing_disputes_user ON billing_disputes (user_id);
-- Local databases that applied an earlier draft of this file (never production) get the column too.
ALTER TABLE billing_disputes ADD COLUMN IF NOT EXISTS handled_at timestamptz;
