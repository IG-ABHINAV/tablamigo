// Why the paywall was opened: the `reason` the app puts on its paywall_viewed analytics event (apps/mobile/src/screens/Paywall*.tsx,
// from the /paywall?reason=... link that opened it). The reason comes from a URL anyone can type or deep-link, so ingestion keeps
// only the values below and stores 'other' for anything else: no free text, no huge strings, nothing that splits the admin
// counts into junk rows. A new reason in the app needs adding here (tests/unit/paywall-reasons.test.ts checks the two lists).
export const PAYWALL_REASONS = [
  'general', 'intro',
  // The headings in apps/mobile/src/lib/paywall-copy.ts REASONS
  'overlaps', 'trip_pass', 'city_chat', 'activities', 'ai', 'viewers', 'dm', 'contacts',
  'ads',          // "No ads with Plus" on the one-time ads notice (components/AdsNotice.tsx)
  'remove_ads',   // "Remove ads · Get Plus" under the Explore banner (components/ExploreAd.tsx)
  // Opened from a limit, with the general heading
  'advanced_filters', 'buddy_requests_limit', 'trusted_contacts_limit',
] as const;
export type PaywallReason = (typeof PAYWALL_REASONS)[number] | 'other';

const KNOWN: ReadonlySet<string> = new Set(PAYWALL_REASONS);

/** A known reason as is; a missing one is 'general' (what the app sends without one); anything else, of any type or length, 'other'. */
export function paywallReason(raw: unknown): PaywallReason {
  if (raw === undefined || raw === null || raw === '') return 'general';
  return typeof raw === 'string' && raw.length <= 40 && KNOWN.has(raw) ? (raw as PaywallReason) : 'other';
}

/** An analytics event's properties with a paywall_viewed reason made safe; an event without a reason, or any other event, untouched. */
export function withPaywallReason(event: string, props: Record<string, unknown>): Record<string, unknown> {
  return event === 'paywall_viewed' && 'reason' in props ? { ...props, reason: paywallReason(props.reason) } : props;
}
