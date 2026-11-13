-- Plan sharing with trusted contacts, SOS alerts, and emergency contact details
CREATE TABLE IF NOT EXISTS plan_shares (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_shares_token_idx ON plan_shares(token);
CREATE INDEX IF NOT EXISTS plan_shares_activity_idx ON plan_shares(activity_id);

-- Emergency contact info on users
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_name text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_contact_phone text;

-- Women-only support for city chats
ALTER TABLE chats ADD COLUMN IF NOT EXISTS women_only boolean NOT NULL DEFAULT false;

-- Safety alerts (SOS audit and notification log)
CREATE TABLE IF NOT EXISTS safety_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  latitude double precision,
  longitude double precision,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS safety_alerts_user_idx ON safety_alerts(user_id);
