// Shared by the Play (paywall.tsx) and Razorpay (paywall.web.tsx) paywalls and the in-context paywall sheets.
export const REASONS: Record<string, string> = {
  overlaps: 'See everyone who overlaps with your trip',
  trip_pass: 'See everyone on your trip dates',
  city_chat: 'Join city chats weeks before you land',
  activities: 'Host as many plans as you like',
  ai: 'Get 200 plan ideas a day',
  viewers: 'See who viewed your profile',
  dm: 'Message anyone, as much as you like',
  contacts: "Swap contact details when you're ready",
  ads: 'Plus has no ads',
  remove_ads: 'Remove ads with Plus',
};

/** Reasons that open the paywall from a limit, with the general heading. */
const LIMIT_REASONS = ['advanced_filters', 'buddy_requests_limit', 'trusted_contacts_limit'];
const own = (r: string) => Object.prototype.hasOwnProperty.call(REASONS, r);

/**
 * The paywall's `reason` from its URL, made safe for its analytics event: a key of REASONS or a limit reason, else 'general'.
 * Own keys only, so '__proto__' or 'constructor' never pass. Anyone can type or deep-link /paywall?reason=..., and the API keeps
 * only known reasons too (apps/api/src/lib/paywall-reasons.ts, whose list must hold every one of these).
 */
export function paywallReason(raw: unknown): string {
  const r = Array.isArray(raw) ? raw[0] : raw;
  return typeof r === 'string' && r.length <= 40 && (own(r) || LIMIT_REASONS.includes(r)) ? r : 'general';
}

/** The heading for a paywall opened with this reason. */
export function reasonHeading(raw: unknown): string {
  const r = paywallReason(raw);
  return own(r) ? REASONS[r] : 'Make every trip social';
}

export const PERKS = [
  ['💬', 'Message anyone first', 'Free accounts start 1 new chat a day, 3 messages until they reply'],
  ['👀', 'See every traveler on your trip dates', 'Not just a preview of 3'],
  ['⭐', 'Get seen first', 'Your profile ranks higher in Travelers, your plans higher in the list'],
  ['🤝', "Swap numbers when you're ready", 'Free accounts share contact details once you both join the same plan'],
  ['🏙️', 'City chats before you land', 'Join from the moment you book'],
  ['📅', 'Host up to 20 plans a day', 'Free accounts get 2'],
  ['✨', '200 plan ideas a day', 'Plans tailored to where you are'],
  ['👁️', 'See who viewed your profile', 'Everyone from the last 30 days'],
  ['🚫', 'No ads', 'Free accounts in the Android app see one ad in the plan list'],
];
/** Shown under the perks so nobody thinks the free app is going away. */
/**
 * Ways to get Plus without paying, under the plans: invite rewards (API lib/plus.ts REFERRAL) and host rewards (API
 * lib/host-rewards.ts HOST_REWARD). The API's prices-and-limits test holds these numbers to the API's.
 */
export const EARN_PLUS = { inviteDays: 7, hostDays: 7, hostMinGuests: 2 };
export const EARN_PLUS_LINE = `Invite a friend and you both get ${EARN_PLUS.inviteDays} days. Host a plan and get ${EARN_PLUS.hostDays} days when ${EARN_PLUS.hostMinGuests} travelers check in at it.`;

export const ALWAYS_FREE = 'Always free: browsing and joining plans, plan group chats, and replying to anyone who messages you.';

/** An in-context paywall sheet (components/PaywallSheet.tsx). */
export type Moment = { emoji: string; title: string; body: string; reason: string; plan?: 'pass' };

/** The sheet for one of the API's paywall error codes, or null for any other error. */
export function momentFor(code: string, message?: string, data: Record<string, any> = {}): Moment | null {
  const who = data.name ?? 'them';
  if (code === 'dm_limit') return {
    emoji: '💬', title: "You've used today's free new chat", reason: 'dm',
    body: message ?? 'Free accounts can start 1 new conversation a day. Replies are always free, and so are chats with people from your plans. Get Plus or a Trip Pass to message anyone.',
  };
  if (code === 'dm_wait_reply') return {
    emoji: '⏳', title: `Give ${who} a moment to reply`, reason: 'dm',
    body: message ?? `Wait for ${who} to reply, or get Plus or a Trip Pass to keep chatting.`,
  };
  if (code === 'contact_shield') return {
    emoji: '🛡️', title: 'Contact details held back', reason: 'contacts',
    body: `${message ?? "For your safety, contact details unlock with Plus or once you've both joined the same plan."} Scammers often push to move a chat off the app early, so keep talking here until you've met.`,
  };
  return null;
}

export const tripMoment = (hidden: number, total: number, city: string): Moment => ({
  emoji: '🧳', title: `${total} travelers will be in ${city} on your dates`,
  body: `You can see ${total - hidden} of them for free. See all with a Trip Pass: 14 days of Plus, one payment, nothing renews.`,
  reason: 'trip_pass', plan: 'pass',
});

/**
 * The line shown right under the buy button on the Play paywall: price, billing period, automatic renewal and how to
 * cancel (Google Play's Subscriptions policy wants all four before the purchase). `price` is Play's own localised
 * string for the selected plan, so it is never stale or in the wrong currency. The Trip Pass is a one-time purchase.
 */
const PERIOD: Record<string, string> = { weekly: 'week', monthly: 'month', halfyearly: '6 months', yearly: 'year' };
export function renewalNotice(basePlan: string, price: string, passDays = 14, trialDays?: number, introPrice?: string | null): string {
  if (basePlan === 'pass') return `Trip Pass is a one-time purchase of ${price}: ${passDays} days of Plus, added after any Plus you already have. Nothing renews.`;
  const unit = PERIOD[basePlan] ?? 'period';
  // An intro offer (lib/plus-intro.ts): its first period at Play's discounted price, then the normal price from the second on.
  const charge = introPrice ? `${introPrice} for your first ${unit}, then ${price} per ${unit}` : `${price} per ${unit}`;
  // A free trial (lib/plus-intro.ts): Play's policy wants the free period, what is charged after it and when, and how to cancel.
  if (trialDays) return `Free for ${trialDays} days, then ${charge}, charged to your Google Play account when the trial ends unless you cancel before then. Renews automatically every ${unit} until you cancel. Cancel any time in Google Play, under Subscriptions.`;
  return `${charge}, charged to your Google Play account. Renews automatically every ${unit} until you cancel. Cancel any time in Google Play, under Subscriptions.`;
}

/**
 * The Plus card's second line. Plus can come from a renewing subscription, a cancelled one, a Trip Pass, invite rewards or
 * days the team gave, so it never says "Renews": only until when. A date more than ten years out is a grant with no real end.
 */
export function plusUntilLine(plusUntil: string | null | undefined, now = Date.now()): string {
  const t = plusUntil ? Date.parse(plusUntil) : NaN;
  if (!Number.isFinite(t) || t <= now) return '';
  if (t - now > 10 * 365 * 86_400_000) return 'Complimentary Plus';
  return `Plus until ${new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}`;
}

/**
 * What the Play paywall offers someone who already has Plus (GET /billing/me). A renewing subscription (Google Play or the
 * website) means nothing more to buy here: a second subscription would bill twice. Plus from a Trip Pass, a cancelled
 * subscription or granted days can still be extended, so the plans stay, under a line saying how long Plus already runs.
 */
export type PlusState = { plus?: boolean; plusUntil?: string | null; renewing?: 'google' | 'razorpay' | null };
export function paywallPlusState(b: PlusState | null | undefined): { kind: 'none' } | { kind: 'renewing'; where: 'google' | 'razorpay'; line: string } | { kind: 'extend'; line: string } {
  if (!b?.plus) return { kind: 'none' };
  const line = plusUntilLine(b.plusUntil) || "You're on Plus";
  if (b.renewing === 'google' || b.renewing === 'razorpay') return { kind: 'renewing', where: b.renewing, line };
  return { kind: 'extend', line };
}

/** Shown when Google Play Billing can't be reached or returns no products (no Google account, Play Store too old, offline). */
export const PLAY_UNAVAILABLE = {
  title: "Google Play can't take payments right now",
  // No pointer to another way to pay: Google Play's payments policy doesn't allow steering to the website's checkout.
  body: 'Check that you are signed in to the Play Store and online, then try again.',
};
