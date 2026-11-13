/**
 * Activation nudges: emails for people who signed up but haven't verified their selfie, joined or hosted a plan,
 * or added a trip. runEmailJobs() runs this every 10 minutes; every send goes through deliver(), so the email_log
 * key (kind, user, 'once') makes each nudge at-most-once per user, and the 'reminders' opt-out applies.
 *
 * Timing (from sign-up, `now` = the run's time):
 *   activation_verify_1  not verified, 24 h after sign-up
 *   activation_verify_2  still not verified, 4 days after verify_1 (the last verification nudge)
 *   activation_plan      verified, never joined or hosted a plan, 48 h after verifying (and after sign-up)
 *   activation_trip      no trip at all, 72 h after sign-up
 * Rules: one activation email per user per 48 h; at most 3 ever; accounts created before ACTIVATION_LAUNCH get at
 * most 1 (no backlog blast); only between 10:00 and 20:00 India time; never deleted, banned, under-18, review or demo
 * accounts; a nudge stops as soon as its step is done (every run re-reads the user's state).
 */
import { sql } from '../db.js';
import { config } from '../config.js';
import { deliver, type Outcome } from './send.js';
import * as T from './templates.js';
import { zoneAt, localDate } from '../local-time.js';
import { realPerson } from '../travellers-week.js';

export const ACTIVATION_KINDS = ['activation_verify_1', 'activation_verify_2', 'activation_plan', 'activation_trip'] as const;
export type ActivationKind = typeof ACTIVATION_KINDS[number];

/** Accounts created before this get at most one activation email: the feature shipped on 13 Oct 2026. */
export const ACTIVATION_LAUNCH = new Date('2026-10-13T00:00:00Z');
export const MAX_ACTIVATION_EMAILS = 3;
export const MAX_FOR_EXISTING = 1;
export const COOLDOWN_HOURS = 48;
/** Sending window in India time, [start, end). */
export const SEND_FROM_IST = 10, SEND_UNTIL_IST = 20;
/** Spam guards: per run, and across all runs in 24 h. A bug that selects everyone stops here. */
export const MAX_PER_RUN = 25, MAX_PER_DAY = 100;
/** Sign-ups older than this are left alone entirely. */
export const MAX_ACCOUNT_AGE_DAYS = 60;

const H = 3600_000, IST_MS = 5.5 * H;
export const inSendWindow = (now: Date) => { const h = new Date(now.getTime() + IST_MS).getUTCHours(); return h >= SEND_FROM_IST && h < SEND_UNTIL_IST; };

/** An earlier activation email, as email_log holds it. */
export type LogRow = { kind: string; at: Date | string; status: string; attempts: number };
export type Candidate = {
  id: string; createdAt: Date | string; verified: boolean; verifiedAt: Date | string | null; verifyPending: boolean;
  hasPlan: boolean; hasTrip: boolean; log: LogRow[];
  /** Any email (activation or not, e.g. the welcome or the Monday digest) in the last 24 h: wait, so nobody gets two in a day. */
  recentEmail?: boolean;
};

const ms = (d: Date | string) => new Date(d).getTime();
/** Counts against the caps and the cooldown: anything but a failed send. */
const counts = (r: LogRow) => r.status !== 'failed';
/** Settles the kind: deliver() will not retry it (same rule as `settled` in jobs.ts). */
const settles = (r: LogRow) => r.status !== 'failed' || r.attempts >= 3;

/** The one activation email this user is due now, or null. Pure: the selection rules, tested on their own. */
export function nextActivation(c: Candidate, now: Date, launch: Date = ACTIVATION_LAUNCH): ActivationKind | null {
  const t = now.getTime(), age = t - ms(c.createdAt);
  if (age > MAX_ACCOUNT_AGE_DAYS * 24 * H) return null;
  const sent = c.log.filter(counts);
  const cap = ms(c.createdAt) < launch.getTime() ? MAX_FOR_EXISTING : MAX_ACTIVATION_EMAILS;
  if (sent.length >= cap) return null;
  if (sent.some(r => t - ms(r.at) < COOLDOWN_HOURS * H)) return null;
  if (c.recentEmail) return null;
  const done = (k: ActivationKind) => c.log.find(r => r.kind === k && settles(r));

  if (!c.verified && !c.verifyPending) {
    const v1 = done('activation_verify_1');
    if (!v1 && age >= 24 * H) return 'activation_verify_1';
    // The second one says "last reminder": only after a first one that actually went out.
    if (v1 && counts(v1) && !done('activation_verify_2') && t - ms(v1.at) >= 4 * 24 * H) return 'activation_verify_2';
  }
  if (c.verified && !c.hasPlan && !done('activation_plan') && age >= 48 * H && t - ms(c.verifiedAt ?? c.createdAt) >= 48 * H) return 'activation_plan';
  if (!c.hasTrip && !done('activation_trip') && age >= 72 * H) return 'activation_trip';
  return null;
}

/** Everyone who could get an activation email, with what the rules need. Read-only. */
export async function activationCandidates(now: Date, emailLike?: string) {
  const review = config.reviewEmails;
  return await sql`select u.id, u.email, u.name, u.gender, u.home_country, u.created_at, u.verified,
      (select max(coalesce(r.reviewed_at, r.checked_at, r.created_at)) from verification_requests r where r.user_id = u.id and r.status = 'approved') as verified_at,
      exists(select 1 from verification_requests r where r.user_id = u.id and r.status = 'pending') as verify_pending,
      (exists(select 1 from activity_members m where m.user_id = u.id) or exists(select 1 from activities a where a.host_id = u.id)) as has_plan,
      exists(select 1 from trips t where t.user_id = u.id) as has_trip,
      coalesce((select json_agg(json_build_object('kind', l.kind, 'at', l.created_at, 'status', l.status, 'attempts', l.attempts))
        from email_log l where l.user_id = u.id and l.kind = any(${ACTIVATION_KINDS as unknown as string[]})), '[]'::json) as log,
      -- A sign-in code (kind login_code, logged since 22 Oct) is not an email we chose to send: it doesn't hold the next one back.
      exists(select 1 from email_log l where l.user_id = u.id and l.kind <> 'login_code' and l.status <> 'failed' and l.created_at > ${now}::timestamptz - interval '24 hours') as recent_email
    from users u
    where u.deleted_at is null and u.banned_at is null and u.onboarded
      and u.birthdate is not null and u.birthdate <= (${now}::timestamptz at time zone 'UTC')::date - interval '18 years'
      and u.created_at > ${now}::timestamptz - ${MAX_ACCOUNT_AGE_DAYS + ' days'}::interval
      and u.email not like '%@demo.tablamigo' and not (lower(u.email) = any(${review}::text[]))
      and coalesce(u.email_prefs->>'reminders', 'true') <> 'false' and coalesce(u.email_prefs->>'all', 'true') <> 'false'
      and (${emailLike ?? null}::text is null or u.email like ${emailLike ?? null})
    order by u.created_at` as unknown as (Candidate & { email: string; name: string | null; gender: string | null; homeCountry: string | null })[];
}

export type PlanScope = 'trip_dates' | 'trip_city' | 'near' | null;
/**
 * Up to 3 upcoming plans to show one user, nearest match first: their next trip's city on its dates, that city on any
 * date in the next 60 days, then within 50 km of where they last were (or their home city). Nothing else: a plan on the
 * other side of the world is no use, and the email then says there are no open plans and suggests posting one.
 * `excludeTeam` leaves out the Tablamigo Host's community starter plans (the Host's welcome DM lists those on their own).
 * `realGoing` makes `going` (and the order) count real people only (lib/travellers-week.ts realPerson): a demo persona (the AI
 * engagement worker joins quiet plans) or a store review account takes a seat but is not someone to meet. The Host's welcome
 * DM uses it, so the team account never states a number that isn't people. A full plan is still full whoever holds the seats.
 */
export async function plansFor(u: { id: string; gender: string | null }, now: Date = new Date(), opts: { excludeTeam?: boolean; realGoing?: boolean } = {}) {
  const [trip] = await sql`select id, city, start_date, end_date from trips where user_id = ${u.id} and end_date >= current_date order by start_date limit 1`;
  const seats = sql`(select count(*)::int from activity_members m where m.activity_id = a.id and m.rsvp_status = 'going')`;
  const going = opts.realGoing
    ? sql`(select count(*)::int from activity_members m join users u on u.id = m.user_id where m.activity_id = a.id and m.rsvp_status = 'going' and ${realPerson()})`
    : seats;
  const base = (extra: any) => sql`select a.id, a.title, a.emoji, a.place_name, a.city, a.starts_at,
        st_y(a.location::geometry) as lat, st_x(a.location::geometry) as lng, ${going} as going
      from activities a join users h on h.id = a.host_id
      where a.status = 'active' and not a.closed and not a.is_paid
        and a.starts_at > ${now}::timestamptz + interval '1 hour' and a.starts_at < ${now}::timestamptz + interval '60 days'
        and (not a.women_only or ${u.gender === 'woman'})
        and h.deleted_at is null and h.banned_at is null and (h.snoozed_until is null or h.snoozed_until <= now())
        and h.email not like '%@demo.tablamigo' and a.host_id <> ${u.id}
        ${opts.excludeTeam ? sql`and h.account_kind = 'person'` : sql``}
        and not exists (select 1 from blocks b where (b.blocker_id = ${u.id} and b.blocked_id = a.host_id) or (b.blocker_id = a.host_id and b.blocked_id = ${u.id}))
        and (a.max_people is null or ${seats} < a.max_people)
        ${extra}
      order by going desc, a.starts_at limit 3`;
  const out = (scope: PlanScope, plans: any[]) => ({ trip: trip ?? null, scope, plans });
  if (trip) {
    const dates = await base(sql`and lower(a.city) = lower(${trip.city}) and a.starts_at >= ${trip.startDate}::date - interval '1 day' and a.starts_at < ${trip.endDate}::date + interval '2 days'`);
    if (dates.length) return out('trip_dates', dates);
    const city = await base(sql`and lower(a.city) = lower(${trip.city})`);
    if (city.length) return out('trip_city', city);
  }
  const near = await base(sql`and a.starts_at < ${now}::timestamptz + interval '14 days' and exists (select 1 from users me where me.id = ${u.id}
      and ((me.location is not null and st_dwithin(a.location, me.location, 50000)) or (me.city is not null and lower(a.city) = lower(me.city))))`);
  return out(near.length ? 'near' : null, near);
}

const planLine = (p: any): T.PlanTeaser => ({
  id: p.id, title: p.title, emoji: p.emoji, placeName: p.placeName, city: p.city, going: p.going,
  day: localDate(new Date(p.startsAt), zoneAt(p.lat, p.lng)),
});

async function build(kind: ActivationKind, c: Awaited<ReturnType<typeof activationCandidates>>[number], now: Date) {
  const hinglish = c.homeCountry === 'IN';   // Hinglish touches only for people from India
  if (kind === 'activation_verify_1') return { meta: undefined, build: (u: { name: string | null }) => T.verifyNudge({ name: u.name, second: false, hinglish }) };
  if (kind === 'activation_verify_2') return { meta: undefined, build: (u: { name: string | null }) => T.verifyNudge({ name: u.name, second: true, hinglish }) };
  if (kind === 'activation_trip') return { meta: undefined, build: (u: { name: string | null }) => T.tripNudge({ name: u.name, hinglish }) };
  const r = await plansFor(c, now);
  const plans = r.plans.map(planLine);
  return {
    meta: { plans: plans.length, tripCity: r.trip?.city ?? null, scope: r.scope },
    build: (u: { name: string | null }) => T.planNudge({ name: u.name, trip: r.trip ? { city: r.trip.city } : null, scope: r.scope, plans }),
  };
}

export type Planned = { userId: string; email: string; kind: ActivationKind; detail?: Record<string, unknown> };
type Tally = Record<string, Partial<Record<Outcome, number>>>;

/**
 * One pass. With dryRun nothing is written or sent: it returns who would get which email now (ignoring the send window,
 * which it reports). `now` is the run's time (tests give it); `emailLike` and `launch` are for tests.
 */
export async function runActivation(t: Tally = {}, now = new Date(), opts: { dryRun?: boolean; emailLike?: string; launch?: Date } = {}) {
  const planned: Planned[] = [];
  if (!opts.dryRun && !inSendWindow(now)) return { tally: t, planned, skipped: 'quiet_hours' as const };
  const [{ n: today }] = await sql`select count(*)::int as n from email_log where kind = any(${ACTIVATION_KINDS as unknown as string[]}) and status <> 'failed' and created_at > ${now}::timestamptz - interval '24 hours'`;
  let budget = Math.min(MAX_PER_RUN, MAX_PER_DAY - today);
  for (const c of await activationCandidates(now, opts.emailLike)) {
    if (budget <= 0) break;
    const kind = nextActivation(c, now, opts.launch);
    if (!kind) continue;
    const b = await build(kind, c, now);
    planned.push({ userId: c.id, email: c.email, kind, detail: b.meta });
    budget--;
    if (opts.dryRun) continue;
    const o = await deliver({ kind, userId: c.id, periodKey: 'once', meta: b.meta, build: b.build });
    (t[kind] ??= {})[o] = (t[kind]![o] ?? 0) + 1;
  }
  return { tally: t, planned, skipped: null, window: inSendWindow(now) };
}
