/**
 * Time-based customer emails. main.ts runs runEmailJobs() every 10 minutes (next to the 6-hourly
 * Razorpay sync). Each job picks candidates from the database and hands them to deliver(), whose
 * email_log claim makes a second run, a restart or an overlapping run a no-op.
 *
 * Nothing here writes to subscriptions, passes or users: it only reads what billing already stored
 * (Google RTDN states, the Razorpay sync, Trip Passes, comps).
 */
import { sql } from '../db.js';
import { config } from '../config.js';
import { RAZORPAY_PRICES, PERIODS, type Period } from '../razorpay.js';
import { deliver, type Outcome } from './send.js';
import * as T from './templates.js';
import { runActivation } from './activation.js';
import { retryFailedOwnerAlerts } from '../owner-alerts.js';
import type { Person } from './layout.js';
import { tripSoon } from '../engagement.js';

const ACTIVE = 'SUBSCRIPTION_STATE_ACTIVE', GRACE = 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', CANCELED = 'SUBSCRIPTION_STATE_CANCELED', ON_HOLD = 'SUBSCRIPTION_STATE_ON_HOLD';
export const JOIN_WINDOW_HOURS = 6;
const JOIN_GRACE_MIN = 15;   // a push went out at join time; give the host a chance to open the app first

const region = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (c?: string | null) => { try { return c ? region.of(c) ?? c : null; } catch { return c ?? null; } };
const same = (a?: Date | null, b?: Date | null) => !!a && !!b && Math.abs(new Date(a).getTime() - new Date(b).getTime()) < 1000;

// A log row that still blocks a candidate: anything but a failure deliver() may retry (see send.ts).
const settled = sql`(l.status <> 'failed' or l.attempts >= 3)`;

type Tally = Record<string, Partial<Record<Outcome, number>>>;
const count = (t: Tally, kind: string, o: Outcome) => { (t[kind] ??= {})[o] = (t[kind][o] ?? 0) + 1; };

/** Receipts for Play and Razorpay subscriptions and Trip Passes, one per purchase token. */
async function plusStarted(t: Tally) {
  const subs = await sql`select s.purchase_token, s.user_id, s.platform, s.expires_at,
      coalesce(s.raw->'notes'->>'product', s.raw->'lineItems'->0->'offerDetails'->>'basePlanId') as plan,
      s.raw->'lineItems'->0->'autoRenewingPlan'->'recurringPrice' as google_price,
      coalesce(s.raw->>'latestOrderId', s.raw->>'id') as order_id,
      coalesce(to_timestamp((s.raw->>'start_at')::bigint), (s.raw->>'startTime')::timestamptz, now()) as started_at
    from subscriptions s
    where s.status = ${ACTIVE} and s.expires_at > now() and s.updated_at > now() - interval '3 days'
      and not exists (select 1 from email_log l where l.kind = 'plus_started' and l.user_id = s.user_id and l.period_key = s.purchase_token and ${settled})`;
  for (const s of subs) {
    const period = String(s.plan ?? '').replace(/^tablamigo_plus_/, '') || null;
    let amount: string | null = null;
    if (s.platform === 'razorpay' && PERIODS.includes(period as Period)) amount = T.money(RAZORPAY_PRICES[period as Period], RAZORPAY_PRICES.currency);
    const gp = s.googlePrice;
    if (s.platform === 'google' && gp?.currencyCode) amount = T.money(Math.round((Number(gp.units ?? 0) + Number(gp.nanos ?? 0) / 1e9) * 100), gp.currencyCode);
    count(t, 'plus_started', await deliver({ kind: 'plus_started', userId: s.userId, periodKey: s.purchaseToken, ref: s.purchaseToken,
      build: u => T.plusStarted({ name: u.name, kind: 'subscription', platform: s.platform, period, amount, orderId: s.orderId, startedAt: s.startedAt, until: s.expiresAt }) }));
  }
  const passes = await sql`select p.purchase_token, p.user_id, p.order_id, p.expires_at, p.created_at,
      (p.raw->>'amount')::int as amount, p.raw->>'currency' as currency, p.purchase_token like 'rzp:%' as web
    from passes p where p.voided_at is null and p.created_at > now() - interval '3 days'
      -- A pass taken from the Trip Pass wallet (routes/me.ts) was paid for when the wallet was credited: no receipt.
      and p.purchase_token not like 'wallet:%'
      and not exists (select 1 from email_log l where l.kind = 'plus_started' and l.user_id = p.user_id and l.period_key = p.purchase_token and ${settled})`;
  for (const p of passes) {
    count(t, 'plus_started', await deliver({ kind: 'plus_started', userId: p.userId, periodKey: p.purchaseToken, ref: p.purchaseToken,
      build: u => T.plusStarted({ name: u.name, kind: 'pass', platform: p.web ? 'razorpay' : 'google',
        amount: p.amount ? T.money(p.amount, p.currency ?? 'INR') : null, orderId: p.web ? p.purchaseToken.slice(4) : p.orderId, startedAt: p.createdAt, until: p.expiresAt }) }));
  }
}

/** Renewal declined (grace period) or retries exhausted (on hold), as stored by RTDN or the Razorpay sync. */
async function paymentProblems(t: Tally) {
  const rows = await sql`select s.purchase_token, s.user_id, s.platform, s.status, s.expires_at,
      to_char(coalesce(s.expires_at, s.updated_at) at time zone 'UTC', 'YYYY-MM-DD') as day
    from subscriptions s join users u on u.id = s.user_id
    where s.status in (${GRACE}, ${ON_HOLD}) and s.updated_at > now() - interval '7 days' and u.deleted_at is null`;
  for (const s of rows) {
    const onHold = s.status === ON_HOLD, kind = onHold ? 'plus_on_hold' : 'plus_payment_failed';
    count(t, kind, await deliver({ kind, userId: s.userId, periodKey: `${s.purchaseToken}:${s.day}`, ref: s.purchaseToken,
      build: u => T.paymentProblem({ name: u.name, platform: s.platform === 'google' ? 'google' : 'razorpay', onHold, until: s.expiresAt }) }));
  }
}

/**
 * Plus ending in 3 days (not renewing), Trip Pass ending in 2 days, and Plus ended in the last 3 days.
 * The period key is the plus_until date, so a later purchase that ends again gets its own emails.
 * plus_until is derived by recomputePlus() from subscriptions, passes and comp_until; the source is
 * whichever of those equals it. A comp that ends exactly when the launch offer does (config.launchPlusUntil) is the launch
 * offer itself: those accounts get the launch offer's own wording, with the price to continue and no mention of a renewal.
 * `now` is the time the run is for (tests give it).
 */
export async function plusLifecycle(t: Tally = {}, now: Date = new Date()) {
  // While everything is free nobody loses anything when their Plus, pass or comp ends, so there is nothing to tell them.
  if (config.allFree) return t;
  const rows = await sql`select u.id, u.plus_until, u.comp_until,
      to_char(u.plus_until at time zone 'UTC', 'YYYY-MM-DD') as day,
      u.plus_until > ${now}::timestamptz as live,
      (select max(p.expires_at) from passes p where p.user_id = u.id and p.voided_at is null) as pass_until,
      (select max(s.expires_at) from subscriptions s where s.user_id = u.id and s.status in (${ACTIVE}, ${GRACE}, ${CANCELED})) as sub_until,
      exists(select 1 from subscriptions s where s.user_id = u.id and s.status in (${ACTIVE}, ${GRACE})
        and s.cancel_requested_at is null and s.expires_at >= u.plus_until - interval '1 minute') as renews,
      exists(select 1 from subscriptions s where s.user_id = u.id and s.status in (${GRACE}, ${ON_HOLD})) as payment_problem,
      -- Ended by a refund, a chargeback or a halted renewal: that event's own email said Plus ended (billing-scenarios.md).
      (u.billing_disputed_at is not null or exists(select 1 from subscriptions s where s.user_id = u.id and s.ended_reason is not null
        and s.updated_at > ${now}::timestamptz - interval '4 days')) as ended_by_billing
    from users u
    where u.deleted_at is null and u.banned_at is null
      and u.plus_until between ${now}::timestamptz - interval '3 days' and ${now}::timestamptz + interval '3 days'`;
  const offerEnd = config.launchPlusUntil;
  const prices = { monthly: T.money(RAZORPAY_PRICES.monthly), yearly: T.money(RAZORPAY_PRICES.yearly) };
  for (const r of rows) {
    if (r.renews) continue;
    const until = new Date(r.plusUntil);
    const source = same(r.passUntil, until) ? 'pass' : same(r.subUntil, until) ? 'subscription' : offerEnd && same(r.compUntil, offerEnd) && same(until, offerEnd) ? 'launch' : 'comp';
    if (r.live) {
      const hoursLeft = (until.getTime() - now.getTime()) / 3600_000;
      if (source === 'pass') {
        if (hoursLeft <= 48) count(t, 'pass_expiring', await deliver({ kind: 'pass_expiring', userId: r.id, periodKey: r.day, build: u => T.passExpiring({ name: u.name, until, now }) }));
      } else if (!r.paymentProblem) {
        count(t, 'plus_ending', await deliver({ kind: 'plus_ending', userId: r.id, periodKey: r.day,
          build: u => source === 'launch' ? T.launchOfferEnding({ name: u.name, until, prices, now }) : T.plusEndingSoon({ name: u.name, until, source, now }) }));
      }
    } else if (!r.paymentProblem && !r.endedByBilling) {
      count(t, 'plus_ended', await deliver({ kind: 'plus_ended', userId: r.id, periodKey: r.day,
        build: u => source === 'launch' ? T.launchOfferEnded({ name: u.name, prices }) : T.plusEnded({ name: u.name, source }) }));
    }
  }
  return t;
}

/**
 * "Someone joined your plan", batched: at most one email per plan per JOIN_WINDOW_HOURS, listing the
 * people who joined since the last one, and only those who joined after the host last opened the app.
 */
export async function planJoins(t: Tally = {}) {
  const rows = await sql`
    with last as (select ref, max(created_at) as at from email_log where kind = 'plan_joined' and status in ('sent', 'pending') group by ref)
    select a.id, a.title, a.place_name, a.host_id, l.at as last_at,
      (select count(*)::int from activity_members x where x.activity_id = a.id) as total,
      json_agg(json_build_object('name', j.name, 'photo', j.photo_url, 'country', j.home_country) order by m.joined_at) as joiners
    from activities a
    join users h on h.id = a.host_id
    join activity_members m on m.activity_id = a.id and m.user_id <> a.host_id
    join users j on j.id = m.user_id and j.deleted_at is null and j.banned_at is null
    left join last l on l.ref = a.id::text
    where a.status = 'active' and a.starts_at > now() - interval '2 hours'
      and h.deleted_at is null and h.banned_at is null and h.account_kind = 'person'   -- never the Tablamigo Host's starter plans
      and m.joined_at > h.last_seen_at
      and m.joined_at > coalesce(l.at, '-infinity'::timestamptz)
      and m.joined_at < now() - ${JOIN_GRACE_MIN + ' minutes'}::interval
      and m.joined_at > now() - interval '24 hours'      -- stale joins (e.g. from before this job existed) stay unsent
      and (l.at is null or l.at < now() - ${JOIN_WINDOW_HOURS + ' hours'}::interval)
      and not exists (select 1 from blocks b where (b.blocker_id = a.host_id and b.blocked_id = j.id) or (b.blocker_id = j.id and b.blocked_id = a.host_id))
    group by a.id, l.at`;
  for (const r of rows) {
    const joiners: Person[] = r.joiners.map((j: any) => ({ name: T.firstName(j.name), photoUrl: j.photo, sub: countryName(j.country) ?? undefined }));
    // "The batch after the previous email": two runs that see the same previous email share one key.
    const periodKey = `${r.id}:after:${r.lastAt ? new Date(r.lastAt).getTime() : 0}`;
    count(t, 'plan_joined', await deliver({ kind: 'plan_joined', userId: r.hostId, periodKey, ref: r.id, meta: { joiners: joiners.length },
      build: u => T.planJoined({ name: u.name, plan: { id: r.id, title: r.title, placeName: r.placeName }, joiners, total: r.total }) }));
  }
  return t;
}

// --- weekly digest -------------------------------------------------------------------------------
// Sent on Mondays from 09:00 India time, once per ISO week, to people with a trip in the next 60 days.
const IST_MS = 5.5 * 3600_000;
export function isoWeek(now: Date) {
  const d = new Date(now.getTime() + IST_MS);
  const day = (d.getUTCDay() + 6) % 7;                      // Monday = 0
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day + 3));
  const jan4 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thu.getTime() - jan4.getTime()) / 86400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
export const isDigestTime = (now: Date) => { const d = new Date(now.getTime() + IST_MS); return d.getUTCDay() === 1 && d.getUTCHours() >= 9; };

export async function weeklyDigest(t: Tally = {}, now = new Date()) {
  if (!isDigestTime(now)) return t;
  const week = isoWeek(now);
  const users = await sql`select distinct on (u.id) u.id, u.gender, t.id as trip_id, t.city, t.city_key, t.start_date, t.end_date
    from users u join trips t on t.user_id = u.id
    where u.deleted_at is null and u.banned_at is null and u.onboarded and u.email not like '%@demo.tablamigo'
      and t.end_date >= current_date and t.start_date <= current_date + 60
      and coalesce(u.email_prefs->>'digest', 'true') <> 'false' and coalesce(u.email_prefs->>'all', 'true') <> 'false'
      and not exists (select 1 from email_log l where l.kind = 'weekly_digest' and l.user_id = u.id and l.period_key = ${week} and ${settled})
    order by u.id, t.start_date`;
  for (const u of users) {
    const visible = sql`x.deleted_at is null and x.banned_at is null and (x.snoozed_until is null or x.snoozed_until <= now())
      and not exists (select 1 from blocks b where (b.blocker_id = ${u.id} and b.blocked_id = x.id) or (b.blocker_id = x.id and b.blocked_id = ${u.id}))`;
    const people = await sql`select distinct on (x.id) x.id, x.name, x.photo_url, x.home_country, date_part('year', age(x.birthdate))::int as age
      from trips o join users x on x.id = o.user_id
      where o.city_key = ${u.cityKey} and o.user_id <> ${u.id} and o.start_date <= ${u.endDate} and o.end_date >= ${u.startDate} and ${visible}`;
    const [{ plans }] = await sql`select count(*)::int as plans from activities a join users x on x.id = a.host_id
      where a.status = 'active' and not a.closed and lower(a.city) = lower(${u.city}) and a.host_id <> ${u.id}
        and a.starts_at > now() and a.starts_at < ${u.endDate}::date + 1
        and (not a.women_only or ${u.gender === 'woman'}) and ${visible}`;
    if (!people.length && !plans) continue;
    const faces: Person[] = [...people].sort((a, b) => Number(!a.photoUrl) - Number(!b.photoUrl)).slice(0, 3)
      .map(p => ({ name: T.firstName(p.name), photoUrl: p.photoUrl, sub: [p.age, countryName(p.homeCountry)].filter(Boolean).join(' · ') || undefined }));
    count(t, 'weekly_digest', await deliver({ kind: 'weekly_digest', userId: u.id, periodKey: week, ref: u.tripId, meta: { travelers: people.length, plans },
      build: x => T.weeklyDigest({ name: x.name, trip: { id: u.tripId, city: u.city, startDate: u.startDate, endDate: u.endDate }, travelers: people.length, plans, faces }) }));
  }
  return t;
}

/** Activation nudges, unless ACTIVATION_EMAILS is off; 'dry' logs the plan instead of sending. */
async function activation(t: Tally, now: Date) {
  if (config.activationEmails === 'off') return t;
  const dry = config.activationEmails === 'dry';
  const r = await runActivation(t, now, { dryRun: dry });
  if (dry && r.planned.length) console.log('activation dry run:', JSON.stringify(r.planned.map(p => ({ user: p.userId, kind: p.kind, ...p.detail }))), r.window ? '' : '(outside the send window: a real run would wait)');
  return t;
}

/** The owner's sale alerts whose send failed (email provider down) get another try (lib/owner-alerts.ts). Not customer email. */
async function ownerAlertRetries(t: Tally) {
  const n = await retryFailedOwnerAlerts();
  if (n) (t.owner_sale_alert ??= {}).sent = n;
  return t;
}

let running = false;
/** One pass over every time-based email. Overlapping calls in one process are skipped; across processes the email_log key holds. */
export async function runEmailJobs(now = new Date()) {
  if (running) return null;
  running = true;
  const t: Tally = {};
  try {
    for (const [name, job] of [['plus_started', plusStarted], ['payment', paymentProblems], ['lifecycle', (x: Tally) => plusLifecycle(x, now)], ['joins', planJoins], ['digest', (x: Tally) => weeklyDigest(x, now)], ['activation', (x: Tally) => activation(x, now)], ['trip_soon', async (x: Tally) => { const r = await tripSoon(now); if (r.sent) (x.trip_soon ??= {}).sent = r.sent; return x; }], ['owner_alerts', ownerAlertRetries]] as const) {
      await job(t).catch((e: Error) => console.error('email job failed', name, e.message));
    }
    return t;
  } finally { running = false; }
}
