-- 073: the soft paywall right after onboarding (lib/plus-intro.ts, 1 Nov 2026). One Plus screen per account, ever: the first
-- POST /me/plus-intro sets plus_intro_seen_at and only that call can answer show = true, so a replayed or second call (another
-- device, a reinstall) never shows it again. NULL = not offered yet.
ALTER TABLE users ADD COLUMN IF NOT EXISTS plus_intro_seen_at timestamptz;
