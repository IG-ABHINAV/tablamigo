// The store rating ask, wired to the app's two moments: a sent chat message (app/chat/[id].tsx) and a plan joined
// (app/activity/[id].tsx). Platform-free: review-prompt.ts (Android, iOS) and review-prompt.web.ts (the web app) give it storage,
// the server call, the screen state and what "ask" means there. tests/unit/review-trigger.test.mjs runs it with fakes.
//
// On each moment it counts the moment for the signed-in person (per user id, so an account switch starts from that account's
// own count), then asks review-policy.ts whether this is the time. If the screen is busy (keyboard up, a modal open, the app in
// the background) it waits up to 2 minutes for it to clear and settle; then the API must agree (POST /me/review-ask: earned on
// its side, not asked on any device in 60 days, a real traveller), and only then the store sheet or the web card. Offline, or
// any failure: nothing is shown and nothing is said. Callers fire and forget; this never throws.
import { decide, excludedAccount, noteJoined, noteSent, parseState, screenClear, type ReviewState } from './review-policy';

export type Surface = 'android' | 'ios' | 'web';
export type Trigger = 'messages' | 'plan_join';
export type ClaimResult = { ask: boolean; reason?: string; nextAt?: string };
export type Screen = { active: boolean; keyboard: boolean; overlay: boolean };
export type Me = { id: string; email?: string | null; role?: string | null };
export type Deps = {
  surface: Surface;
  /** Whether this device can show the ask at all (the store sheet exists; the card makes sense here). */
  supported: () => boolean | Promise<boolean>;
  load: (uid: string) => Promise<string | null>;
  save: (uid: string, raw: string) => Promise<void>;
  /** POST /me/review-ask. Throws when offline or refused (an admin's read-only look gets a 403). */
  claim: (surface: Surface, trigger: Trigger) => Promise<ClaimResult>;
  /** The store sheet, or the web card. */
  show: (trigger: Trigger) => Promise<void>;
  me: () => Me | null;
  impersonating: () => boolean;
  screen: () => Screen;
  sessionStart: () => number;
  now: () => number;
  wait: (ms: number) => Promise<void>;
  log: (line: string) => void;
  /** Tests shorten it; the app uses CLAIM_TIMEOUT_MS. */
  claimTimeoutMs?: number;
};

/** How long the screen must stay clear before the ask: a plan join first moves into the plan's chat. */
export const SETTLE_MS: Record<Trigger, number> = { messages: 800, plan_join: 2500 };
/** The longest a moment waits for a busy screen to clear; after that the next moment tries again. */
export const PENDING_MS = 2 * 60_000;
/** A server call that hangs (a half-open connection: fetch has no timeout on Android) counts as offline after this. */
export const CLAIM_TIMEOUT_MS = 10_000;
const POLL_MS = 250;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<never>((_, no) => { t = setTimeout(() => no(new Error('timeout')), ms); })]).finally(() => clearTimeout(t));
}

export function createReviewTrigger(d: Deps) {
  // One moment at a time, so rapid sends count one by one and only one of them goes on to ask.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  let busy = false;   // a moment is already waiting for the screen or the server, and will ask if anything does

  // Memory first, storage to survive a restart: a keystore that can't be read or written still asks at most once per run, and
  // the server's own 60 days cover the next run.
  const cache = new Map<string, ReviewState>();
  const read = async (uid: string) => cache.get(uid) ?? parseState(await d.load(uid).catch(() => null));
  const write = async (uid: string, s: ReviewState) => { cache.set(uid, s); await d.save(uid, JSON.stringify(s)).catch(() => {}); };
  const context = async (me: Me) => ({
    now: d.now(), sessionStart: d.sessionStart(), supported: await Promise.resolve(d.supported()).catch(() => false),
    impersonating: d.impersonating(), account: !excludedAccount(me), ...d.screen(),
  });
  const samePerson = (uid: string) => d.me()?.id === uid && !d.impersonating();

  /** Waits for the screen to be clear for `settle` ms in a row. False if it never is within PENDING_MS, or the person changed. */
  async function settled(uid: string, settle: number): Promise<boolean> {
    const end = d.now() + PENDING_MS;
    let clearSince: number | null = null;
    while (d.now() <= end) {
      if (!samePerson(uid)) return false;
      if (screenClear(d.screen())) {
        clearSince ??= d.now();
        if (d.now() - clearSince >= settle) return true;
      } else clearSince = null;
      await d.wait(POLL_MS);
    }
    return false;
  }

  async function moment(trigger: Trigger): Promise<string> {
    try {
      const me = d.me();
      if (!me?.id) return 'signed_out';
      const uid = me.id;
      const first = await serial(async () => {
        let s = await read(uid);
        const n = trigger === 'messages' ? noteSent(s) : noteJoined(s);
        if (n !== s) { s = n; await write(uid, s); }
        if (busy) return 'already_waiting';
        const dec = decide(s, await context(me));
        if (!dec.ok && !dec.wait) return dec.why;
        busy = true;
        return 'go';
      });
      if (first !== 'go') return first;
      try {
        if (!(await settled(uid, SETTLE_MS[trigger]))) return 'screen_busy';
        const claimed = await serial(async () => {
          const s = await read(uid);
          const dec = decide(s, await context(me));
          if (!dec.ok) return dec.why;
          // The account may have changed while this waited: the server would count the ask for whoever is signed in now.
          if (!samePerson(uid)) return 'screen_busy';
          let r: ClaimResult;
          try { r = await withTimeout(d.claim(d.surface, trigger), d.claimTimeoutMs ?? CLAIM_TIMEOUT_MS); }
          catch { await write(uid, { ...s, claimAt: d.now() }); return 'offline'; }
          if (!r?.ask) {
            const nextAt = r?.nextAt ? Date.parse(r.nextAt) : NaN;
            await write(uid, { ...s, claimAt: d.now(), excluded: s.excluded || r?.reason === 'excluded', nextAt: Number.isFinite(nextAt) ? nextAt : s.nextAt });
            return `server_${r?.reason ?? 'no'}`;
          }
          // The server has counted this ask for 60 days; remember it here too, before showing anything.
          await write(uid, { ...s, askedAt: d.now(), claimAt: d.now() });
          return 'claimed';
        });
        if (claimed !== 'claimed') return claimed;
        // The server call took a moment: the screen must still be clear (a sheet may have opened meanwhile).
        if (!(await settled(uid, 300))) return 'screen_busy_after_claim';
        d.log(`[review] asking (trigger=${trigger}, surface=${d.surface})`);
        await d.show(trigger).catch(() => {});
        return 'asked';
      } finally { busy = false; }
    } catch { return 'error'; }
  }

  return {
    /** A chat message this person sent went through (any chat, any kind but a system line). */
    messageSent: () => moment('messages'),
    /** This person just joined someone's plan as going (not the waitlist, not maybe). */
    planJoined: () => moment('plan_join'),
  };
}
