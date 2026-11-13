import { sql } from './db.js';
import { config } from './config.js';
import { clock } from './clock.js';
import { plusAccess } from './plus-derive.js';

/**
 * Every free-vs-Plus rule lives here, so pricing experiments touch one file.
 * Always free, whatever the tier: seeing and joining plans, plan group chats, replying to a DM,
 * and DMs with someone you share a plan with.
 */
export const LIMITS = {
  free: {
    activitiesPerDay: 2, aiSuggestionsPerDay: 3, overlapPreview: 3, cityChatDaysAhead: 3, seeViewers: false,
    // New DM conversations a free user can open per rolling 24 h, and messages in one before the other person answers.
    dmStartsPerDay: 1, dmMessagesBeforeReply: 3,
    // Phone numbers, emails and social handles in DMs and city chats (see lib/contact-shield.ts).
    shareContacts: false,
    maxPhotos: 3,
    canBoost: false,
    canIncognito: false,
    buddyRequestsPerDay: 3,
    maxTrustedContacts: 2,
    advancedFilters: false,
  },
  plus: {
    activitiesPerDay: 20, aiSuggestionsPerDay: 200, overlapPreview: Infinity, cityChatDaysAhead: 365, seeViewers: true,
    dmStartsPerDay: Infinity, dmMessagesBeforeReply: Infinity, shareContacts: true,
    maxPhotos: 6,
    canBoost: true,
    canIncognito: true,
    buddyRequestsPerDay: Infinity,
    maxTrustedContacts: 5,
    advancedFilters: true,
  },
};

export const BOOST_DURATION_HOURS = 24;

/**
 * Invite rewards. Both people get `rewardDays` of Plus as comp_until (plus_until is derived, see recomputePlus).
 * Only new accounts can redeem a code, and a referrer is rewarded for at most `maxRewards` sign-ups, so
 * throwaway accounts can't mint unlimited Plus for one person.
 */
export const REFERRAL = { rewardDays: 7, maxRewards: 10, redeemWithinDays: 14 };

/**
 * "Plus members get seen first" in Travelers and nearby: within the same online state and shared-interest
 * count, people are compared in distance bands this wide, and Plus sorts first inside a band. So a Plus member
 * only ever overtakes people less than 2 km closer. Trip overlaps (no distance) simply list Plus first.
 */
export const PLUS_RANK = { distanceBandM: 2000 };

export const PRODUCTS = [
  { id: 'tablamigo_plus', basePlan: 'weekly', label: '1 week', period: 'P1W' },
  { id: 'tablamigo_plus', basePlan: 'monthly', label: '1 month', period: 'P1M', badge: 'Most popular' },
  { id: 'tablamigo_plus', basePlan: 'halfyearly', label: '6 months', period: 'P6M' },
  { id: 'tablamigo_plus', basePlan: 'yearly', label: '1 year', period: 'P1Y', badge: 'Best value' },
];

/**
 * The launch offer: Plus free for everyone until LAUNCH_PLUS_UNTIL (config.launchPlusUntil). `until` is null when no offer is
 * configured, and stays set once it is over (`active` false), so callers can say it ended. The offer is not a rule in isPlus:
 * it is comp_until on each account (play.ts grantLaunchPlus), so Plus ends by itself on the date and every other source of Plus
 * keeps working beside it.
 */
export function launchOffer(now: Date = clock.now()): { active: boolean; until: Date | null } {
  // While everything is free there is no offer to tell anyone about, and nothing to grant at sign-up.
  if (config.allFree) return { active: false, until: null };
  const until = config.launchPlusUntil;
  return { active: !!until && now.getTime() < until.getTime(), until };
}

/** Everything is free right now (config.allFree, env ALL_FREE): every account gets Plus limits and nothing is sold. */
export const allFree = () => config.allFree;

/**
 * Whether the row `alias` (a users row) counts as Plus, for ranking and the Plus tag on other people. While everything is free
 * nobody is told apart (false for all), so nobody ranks first for having paid or for an old comp.
 */
// `false::boolean`, not a bare `false`: GET /activities sorts by this, and Postgres refuses a bare constant in ORDER BY
// ("non-integer constant in ORDER BY"), which made every plan list a 500 while ALL_FREE was on.
export const plusOf = (alias: string) => config.allFree ? sql`false::boolean` : sql`coalesce(${sql(alias)}.plus_until > now(), false)`;

export async function isPlus(userId: string) {
  if (config.allFree) return true;
  const [u] = await sql`select plus_until from users where id = ${userId}`;
  return !!(u?.plusUntil && new Date(u.plusUntil) > new Date());
}
/**
 * The limits for one account. In dunning (a failing renewal still being retried, SC-04) everything stays Plus except AI
 * ideas, the one feature that costs us per use: they drop to the free allowance until the renewal is paid.
 */
export async function limitsFor(userId: string) {
  if (config.allFree) return LIMITS.plus;
  const { plus, dunning } = await plusAccess(userId);
  if (!plus) return LIMITS.free;
  return dunning ? { ...LIMITS.plus, aiSuggestionsPerDay: LIMITS.free.aiSuggestionsPerDay } : LIMITS.plus;
}

/** Both are members of at least one plan: they met through the product. */
export async function sharePlan(a: string, b: string) {
  const [r] = await sql`select 1 from activity_members x join activity_members y on y.activity_id = x.activity_id
    where x.user_id = ${a} and y.user_id = ${b} limit 1`;
  return !!r;
}
