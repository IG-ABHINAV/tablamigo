-- 078: self-serve partner sign-up (lib/partner-signup.ts, routes/partner.ts, 4 Nov 2026). A signed-in member accepts the partner
-- terms in the app or web app and becomes a partner at once, at the default 30% while they are a partner; the code is made by the
-- server. Partners the admin adds (Admin > Affiliates) stay 'admin'.
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'self'));
-- The terms the member accepted (the version is the date on the website's and the app's terms) and when.
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS terms_version text CHECK (terms_version IS NULL OR terms_version ~ '^\d{4}-\d{2}-\d{2}$');
ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS terms_accepted_at timestamptz;
ALTER TABLE affiliates DROP CONSTRAINT IF EXISTS affiliates_self_has_terms;
ALTER TABLE affiliates ADD CONSTRAINT affiliates_self_has_terms
  CHECK (source = 'admin' OR (terms_version IS NOT NULL AND terms_accepted_at IS NOT NULL));
-- One self sign-up per member, whatever races.
CREATE UNIQUE INDEX IF NOT EXISTS affiliates_one_self_per_user ON affiliates (user_id) WHERE source = 'self' AND user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS affiliates_user ON affiliates (user_id) WHERE user_id IS NOT NULL;

-- Where to send a partner's money: a UPI ID or an Indian bank account, AES-256-GCM encrypted (lib/partner-signup.ts sealPayout);
-- `masked` is what the partner and the admin list show. Only the admin's partner detail opens `sealed`.
CREATE TABLE IF NOT EXISTS affiliate_payout_details (
  affiliate_id uuid PRIMARY KEY REFERENCES affiliates(id) ON DELETE CASCADE,
  method       text NOT NULL CHECK (method IN ('upi', 'bank')),
  sealed       text NOT NULL CHECK (sealed ~ '^v1:'),
  masked       text NOT NULL CHECK (length(masked) BETWEEN 1 AND 80),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
