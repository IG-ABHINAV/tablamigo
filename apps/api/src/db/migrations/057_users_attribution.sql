-- Signup attribution (UTM source/medium/campaign, referrer, landing page, device, country, IP) written by routes/auth.ts.
-- It was first added to production by hand on 7 Oct 2026; IF NOT EXISTS keeps this safe there.
alter table users add column if not exists attribution jsonb;
