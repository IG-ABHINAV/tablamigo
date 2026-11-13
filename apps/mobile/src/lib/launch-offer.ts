// The launch offer: Plus is free for everyone until a date. The API says so in `launchOffer: { active, until }` (GET
// /billing/me, and the same object on /me or /billing/plans if that is where it is served). This file is plain TypeScript
// with no React or React Native imports, so the rules and the wording are unit-tested with node (e2e-web/launch-offer.test.mjs).

export type LaunchOffer = { active: boolean; until: string | null };
export const NO_OFFER: LaunchOffer = { active: false, until: null };

/**
 * Reads `launchOffer` from a response body, defensively. Anything but an object with `active: true` is "no offer", so an
 * older API that doesn't know the field, a null, a string, or `active: "yes"` all mean the offer is off. `until` is kept
 * only when it is a date the phone can read (an ISO string, or a number of milliseconds); otherwise it is null and the
 * wording drops the date instead of showing "Invalid Date".
 */
export function readLaunchOffer(body: unknown): LaunchOffer {
  const o = (body as { launchOffer?: unknown } | null | undefined)?.launchOffer as { active?: unknown; until?: unknown } | null | undefined;
  if (!o || typeof o !== 'object' || o.active !== true) return NO_OFFER;
  let until: string | null = null;
  if (typeof o.until === 'string' && Number.isFinite(Date.parse(o.until))) until = o.until;
  else if (typeof o.until === 'number' && Number.isFinite(o.until)) until = new Date(o.until).toISOString();
  return { active: true, until };
}

/**
 * "31 Dec 2026" for the end of the offer, or null without a date. Shown in UTC: the offer ends on a calendar date, and
 * 2026-12-31T23:59:59Z must not read as 1 Jan 2027 on a phone in India.
 */
export function offerDate(until: string | null, locale?: string): string | null {
  if (!until) return null;
  const t = Date.parse(until);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** The headline on the paywall. */
export function offerHeadline(offer: LaunchOffer, locale?: string): string {
  const d = offerDate(offer.until, locale);
  return d ? `Launch offer: Plus is free for everyone until ${d}` : 'Launch offer: Plus is free for everyone';
}

/** The short line for the Profile entry and the Plus sheets. */
export function offerShort(offer: LaunchOffer, locale?: string): string {
  const d = offerDate(offer.until, locale);
  return d ? `Plus is free until ${d}` : 'Plus is free right now';
}

/**
 * Whether a person's Plus is the offer's rather than one they pay for: the offer is on and their Plus ends no later than
 * the offer does (or they have no end date at all, which is how an offer-only Plus looks). A person paid up beyond the
 * end of the offer keeps seeing their own renewal date.
 */
export function plusIsFromOffer(offer: LaunchOffer, plusUntil: string | null | undefined): boolean {
  if (!offer.active) return false;
  if (!plusUntil || !Number.isFinite(Date.parse(plusUntil))) return true;
  if (!offer.until) return false;
  return Date.parse(plusUntil) <= Date.parse(offer.until) + 24 * 3600_000;
}
