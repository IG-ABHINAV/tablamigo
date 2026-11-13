// When the app may ask someone for a store rating. Plain TypeScript with no Expo imports, so tests/unit/review-trigger.test.mjs
// runs it with fakes. lib/review-trigger.ts applies it; the API (apps/api/src/lib/review-ask.ts) has the final say.
//
// The owner's rule (26 Oct 2026): ask right after a person's 3rd sent chat message (any chat) or right after they join a plan,
// whichever comes first; at most once every 60 days per person; never in the first minute of a session; never for the Play
// reviewer, demo or test accounts; never on top of another modal or the keyboard.
//
// Store policy, not negotiable: the ask is the official sheet only (Google Play In-App Review on Android, SKStoreReviewController
// on iOS, both via expo-store-review). No custom "rate us 5 stars" text, no "do you like the app?" question first, no reward.
// The web app, which has no store sheet, shows a neutral "Rate us on Google Play" card under the same rule.
export const MESSAGES_TO_ASK = 3;
export const COOLDOWN_DAYS = 60;
/** No ask in a session's first minute. A session starts when the app starts, or comes back after 30 minutes away. */
export const SESSION_GRACE_MS = 60_000;
export const NEW_SESSION_AFTER_MS = 30 * 60_000;
/** After the server says "not yet" (not earned on its side, or an outage), the app waits this long before asking it again. */
export const CLAIM_RETRY_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/** What this phone or browser remembers for one person (keyed by user id, so switching accounts starts each from its own). */
export type ReviewState = {
  sent: number;               // chat messages sent, counted up to MESSAGES_TO_ASK
  joined: boolean;            // joined someone's plan as going
  askedAt: number | null;     // when this device last asked (the sheet or the card)
  nextAt: number | null;      // the server said: not before this (an ask on another device or surface)
  excluded: boolean;          // the server said: never this account
  claimAt: number | null;     // the last time the server was asked
};
export const EMPTY: ReviewState = { sent: 0, joined: false, askedAt: null, nextAt: null, excluded: false, claimAt: null };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** What was saved, or the empty state for anything missing or damaged (which can only ask later, never sooner). */
export function parseState(raw: string | null | undefined): ReviewState {
  try {
    const j = JSON.parse(raw ?? 'null');
    if (!j || typeof j !== 'object' || Array.isArray(j)) return EMPTY;
    const sent = num(j.sent);
    return {
      sent: sent === null ? 0 : Math.max(0, Math.min(MESSAGES_TO_ASK, Math.floor(sent))),
      joined: j.joined === true,
      askedAt: num(j.askedAt), nextAt: num(j.nextAt), claimAt: num(j.claimAt),
      excluded: j.excluded === true,
    };
  } catch { return EMPTY; }
}

export const noteSent = (s: ReviewState): ReviewState => s.sent >= MESSAGES_TO_ASK ? s : { ...s, sent: s.sent + 1 };
export const noteJoined = (s: ReviewState): ReviewState => s.joined ? s : { ...s, joined: true };
export const earned = (s: ReviewState) => s.sent >= MESSAGES_TO_ASK || s.joined;

/** Addresses the app itself can tell are not real travellers; the API also knows the store reviewer's login. */
const INTERNAL = /@(demo|deleted|team)\.tablamigo$/;
const TEST = /@([^@]+\.)?(test|example|invalid|localhost)$|@example\.(com|net|org)$/;
export function excludedAccount(me: { email?: string | null; role?: string | null } | null | undefined): boolean {
  if (!me) return true;
  if (me.role === 'admin') return true;
  const email = (me.email ?? '').trim().toLowerCase();
  return !email.includes('@') || INTERNAL.test(email) || TEST.test(email);
}

export type Context = {
  now: number;
  sessionStart: number;
  supported: boolean;     // a store sheet (or, on the web, the card) exists here
  impersonating: boolean; // an admin's read-only look through someone's account
  account: boolean;       // excludedAccount() said yes, it is a real traveller
  active: boolean;        // the app is in the foreground
  keyboard: boolean;
  overlay: boolean;       // a modal, sheet or modal screen is open
};
export type Why = 'unsupported' | 'impersonating' | 'excluded' | 'not_earned' | 'cooldown' | 'session_minute' | 'claim_wait'
  | 'background' | 'keyboard' | 'overlay';
/** wait: the moment is right but the screen isn't (keyboard, a modal, the app in the background): try again once it clears. */
export type Decision = { ok: true } | { ok: false; why: Why; wait: boolean };

export function decide(s: ReviewState, c: Context): Decision {
  const no = (why: Why, wait = false): Decision => ({ ok: false, why, wait });
  if (!c.supported) return no('unsupported');
  if (c.impersonating) return no('impersonating');
  if (!c.account || s.excluded) return no('excluded');
  if (!earned(s)) return no('not_earned');
  // A clock set back after an ask keeps it quiet rather than asking again.
  if (s.askedAt !== null && (c.now < s.askedAt || c.now - s.askedAt < COOLDOWN_DAYS * DAY_MS)) return no('cooldown');
  if (s.nextAt !== null && c.now < s.nextAt) return no('cooldown');
  if (c.now - c.sessionStart < SESSION_GRACE_MS) return no('session_minute');
  if (s.claimAt !== null && c.now >= s.claimAt && c.now - s.claimAt < CLAIM_RETRY_MS) return no('claim_wait');
  if (!c.active) return no('background', true);
  if (c.keyboard) return no('keyboard', true);
  if (c.overlay) return no('overlay', true);
  return { ok: true };
}

/** Same check, for the screen only: is it clear to show the sheet or the card right now? */
export const screenClear = (c: Pick<Context, 'active' | 'keyboard' | 'overlay'>) => c.active && !c.keyboard && !c.overlay;

/** The new session start after the app comes back to the foreground (a long time away starts a new session). */
export const sessionStartAfterResume = (start: number, backgroundAt: number | null, now: number) =>
  backgroundAt !== null && now - backgroundAt >= NEW_SESSION_AFTER_MS ? now : start;
