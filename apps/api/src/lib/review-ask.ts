// When the app may ask someone for a store rating (POST /me/review-ask; the app side is apps/mobile/src/lib/review-trigger.ts).
//
// The app asks right after a person's 3rd sent chat message (any chat) or right after they join a plan, and this is the one
// place that says yes: it checks the person has really done one of the two, that they are a real traveller (never the Play
// reviewer, a demo persona, the team account, an admin or a test address), and that nobody asked them in the last 60 days on
// any device or surface. The yes is an atomic claim of users.review_asked_at, so two phones or a burst of sends get one yes.
//
// What the app does with the yes is fixed by store policy: on Android the Google Play In-App Review sheet, on iOS
// SKStoreReviewController (both through expo-store-review's requestReview), on the web a neutral "Rate us on Google Play"
// card. Never a custom star prompt, never a "do you like the app?" question first, never a reward. Google and Apple decide on
// their own whether their sheet shows, so a yes here may show nothing; it still counts toward the 60 days.
//
// REVIEW_ASK (config.reviewAsk) is the kill switch, off by default: then every claim answers { ask: false, reason: 'disabled' }
// and nothing is written. The app treats a reason it doesn't know like "not yet": it asks the server again at most every 10
// minutes after a moment (review-policy.ts CLAIM_RETRY_MS), and never marks the account excluded, so switching it on later works
// for everyone without an app update.
import { sql } from './db.js';
import { config } from './config.js';
import { isAdmin } from './admin.js';

export const REVIEW_ASK_MESSAGES = 3;
export const REVIEW_ASK_COOLDOWN_DAYS = 60;
export type ReviewSurface = 'android' | 'ios' | 'web';
export type ReviewAskResult =
  | { ask: true; askedAt: string }
  | { ask: false; reason: 'disabled' | 'excluded' | 'not_earned' | 'cooldown'; nextAt?: string };

/** Addresses that only exist inside Tablamigo (seeded demo personas, deleted accounts, the Host) or that are reserved for tests. */
const INTERNAL_DOMAINS = new Set(['demo.tablamigo', 'deleted.tablamigo', 'team.tablamigo']);
const TEST_DOMAIN = /(^|\.)(test|example|invalid|localhost)$|^example\.(com|net|org)$/;

/** Why this account must never be asked for a rating, or null for a real traveller. */
export function reviewAskExclusion(u: { email: string | null; accountKind: string | null; role: string | null }): string | null {
  if (u.accountKind !== 'person') return 'team';
  // The team's own accounts (users.role = 'admin' or ADMIN_EMAILS): a rating from them would be a developer review.
  if (isAdmin(u)) return 'admin';
  const email = (u.email ?? '').trim().toLowerCase();
  const domain = email.split('@')[1] ?? '';
  if (!domain) return 'no_email';
  if (config.reviewEmails.includes(email)) return 'store_review';   // the Play / App Store reviewer and QA logins
  if (INTERNAL_DOMAINS.has(domain)) return 'demo';
  if (TEST_DOMAIN.test(domain)) return 'test';
  return null;
}

/**
 * Claims the one ask this person may have now. Never asks more than once in 60 days per person, whatever the surface, and
 * only once they have sent 3 chat messages or joined someone else's plan (as going, not waitlisted or maybe).
 */
export async function claimReviewAsk(uid: string, surface: ReviewSurface): Promise<ReviewAskResult> {
  if (!config.reviewAsk) return { ask: false, reason: 'disabled' };
  const [u] = await sql`select email::text as email, account_kind, role, onboarded, review_asked_at from users where id = ${uid}`;
  if (!u || !u.onboarded || reviewAskExclusion(u as any)) return { ask: false, reason: 'excluded' };
  const nextAt = (at: Date) => new Date(at.getTime() + REVIEW_ASK_COOLDOWN_DAYS * 86_400_000).toISOString();
  if (u.reviewAskedAt && Date.now() < new Date(u.reviewAskedAt).getTime() + REVIEW_ASK_COOLDOWN_DAYS * 86_400_000)
    return { ask: false, reason: 'cooldown', nextAt: nextAt(new Date(u.reviewAskedAt)) };
  const [e] = await sql`select
      (select count(*)::int from (select 1 from messages where sender_id = ${uid} and kind <> 'system' limit ${REVIEW_ASK_MESSAGES}) m) as sent,
      exists (select 1 from activity_members am join activities a on a.id = am.activity_id
              where am.user_id = ${uid} and a.host_id <> ${uid} and am.rsvp_status = 'going') as joined`;
  if (e.sent < REVIEW_ASK_MESSAGES && !e.joined) return { ask: false, reason: 'not_earned' };
  // The claim itself enforces the 60 days, so concurrent claims (two phones, rapid sends) can't both get a yes.
  const [c] = await sql`update users set review_asked_at = now(), review_ask_surface = ${surface}
    where id = ${uid} and (review_asked_at is null or review_asked_at <= now() - make_interval(days => ${REVIEW_ASK_COOLDOWN_DAYS}))
    returning review_asked_at`;
  if (!c) {
    const [r] = await sql`select review_asked_at from users where id = ${uid}`;
    return { ask: false, reason: 'cooldown', ...(r?.reviewAskedAt ? { nextAt: nextAt(new Date(r.reviewAskedAt)) } : {}) };
  }
  return { ask: true, askedAt: new Date(c.reviewAskedAt).toISOString() };
}
