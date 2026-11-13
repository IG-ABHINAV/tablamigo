/**
 * The in-process scheduler: every minute it runs what is due on plans (reminders, the next session of recurring plans), the
 * Tablamigo Host's welcome DMs (lib/host.ts, HOST_WELCOME) and the community starter plans (lib/starter-plans.ts: decided
 * every tick, listed once an hour, STARTER_PLANS), Google Play purchases still not acknowledged (lib/play-ack.ts), on the first
 * tick of each UTC hour the billing reconcile (lib/billing-reconcile.ts), and on the first tick of each UTC day the retention purge (lib/retention.ts).
 * main.ts starts it; SCHEDULER=off stops it (config.scheduler).
 *
 * Two API processes can be alive at once (a deploy's reload, a second instance), so a tick only runs when it gets a Postgres
 * advisory lock; the other one skips that minute. The lock is a transaction lock, so it is released when the tick ends or the
 * process dies, never left behind. The jobs claim what they send with a single UPDATE as well (lib/plan-jobs.ts), so even
 * without the lock nothing is sent twice.
 */
import { sql } from './db.js';
import { clock } from './clock.js';
import { config } from './config.js';
import { processPlanReminders, processDueRecurring } from './plan-jobs.js';
import { purgeExpired, isCurrent } from './retention.js';
import { processHostWelcomes } from './host.js';
import { processStarterPlans } from './starter-plans.js';
import { processTripMatches } from './trip-match.js';
import { processPlusWelcomes } from './plus-welcome.js';
import { processCityNudges } from './city-nudge.js';
import { processLadder } from './ladder.js';
import { planViewSummaries } from './engagement.js';
import { processPlayAcks } from './play-ack.js';
import { processHostRewards } from './host-rewards.js';
import { reconcileBilling } from './billing-reconcile.js';

/** Key of the scheduler's advisory lock. Locks are per database, and this API has a database of its own. */
export const SCHEDULER_LOCK = 7_424_240_001;

export type TickResult =
  | { ran: false }
  | { ran: true; reminders: Awaited<ReturnType<typeof processPlanReminders>> | { error: string }; recurring: Awaited<ReturnType<typeof processDueRecurring>> | { error: string };
      /** Counts per table on the tick that did the day's purge; null on every other tick. */
      purge: Awaited<ReturnType<typeof purgeExpired>> | { error: string } | null;
      welcomes: Awaited<ReturnType<typeof processHostWelcomes>> | { error: string };
      starter: Awaited<ReturnType<typeof processStarterPlans>> | { error: string };
      tripMatches: Awaited<ReturnType<typeof processTripMatches>> | { error: string };
      plusWelcomes: Awaited<ReturnType<typeof processPlusWelcomes>> | { error: string };
      cityNudges: Awaited<ReturnType<typeof processCityNudges>> | { error: string };
      planViews: Awaited<ReturnType<typeof planViewSummaries>> | { error: string };
      hostRewards: Awaited<ReturnType<typeof processHostRewards>> | { error: string };
      ladder: Awaited<ReturnType<typeof processLadder>> | { error: string };
      playAcks: Awaited<ReturnType<typeof processPlayAcks>> | { error: string };
      /** The billing reconcile's report on the tick that ran it (the first of each UTC hour); null on every other tick. */
      billing: Awaited<ReturnType<typeof reconcileBilling>> | { error: string } | null };

const failure = (job: string, e: unknown) => { console.error(`scheduler: ${job} failed`, (e as Error)?.message); return { error: (e as Error)?.message ?? 'failed' }; };

const JOBS = { processPlanReminders, processDueRecurring, purgeExpired, processHostWelcomes: (now: Date) => processHostWelcomes(now), processStarterPlans: (now: Date) => processStarterPlans(now),
  processTripMatches: (now: Date) => processTripMatches(now), processPlusWelcomes: (now: Date) => processPlusWelcomes(now),
  processCityNudges: (now: Date) => processCityNudges(now), planViewSummaries: (now: Date) => planViewSummaries(now),
  processLadder: (now: Date) => processLadder(now), processPlayAcks: (now: Date) => processPlayAcks(now), processHostRewards: (now: Date) => processHostRewards(now),
  reconcileBilling: (now: Date) => reconcileBilling({ now }) };
/**
 * The UTC day the retention purge last completed, and the UTC hour the billing reconcile last ran, in this process. A restart
 * may run either once more, which is harmless (both are idempotent).
 */
const purged = { day: null as string | null, billingHour: null as string | null };

/**
 * One pass over everything that is due at `now`. `{ ran: false }` means another process holds the lock this minute.
 * The purge runs on the first tick of a UTC day, and only for a `now` that is the real time. (`overrides` and `state` are
 * for tests; the defaults are the real jobs.)
 */
export async function runSchedulerTick(now: Date = clock.now(), overrides: Partial<typeof JOBS> = {}, state: { day: string | null; billingHour?: string | null } = purged): Promise<TickResult> {
  const jobs = { ...JOBS, ...overrides };
  const tick: TickResult = await sql.begin(async tx => {
    const [{ locked }] = await tx`select pg_try_advisory_xact_lock(${SCHEDULER_LOCK}) as locked`;
    if (!locked) return { ran: false } as const;
    // The jobs use their own connections; this transaction only holds the lock until they are done. One failing job
    // doesn't stop the other.
    const reminders = await jobs.processPlanReminders(now).catch(e => failure('plan reminders', e));
    const recurring = await jobs.processDueRecurring(now).catch(e => failure('recurring plans', e));
    const day = now.toISOString().slice(0, 10);
    let purge: Awaited<ReturnType<typeof purgeExpired>> | { error: string } | null = null;
    if (state.day !== day && isCurrent(now)) {
      purge = await jobs.purgeExpired(now).catch(e => failure('retention purge', e));
      if (!('error' in purge)) state.day = day;
    }
    const welcomes = await jobs.processHostWelcomes(now).catch(e => failure('host welcomes', e));
    const starter = await jobs.processStarterPlans(now).catch(e => failure('starter plans', e));
    // The automatic team messages and the delivery ladder (lib/trip-match.ts, lib/plus-welcome.ts, lib/city-nudge.ts,
    // lib/engagement.ts, lib/ladder.ts). The ladder goes last, so it sees what this tick sent.
    const tripMatches = await jobs.processTripMatches(now).catch(e => failure('trip matches', e));
    const plusWelcomes = await jobs.processPlusWelcomes(now).catch(e => failure('plus welcomes', e));
    const cityNudges = await jobs.processCityNudges(now).catch(e => failure('city nudges', e));
    const planViews = await jobs.planViewSummaries(now).catch(e => failure('plan views', e));
    const hostRewards = await jobs.processHostRewards(now).catch(e => failure('host rewards', e));
    const ladder = await jobs.processLadder(now).catch(e => failure('ladder', e));
    // Google Play purchases still not acknowledged (lib/play-ack.ts): only the ones that are due, so most ticks do one query.
    const playAcks = await jobs.processPlayAcks(now).catch(e => failure('play acks', e));
    return { ran: true, reminders, recurring, purge, welcomes, starter, tripMatches, plusWelcomes, cityNudges, planViews, hostRewards, ladder, playAcks, billing: null } as const;
  });
  if (!tick.ran) return tick;
  // Lost Razorpay forwards and Play pushes, missed refunds and chargebacks, charges that must not happen: once an hour. Outside
  // the tick's transaction (it makes many store calls, and the minute's jobs must not wait for it), under a lock of its own.
  const hour = now.toISOString().slice(0, 13);
  if (state.billingHour !== hour && isCurrent(now)) {
    state.billingHour = hour;
    const reserved = await sql.reserve();
    try {
      const [{ locked }] = await reserved`select pg_try_advisory_lock(${BILLING_LOCK}) as locked`;
      if (locked) {
        try {
          const billing = await jobs.reconcileBilling(now).catch(e => failure('billing reconcile', e));
          if ('errors' in billing && billing.errors.length) console.error('scheduler: billing reconcile', billing.errors.slice(0, 5).join('; '));
          return { ...tick, billing };
        } finally { await reserved`select pg_advisory_unlock(${BILLING_LOCK})`; }
      }
    } finally { reserved.release(); }
  }
  return tick;
}

/** The billing reconcile's own advisory lock (session level, on a reserved connection), so two processes never run it at once. */
export const BILLING_LOCK = 7_424_240_002;

/**
 * Runs `run` every `intervalMs` (a minute). A tick that is still running when the next is due makes the next one skip, so
 * slow work never piles up; an error is logged and the timer keeps going. Returns the function that stops it.
 */
export function startScheduler({ intervalMs = 60_000, run = runSchedulerTick, onError = (m: string) => console.error(m) }: {
  intervalMs?: number; run?: () => Promise<unknown>; onError?: (message: string) => void;
} = {}) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await run(); }
    catch (e) { onError(`scheduler tick failed: ${(e as Error)?.message}`); }
    finally { busy = false; }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** main.ts: start the scheduler unless SCHEDULER=off. Returns the stop function, or null when it is off. */
export function startSchedulerIfEnabled() {
  // PM2 can keep a stale saved env when a value changes, so say which modes this process actually runs with.
  console.log(`tablamigo host: HOST_WELCOME=${config.hostWelcome} STARTER_PLANS=${config.starterPlans} TRIP_MATCH=${config.tripMatch} PLUS_WELCOME=${config.plusWelcome} CITY_NUDGE=${config.cityNudge} TRIP_MATCH_PER_DAY=${config.tripMatchPerDay} EMAIL_LADDER=${config.emailLadder} ENGAGEMENT=${config.engagement}`);
  if (!config.scheduler) { console.log('scheduler: off (SCHEDULER=off)'); return null; }
  console.log('scheduler: on (plans, host welcomes and starter plans every minute, retention purge daily)');
  return startScheduler({ intervalMs: config.schedulerIntervalMs });
}
