-- 075: which Play offer a subscription was bought with (lib/play-offers.ts, 2 Nov 2026): monthly-intro-50, yearly-launch-20,
-- yearly-trial-3d, or NULL for the base plan. Set from Google's own copy of the purchase on first verify and never changed after,
-- so the offer stays on record after Google's later copies move on to renewals. Backfilled from the stored copy.
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS offer_id text;
UPDATE subscriptions SET offer_id = raw->'lineItems'->0->'offerDetails'->>'offerId'
  WHERE platform = 'google' AND offer_id IS NULL AND raw->'lineItems'->0->'offerDetails'->>'offerId' IS NOT NULL;
