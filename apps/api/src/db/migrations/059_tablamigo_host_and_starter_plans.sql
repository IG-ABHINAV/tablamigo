-- 059: the Tablamigo Host (one official team account), its welcome DMs and the community starter plans it lists.
--
-- users.account_kind tells a person from the team account. The team account can never be verified (no ✅), never counts as
-- onboarded (so it is left out of Travelers, nearby travellers, here-now and every activation email, and the join and create
-- routes refuse it), and can never be a member of a plan (the trigger below), so it never shows up in a "going" count.
-- There is at most one team account.
ALTER TABLE users ADD COLUMN IF NOT EXISTS account_kind text NOT NULL DEFAULT 'person' CHECK (account_kind IN ('person', 'team'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_team_account_rules;
ALTER TABLE users ADD CONSTRAINT users_team_account_rules
  CHECK (account_kind <> 'team' OR (NOT verified AND NOT id_verified AND NOT onboarded));
CREATE UNIQUE INDEX IF NOT EXISTS users_one_team_account ON users (account_kind) WHERE account_kind = 'team';

CREATE OR REPLACE FUNCTION refuse_team_plan_member() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM users WHERE id = NEW.user_id AND account_kind = 'team') THEN
    RAISE EXCEPTION 'team_account_cannot_join_plans';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS activity_members_no_team ON activity_members;
CREATE TRIGGER activity_members_no_team BEFORE INSERT OR UPDATE OF user_id ON activity_members
  FOR EACH ROW EXECUTE FUNCTION refuse_team_plan_member();

-- The Host. role 'admin' because the AI engagement worker skips plans whose host is an admin (lib/ai-engagement.ts), so no
-- persona ever joins a starter plan; lib/admin.ts and the admin sign-in refuse admin rights to a team account. Nobody can sign
-- in as it: the app's email sign-in stores no code for a team account, signInByEmail (email code and Google) refuses it, the
-- admin sign-in refuses it, and requireUser refuses a token for it (routes/auth.ts, lib/auth.ts). The address being unreachable
-- (.tablamigo is not a real domain) is not what protects it: a code stored for it could still be guessed.
INSERT INTO users (email, name, bio, photo_url, role, account_kind, onboarded, verified, languages)
VALUES ('host@team.tablamigo', 'Tablamigo Host (Team)',
  'Official Tablamigo team account, not a traveller. Naye members ko welcome karta hai aur community meetups list karta hai. Team se koi meetups mein nahi aata. Help: support@hookstep.in',
  'https://tablamigo.hookstep.in/icon-192.png', 'admin', 'team', false, false, '{English,Hindi}')
ON CONFLICT (email) DO NOTHING;

-- One welcome DM per user, ever: the row is written before the message is posted, so a crash between the two never sends twice.
CREATE TABLE IF NOT EXISTS host_welcomes (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
  chat_id    uuid REFERENCES chats(id) ON DELETE SET NULL,
  message_id bigint,
  meta       jsonb,
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);

-- Community starter plans the Host lists (lib/starter-plans.ts). One row per plan; a slot of a city is listed once per date.
CREATE TABLE IF NOT EXISTS starter_plans (
  activity_id          uuid PRIMARY KEY REFERENCES activities(id) ON DELETE CASCADE,
  city_key             text NOT NULL,
  slot                 text NOT NULL,
  starts_at            timestamptz NOT NULL,
  venue                text NOT NULL,
  go_announced_at      timestamptz,
  cancelled_at         timestamptz,
  real_going_at_cancel int,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (city_key, slot, starts_at)
);
CREATE INDEX IF NOT EXISTS starter_plans_open_idx ON starter_plans (starts_at) WHERE cancelled_at IS NULL;
