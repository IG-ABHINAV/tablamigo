/**
 * The Plus intro offers in Play Console (infra/play/intro-offers.mjs, 2 Nov 2026), in words for the owner's sale alert and the
 * admin panel. A Play purchase names the one offer it was bought with (lineItems[0].offerDetails.offerId), stored as
 * subscriptions.offer_id. The app decides which offer to buy (apps/mobile/src/lib/plus-intro.ts); this is only the label.
 */
export const PLAY_OFFERS: Record<string, string> = {
  'monthly-intro-50': 'first month 50% off',
  'yearly-launch-20': 'first year 20% off',
  'yearly-trial-3d': '3-day free trial, then first year 20% off',
};

/** "monthly-intro-50 (first month 50% off)"; an unknown offer id as it is; null for a base plan bought without an offer. */
export function playOfferLabel(offerId: string | null | undefined, trialOfferId?: string | null): string | null {
  if (!offerId) return null;
  const words = PLAY_OFFERS[offerId] ?? (offerId === trialOfferId ? 'free trial' : null);
  return words ? `${offerId} (${words})` : offerId;
}

/** The offer a Play subscription (subscriptionsv2) was bought with, or null. Only Play's own id format is kept. */
export function playOfferId(data: any): string | null {
  const id = data?.lineItems?.[0]?.offerDetails?.offerId;
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,62}$/.test(id) ? id : null;
}
