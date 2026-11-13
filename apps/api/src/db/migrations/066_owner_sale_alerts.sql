-- 066: the owner's sale alerts (lib/owner-alerts.ts), one row per money event.
--
-- The owner gets one email for every purchase, charge, renewal, cancellation, payment problem and refund, whichever path
-- reports it first (the app's verify call, the forwarded Razorpay webhook, Google Play's RTDN push) and however often the
-- provider retries. event_key is built from the provider's own ids (a Razorpay payment, refund or subscription id, a Google
-- Play order id), never from a time, so a retried or duplicated event finds its row and sends nothing.
--
-- subject/body_* hold the rendered alert only until it is sent (a failed send, or a claim whose process died mid-send, is
-- retried from them by the email jobs) and are cleared once it is sent, once it runs out of attempts or after 3 days, and when
-- the customer deletes their account. user_id has no foreign key: an alert outlives the account it was about.
CREATE TABLE IF NOT EXISTS owner_sale_alerts (
  event_key   text PRIMARY KEY CHECK (length(event_key) BETWEEN 1 AND 200),
  kind        text NOT NULL,
  provider    text NOT NULL CHECK (provider IN ('razorpay', 'google_play')),
  user_id     uuid,
  test        boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  attempts    int NOT NULL DEFAULT 1,
  subject     text,
  body_text   text,
  body_html   text,
  provider_id text,
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at  timestamptz NOT NULL DEFAULT now(),
  sent_at     timestamptz
);
CREATE INDEX IF NOT EXISTS owner_sale_alerts_retry_idx ON owner_sale_alerts (created_at) WHERE status IN ('failed', 'pending');
CREATE INDEX IF NOT EXISTS owner_sale_alerts_user_idx ON owner_sale_alerts (user_id);
