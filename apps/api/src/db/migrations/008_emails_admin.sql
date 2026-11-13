-- Customer emails and the admin panel.

-- Opt-outs for the optional emails, e.g. {"digest": false}. Keys: digest, activity, reminders, all.
-- Transactional emails (codes, receipts, payment problems, verification results, deletion) ignore it.
ALTER TABLE users ADD COLUMN email_prefs jsonb NOT NULL DEFAULT '{}';

-- One row per email we decided to send. The unique key (kind, user, period) is what makes the
-- scheduler idempotent: a row is claimed before sending, so a restart or a second run never sends
-- it again. A failed send may be retried (attempts), a claimed-but-crashed one never is.
CREATE TABLE email_log (
  id          bigserial PRIMARY KEY,
  kind        text NOT NULL,
  user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  period_key  text NOT NULL,          -- 'once', a purchase token, a date, an ISO week, '<plan id>:<6h slot>'
  ref         text,                   -- what it is about (plan id, purchase token) for batching queries
  to_email    text,
  subject     text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts    int NOT NULL DEFAULT 1,
  error       text,
  provider_id text,
  meta        jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE UNIQUE INDEX email_log_once ON email_log (kind, user_id, period_key);
CREATE INDEX email_log_ref_idx ON email_log (kind, ref, created_at DESC);
CREATE INDEX email_log_created_idx ON email_log (created_at DESC);

-- Purchases made before this migration must not get a "Plus started" receipt on the first run.
INSERT INTO email_log (kind, user_id, period_key, ref, status, error)
  SELECT 'plus_started', user_id, purchase_token, purchase_token, 'skipped', 'before emails existed' FROM subscriptions
  UNION ALL
  SELECT 'plus_started', user_id, purchase_token, purchase_token, 'skipped', 'before emails existed' FROM passes
ON CONFLICT DO NOTHING;

-- Admin queue lookups.
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at);
