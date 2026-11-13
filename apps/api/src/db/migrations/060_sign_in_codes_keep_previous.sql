-- 060: a new sign-in code no longer kills the one in the earlier email.
--
-- Every POST /auth/email/start overwrote the stored code, so the code in an email that arrived a little late was "not right".
-- People tapped "Send a new code" again and again (one address sent 4 in two minutes, two in the same second, then 5 in one
-- second, 4 of them refused), and some never got in. Now the previous code stays good until it expires, and a second
-- request within 30 seconds of a send sends nothing new (last_sent_at), so a double tap counts once (lib/auth.ts).
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS prev_code_hash text;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS prev_expires_at timestamptz;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS last_sent_at timestamptz NOT NULL DEFAULT now();
