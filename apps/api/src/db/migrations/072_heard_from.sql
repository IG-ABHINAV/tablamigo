-- 072: "How did you hear about us?" (one tap in onboarding, skippable). Play tags organic installs as "Google Play", which hid
-- the real source for 58 of 91 sign-ups in October (NomadTable teardown, 1 Nov 2026), so people now say it themselves.
-- NULL = never asked (accounts from before this step); 'skipped' = asked and skipped. lib/heard-from.ts holds the list.
ALTER TABLE users ADD COLUMN IF NOT EXISTS heard_from text
  CHECK (heard_from IN ('instagram','youtube','tiktok','google','play_store','friend','ai','other','skipped'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS heard_from_at timestamptz;
