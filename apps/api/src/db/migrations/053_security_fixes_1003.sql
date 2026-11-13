-- 053: security fixes after the 3 Oct 2026 audit (audit-2026-10-03/PUNCHLIST.md).

-- "Who's here now" is opt-in. 030 made it opt-out (default true) with no setting in the app, so nobody ever chose it:
-- every current value is that default, and all of them go back to off.
ALTER TABLE users ALTER COLUMN here_now_opt_in SET DEFAULT false;
UPDATE users SET here_now_opt_in = false WHERE here_now_opt_in;

-- One ticket per Razorpay payment, and one live ticket per person per plan (no replays, no duplicates).
CREATE UNIQUE INDEX IF NOT EXISTS activity_tickets_payment_uniq ON activity_tickets (razorpay_payment_id) WHERE razorpay_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS activity_tickets_one_live_per_user ON activity_tickets (activity_id, user_id) WHERE status IN ('valid', 'used');

-- Moments keep a neighbourhood, not the exact spot (routes/moments.ts snaps new ones to a 0.01 degree grid).
UPDATE moments SET location = ST_SetSRID(ST_MakePoint(round(ST_X(location::geometry)::numeric, 2)::float8, round(ST_Y(location::geometry)::numeric, 2)::float8), 4326)::geography
WHERE location IS NOT NULL;


-- A "<city>:women" chat is always women-only. Before, anyone could create one first, as a mixed chat, through
-- /cities/<slug>:women/join-chat; the server now builds the key itself, and this closes any chat made that way.
UPDATE chats SET women_only = true WHERE city_key LIKE '%:women' AND NOT women_only;
