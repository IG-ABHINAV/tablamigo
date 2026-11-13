-- 069: what the team did by hand for the first paid user on 31 Oct 2026, now automatic (lib/trip-match.ts, lib/plus-welcome.ts,
-- lib/city-nudge.ts).

-- A person can switch trip match alerts off (Profile). Off also hides them from everyone else's matches: matching is mutual.
ALTER TABLE users ADD COLUMN IF NOT EXISTS trip_match_alerts boolean NOT NULL DEFAULT true;

-- One row per introduced pair and visit. user_lo < user_hi, so a pair has one spelling. A new match for a pair is only made
-- when no earlier one is within 14 days of it (lib/trip-match.ts claims under a per-pair advisory lock), so deleting and
-- re-adding a trip, two trips in neighbouring towns, or both people adding trips at the same moment never introduce them twice.
CREATE TABLE IF NOT EXISTS trip_matches (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_lo       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_hi       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_lo       uuid REFERENCES trips(id) ON DELETE SET NULL,
  trip_hi       uuid REFERENCES trips(id) ON DELETE SET NULL,
  city_key      text NOT NULL,
  overlap_start date NOT NULL,
  overlap_end   date NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (user_lo < user_hi),
  CHECK (overlap_end >= overlap_start)
);
CREATE INDEX IF NOT EXISTS trip_matches_pair_idx ON trip_matches (user_lo, user_hi, overlap_start);

-- What each side of a match is told, and when. 'pending' waits for the person's daytime and their daily cap; 'sending' is the
-- claim (a crash after it never sends twice); 'skipped' says why in `reason`.
CREATE TABLE IF NOT EXISTS trip_match_notices (
  match_id   uuid NOT NULL REFERENCES trip_matches(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  other_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trip_id    uuid REFERENCES trips(id) ON DELETE SET NULL,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  reason     text,
  chat_id    uuid REFERENCES chats(id) ON DELETE SET NULL,
  message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz,
  -- A notice that waits (the person's night, their daily cap) is not looked at again before this.
  next_try_at timestamptz,
  PRIMARY KEY (match_id, user_id)
);
CREATE INDEX IF NOT EXISTS trip_match_notices_pending_idx ON trip_match_notices (created_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS trip_match_notices_sent_idx ON trip_match_notices (user_id, sent_at) WHERE status = 'sent';

-- The Plus welcome: one per subscription (its purchase token), claimed before anything is sent.
CREATE TABLE IF NOT EXISTS plus_welcomes (
  purchase_token text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  reason         text,
  chat_id        uuid REFERENCES chats(id) ON DELETE SET NULL,
  message_id     bigint,
  created_at     timestamptz NOT NULL DEFAULT now(),
  sent_at        timestamptz
);
CREATE INDEX IF NOT EXISTS plus_welcomes_user_idx ON plus_welcomes (user_id, created_at);
-- Subscriptions that exist today are not welcomed after the fact (the first paid user was welcomed by hand on 31 Oct).
INSERT INTO plus_welcomes (purchase_token, user_id, status, reason)
SELECT purchase_token, user_id, 'skipped', 'before_069' FROM subscriptions
ON CONFLICT (purchase_token) DO NOTHING;

-- The empty-city nudge: one per trip, claimed before anything is sent.
CREATE TABLE IF NOT EXISTS city_nudges (
  trip_id    uuid PRIMARY KEY REFERENCES trips(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status     text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'skipped', 'failed')),
  reason     text,
  chat_id    uuid REFERENCES chats(id) ON DELETE SET NULL,
  message_id bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at    timestamptz
);
CREATE INDEX IF NOT EXISTS city_nudges_user_idx ON city_nudges (user_id, created_at);

-- The one pair the team introduced by hand on 31 Oct 2026 (Ubud, 13-18 Nov): recorded as already told on both sides, so the
-- matcher doesn't introduce them a second time. Inserts nothing on a database without both accounts.
WITH pair AS (
  SELECT least(a.id, b.id) AS lo, greatest(a.id, b.id) AS hi FROM users a, users b
  WHERE a.id = '22c4dd4e-eaff-42bf-99fa-fa5678f77c72' AND b.id = 'f73429fe-da84-4574-9495-f40910bfc264'
), m AS (
  INSERT INTO trip_matches (user_lo, user_hi, city_key, overlap_start, overlap_end)
  SELECT lo, hi, 'ubud-district-id', '2026-11-13', '2026-11-18' FROM pair
  WHERE NOT EXISTS (SELECT 1 FROM trip_matches t, pair p WHERE t.user_lo = p.lo AND t.user_hi = p.hi)
  RETURNING id, user_lo, user_hi
)
INSERT INTO trip_match_notices (match_id, user_id, other_id, status, reason, sent_at)
SELECT id, user_lo, user_hi, 'sent', 'manual_intro_31_oct', '2026-10-31T04:02:58Z'::timestamptz FROM m
UNION ALL
SELECT id, user_hi, user_lo, 'sent', 'manual_intro_31_oct', '2026-10-31T04:02:58Z'::timestamptz FROM m;

-- Plan activity alerts (who looked at your plan, plan starting soon by email): Profile can switch them off.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_alerts boolean NOT NULL DEFAULT true;

-- The delivery ladder (lib/ladder.ts): one row per event, person and channel. In-app and push go first; email follows only
-- when there is no push token or the in-app message was not read in time. read_at/opened_at are what the fallback reads.
CREATE TABLE IF NOT EXISTS notification_log (
  id         bigserial PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  ref        text NOT NULL,
  channel    text NOT NULL CHECK (channel IN ('inapp', 'push', 'email', 'whatsapp', 'telegram')),
  status     text NOT NULL CHECK (status IN ('sent', 'no_token', 'skipped', 'failed', 'waiting')),
  chat_id    uuid REFERENCES chats(id) ON DELETE SET NULL,
  message_id bigint,
  reason     text,
  -- What the email fallback needs to say (the template's input), so it never has to rebuild the event.
  payload    jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  opened_at  timestamptz,
  read_at    timestamptz,
  UNIQUE (kind, ref, user_id, channel)
);
CREATE INDEX IF NOT EXISTS notification_log_open_idx ON notification_log (kind, created_at) WHERE channel = 'inapp' AND read_at IS NULL;
CREATE INDEX IF NOT EXISTS notification_log_user_idx ON notification_log (user_id, channel, created_at);

-- Who opened a plan (GET /activities/:id), for the host's daily "N people looked at your plan". One row per plan and viewer.
CREATE TABLE IF NOT EXISTS plan_views (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  viewer_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, viewer_id)
);
CREATE INDEX IF NOT EXISTS plan_views_time_idx ON plan_views (viewed_at);

-- The host's "N people looked at your plan" is an inbox notice.
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN (
    'join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled',
    'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat',
    'recurring_next', 'plan_comment', 'buddy_request', 'buddy_accepted',
    'photo_reaction', 'rsvp_update', 'running_late',
    'id_verification_approved', 'id_verification_rejected', 'ticket_purchased', 'plan_views'
  ));

-- Escalation channels after email (lib/channels.ts). All stay unused until the owner adds the provider credentials and a
-- person opts in: WhatsApp and SMS need a verified phone number and their own yes; Telegram needs them to start the bot.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_e164 text CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\+[1-9][0-9]{6,14}$');
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_verified_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS whatsapp_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS sms_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_linked_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_chat_idx ON users (telegram_chat_id) WHERE telegram_chat_id IS NOT NULL;
ALTER TABLE notification_log DROP CONSTRAINT IF EXISTS notification_log_channel_check;
ALTER TABLE notification_log ADD CONSTRAINT notification_log_channel_check CHECK (channel IN ('inapp', 'push', 'email', 'whatsapp', 'telegram', 'sms'));
