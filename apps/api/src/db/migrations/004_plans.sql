-- Hosts can close a plan to new joiners without cancelling it.
ALTER TABLE activities ADD COLUMN closed boolean NOT NULL DEFAULT false;

-- Plus granted by hand (Play reviewer, support goodwill). Survives purchase recomputes.
ALTER TABLE users ADD COLUMN comp_until timestamptz;

-- One-time Trip Pass purchases (Google Play in-app product). Each token grants a fixed window.
CREATE TABLE passes (
  purchase_token text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id     text NOT NULL,
  order_id       text,
  expires_at     timestamptz NOT NULL,
  voided_at      timestamptz,
  raw            jsonb,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passes_user_idx ON passes (user_id);
