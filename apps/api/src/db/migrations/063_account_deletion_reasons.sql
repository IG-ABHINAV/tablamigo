-- 063: why people delete their accounts, without who they were.
--
-- 7 of 41 accounts were deleted (6 within 8 minutes of signing up) and none said why: the app's confirm had no question, and the
-- deletion wipes the person's analytics. DELETE /me now takes an optional one-tap reason (a fixed code, never free text) and
-- stores it here with how many days the account existed. No user id, email, name or text: nothing in a row says whose it was.
CREATE TABLE IF NOT EXISTS account_deletion_reasons (
  id                bigserial PRIMARY KEY,
  reason            text NOT NULL CHECK (reason IN ('no_one_near', 'wrong_city', 'paywall', 'not_what_i_wanted', 'privacy', 'other', 'none')),
  days_since_signup int,
  created_at        timestamptz NOT NULL DEFAULT now()
);
