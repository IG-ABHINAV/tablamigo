-- Host rewards (lib/host-rewards.ts, 1 Nov 2026): a traveller who hosts a plan that real people went to gets days of Plus.
-- One row per plan, written once, whatever the outcome: 'granted' (days added to the host's comp_until) or 'capped' (the host
-- already had the most rewards allowed in the window). The row is the claim, so a plan is never rewarded twice.
CREATE TABLE IF NOT EXISTS host_rewards (
  activity_id uuid PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
  host_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  guests      int  NOT NULL,
  days        int  NOT NULL,
  status      text NOT NULL CHECK (status IN ('granted', 'capped')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS host_rewards_host_idx ON host_rewards (host_id, created_at);
