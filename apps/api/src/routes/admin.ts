/**
 * Admin panel API (apps/web/src/admin.html). Every route is behind requireAdmin: users.role = 'admin'
 * or an email in ADMIN_EMAILS. The verification queue itself lives in routes/verify.ts.
 *
 * The panel signs in through /admin/auth/start and /admin/auth/verify, never the app's /auth/email/*:
 * a code is only ever emailed to an admin, and the answer is the same whatever the address.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireAdmin, isAdmin } from '../lib/admin.js';
import { issueTokens, newLoginCode, storeLoginCode, checkLoginCode, consumeLoginCode, signImpersonation, IMPERSONATION_TTL_SEC } from '../lib/auth.js';
import { sendLoginCode } from '../lib/mail.js';
import { config } from '../lib/config.js';
import { recomputePlus, grantLaunchPlus } from '../lib/play.js';
import { clearBillingDispute } from '../lib/billing-disputes.js';
import { RAZORPAY_PRICES, PERIODS, PERIOD_MONTHS, type Period } from '../lib/razorpay.js';
import { addNotice } from '../lib/inbox.js';
import { emitToChat, disconnectUser } from '../lib/realtime.js';
import { announceCancelled } from '../lib/plans.js';
import { bad, forbidden, notFound } from '../lib/errors.js';
import { runAiEngagement } from '../lib/ai-engagement.js';
import { playOfferLabel } from '../lib/play-offers.js';
import { getHost, hostChats, hostStats, hostDmOther, hostChatMessages, replyAsHost, previewWelcome } from '../lib/host.js';
import { starterPlansList } from '../lib/starter-plans.js';
import { createHostPlan, HOST_PLAN_CATEGORIES } from '../lib/host-plans.js';
import { searchPlaces, cityFor } from '../lib/geo.js';
import { instantAt, zoneAt } from '../lib/local-time.js';


const TZ = 'Asia/Kolkata';
/** Users-list filters the Overview's numbers link to. Each counts what the Overview counts: people (not the Host team account). */
const DRILL_FILTERS = ['people', 'onboarded', 'verified', 'signup_today', 'signup_7d', 'signup_30d', 'active_1d', 'active_7d', 'active_30d'] as const;
/** Signup counts on the Overview include accounts deleted since, so these lists do too (each row shows its Deleted badge). */
const SIGNUP_FILTERS = new Set<string>(['signup_today', 'signup_7d', 'signup_30d']);
/** The acquisition sources sign-up records (routes/auth.ts parseAttribution); anything else came from a utm_source and is
 *  "other". An account with no attribution shows as Direct in the admin, so it filters as Direct too. */
export const ATTRIBUTION_SOURCES = ['Google Play', 'Google Search', 'LinkedIn', 'Meta / Instagram', 'Reddit', 'Direct'] as const;

/** "12 min", "3 h", "4 days": how long an account lived. */
export function lifespan(from: Date | string, to: Date | string): string {
  const min = Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60_000));
  if (min < 90) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} days`;
}

/** The suggested action on a deleted account's journey: what its short or long life says about the product. */
export function deletedAdvice(created: Date | string, deleted: Date | string, onboarded: boolean): string {
  const life = lifespan(created, deleted);
  const hours = (new Date(deleted).getTime() - new Date(created).getTime()) / 3600_000;
  if (hours < 24) return `Deleted after ${life}${onboarded ? ', right after finishing onboarding' : ', before finishing onboarding'}: check the onboarding drop-off and what the first screens showed them.`;
  if (hours < 24 * 14) return `Deleted after ${life}: an early churn. Check whether they found anyone or any plan in their city.`;
  return `Deleted after ${life}. Nothing to do for this person; the account is anonymised.`;
}   // the founder's day boundaries for "today" and the daily chart
const LIVE = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'];
const uuidOrNull = (col: any) => sql`case when ${col} ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (${col})::uuid end`;
const bigOrNull = (col: any) => sql`case when ${col} ~ '^[0-9]{1,18}$' then (${col})::bigint end`;

/**
 * Which purchase plus_until came from (recomputePlus takes the greatest, so one of them equals it). A pass redeemed
 * from the Trip Pass wallet (purchase_token 'wallet:...') was not bought, so it is 'wallet', not 'pass'.
 */
const plusSource = sql`case when u.plus_until is null or u.plus_until <= now() then null
  when exists(select 1 from passes p where p.user_id = u.id and p.voided_at is null and p.expires_at = u.plus_until and p.purchase_token not like 'wallet:%') then 'pass'
  when exists(select 1 from passes p where p.user_id = u.id and p.voided_at is null and p.expires_at = u.plus_until and p.purchase_token like 'wallet:%') then 'wallet'
  when exists(select 1 from subscriptions s where s.user_id = u.id and s.platform = 'google' and s.status in ${sql(LIVE)} and s.expires_at = u.plus_until) then 'google'
  when exists(select 1 from subscriptions s where s.user_id = u.id and s.platform = 'razorpay' and s.status in ${sql(LIVE)} and s.expires_at = u.plus_until) then 'razorpay'
  when u.comp_until = u.plus_until then 'comp' else 'other' end`;

/** The user a report is about: the reported user, the plan's host, the message's sender or the author of a moment, comment, tip or circle idea. */
const reportOwner = sql`coalesce(
  (select x.id from users x where r.target_type = 'user' and x.id = ${uuidOrNull(sql`r.target_id`)}),
  (select a.host_id from activities a where r.target_type = 'activity' and a.id = ${uuidOrNull(sql`r.target_id`)}),
  (select m.sender_id from messages m where r.target_type = 'message' and m.id = ${bigOrNull(sql`r.target_id`)}),
  (select m.user_id from moments m where r.target_type = 'moment' and m.id = ${uuidOrNull(sql`r.target_id`)}),
  (select c.user_id from moment_comments c where r.target_type = 'moment_comment' and c.id = ${uuidOrNull(sql`r.target_id`)}),
  (select c.user_id from activity_comments c where r.target_type = 'plan_comment' and c.id = ${uuidOrNull(sql`r.target_id`)}),
  (select t.user_id from city_tips t where r.target_type = 'city_tip' and t.id = ${uuidOrNull(sql`r.target_id`)}),
  (select p.proposer_id from trip_circle_proposals p where r.target_type = 'circle_proposal' and p.id = ${uuidOrNull(sql`r.target_id`)}))`;

const tokenRef = (t: string) => t.startsWith('rzp:') ? t.slice(4) : t.slice(0, 14) + '…';
const passPlatform = (t: string) => t.startsWith('rzp:') ? 'razorpay' : t.startsWith('wallet:') ? 'wallet' : 'google';

/** Only what the database knows. Razorpay pass payments are stored with their amount; subscription money is an estimate. */
async function revenue() {
  const [passes] = await sql`select count(*)::int as count, coalesce(sum((raw->>'amount')::bigint), 0)::bigint as amount,
      count(*) filter (where created_at > now() - interval '30 days')::int as count30,
      coalesce(sum((raw->>'amount')::bigint) filter (where created_at > now() - interval '30 days'), 0)::bigint as amount30,
      count(*) filter (where voided_at is not null)::int as refunded
    from passes where purchase_token like 'rzp:%'`;
  const [paidPasses] = await sql`select coalesce(sum((raw->>'amount')::bigint), 0)::bigint as amount from passes where purchase_token like 'rzp:%' and voided_at is null`;
  const subs = await sql`select replace(coalesce(raw->'notes'->>'product', ''), 'tablamigo_plus_', '') as period,
      count(*) filter (where status in ${sql(LIVE)} and expires_at > now())::int as active,
      count(*) filter (where status in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') and cancel_requested_at is null and expires_at > now())::int as renewing,
      coalesce(sum(coalesce((raw->>'paid_count')::int, 0)), 0)::int as paid
    from subscriptions where platform = 'razorpay' group by 1`;
  const price = (p: string) => PERIODS.includes(p as Period) ? RAZORPAY_PRICES[p as Period] : 0;
  const bySub = Object.fromEntries(subs.map(s => [s.period || 'unknown', { active: s.active, renewing: s.renewing, paidCycles: s.paid, estCollected: s.paid * price(s.period) }]));
  const mrr = subs.reduce((n, s) => n + s.renewing * (PERIODS.includes(s.period as Period) ? price(s.period) / PERIOD_MONTHS[s.period as Period] : 0), 0);
  const [google] = await sql`select
      (select count(*)::int from subscriptions where platform = 'google' and status in ${sql(LIVE)} and expires_at > now()) as subs,
      (select count(*)::int from passes where purchase_token not like 'rzp:%' and purchase_token not like 'wallet:%' and voided_at is null) as passes`;
  return {
    currency: RAZORPAY_PRICES.currency,
    prices: { monthly: RAZORPAY_PRICES.monthly, halfyearly: RAZORPAY_PRICES.halfyearly, yearly: RAZORPAY_PRICES.yearly, pass: RAZORPAY_PRICES.pass },
    // Recorded: the captured Razorpay payment objects stored with each web Trip Pass (minor units, paise).
    recorded: { razorpayPasses: { count: passes.count, grossAmount: Number(passes.amount), netOfRefunds: Number(paidPasses.amount), count30: passes.count30, amount30: Number(passes.amount30), refunded: passes.refunded } },
    // Estimated: Razorpay stores no amount on a subscription, so plan price × paid cycles and × renewing subs.
    estimated: { razorpaySubs: bySub, mrr: Math.round(mrr), collected: Object.values(bySub).reduce((n: number, s: any) => n + s.estCollected, 0) },
    // Google Play purchases carry no price we store; see Play Console for money.
    google: { activeSubs: google.subs, passes: google.passes, amountsStored: false },
  };
}

/** Who may sign in to the panel: an ADMIN_EMAILS address or a role = 'admin' account, never a banned one. */
async function adminEligible(email: string) {
  const [u] = await sql`select role, banned_at, deleted_at, account_kind from users where email = ${email}`;
  if (u?.bannedAt || u?.accountKind === 'team') return false;   // the Tablamigo Host: role 'admin', never an admin (lib/admin.ts)
  if (config.adminEmails.includes(email)) return true;
  return !!u && !u.deletedAt && u.role === 'admin';
}

export default async function admin(app: FastifyInstance) {
  // Same body and status for every address, so it can't be used to find out who the admins are. The code
  // email is not awaited for the same reason (a send failure is logged, not returned), and a used-up
  // hourly allowance is a silent no-op instead of the app's 429.
  app.post('/admin/auth/start', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async req => {
    const { email } = z.object({ email: z.string().email().max(200) }).parse(req.body);
    const e = email.toLowerCase();
    if (await adminEligible(e)) {
      const code = newLoginCode();
      if ((await storeLoginCode(e, code)).result === 'stored') void sendLoginCode(e, code).catch(err => req.log.error(err, 'admin sign-in code email failed'));
    }
    return { ok: true };
  });

  // Never creates an account for a non-admin. A valid code that belongs to a non-admin (asked for in the
  // app) reads as a wrong code here and is left unused for the app.
  app.post('/admin/auth/verify', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async req => {
    const { email, code } = z.object({ email: z.string().email().max(200), code: z.string().regex(/^\d{6}$/) }).parse(req.body);
    const e = email.toLowerCase();
    await checkLoginCode(e, code);
    if (!(await adminEligible(e))) throw bad('wrong_code');
    await consumeLoginCode(e);
    let [user] = await sql`select id from users where email = ${e} and deleted_at is null`;
    // Only an ADMIN_EMAILS address can get here without an account (role = 'admin' needs one).
    if (!user) {
      [user] = await sql`insert into users (email) values (${e}) returning id`;
      await grantLaunchPlus(user.id).catch(err => req.log.error(err, 'launch plus grant failed'));   // every way of creating an account gets the launch offer
    }
    return issueTokens(user.id);
  });

  app.get('/admin/me', async req => {
    const id = await requireAdmin(req);
    const [u] = await sql`select id, email, name, role from users where id = ${id}`;
    return u;
  });

  app.get('/admin/overview', async req => {
    await requireAdmin(req);
    const [u] = await sql`select
        count(*) filter (where deleted_at is null)::int as total,
        count(*) filter (where deleted_at is null and onboarded)::int as onboarded,
        count(*) filter (where deleted_at is null and verified)::int as verified,
        count(*) filter (where deleted_at is null and banned_at is not null)::int as banned,
        count(*) filter (where deleted_at is not null)::int as deleted,
        count(*) filter (where (created_at at time zone ${TZ})::date = (now() at time zone ${TZ})::date)::int as today,
        count(*) filter (where created_at > now() - interval '7 days')::int as d7,
        count(*) filter (where created_at > now() - interval '30 days')::int as d30,
        count(*) filter (where deleted_at is null and last_seen_at > now() - interval '1 day')::int as dau,
        count(*) filter (where deleted_at is null and last_seen_at > now() - interval '7 days')::int as wau,
        count(*) filter (where deleted_at is null and last_seen_at > now() - interval '30 days')::int as mau
      from users where account_kind = 'person'`;   // people only, not the Tablamigo Host team account
    const daily = await sql`select to_char(d, 'YYYY-MM-DD') as day, count(u.id)::int as signups
      from generate_series((now() at time zone ${TZ})::date - 29, (now() at time zone ${TZ})::date, interval '1 day') d
      left join users u on (u.created_at at time zone ${TZ})::date = d::date and u.account_kind = 'person'
      group by d order by d`;
    const plus = await sql`select ${plusSource} as source, count(*)::int as n from users u where u.deleted_at is null and u.plus_until > now() group by 1`;
    const [q] = await sql`select
        (select count(*)::int from reports where status = 'open') as open_reports,
        (select count(*)::int from verification_requests where status = 'pending') as pending_verifications,
        -- People's plans: the Host's community starter plans are counted on the Host tab instead.
        (select count(*)::int from activities a join users h on h.id = a.host_id where h.account_kind = 'person' and a.status = 'active' and a.starts_at > now() - interval '2 hours') as upcoming_plans,
        (select count(*)::int from activities a join users h on h.id = a.host_id where h.account_kind = 'person' and a.created_at > now() - interval '7 days') as plans7,
        (select count(*)::int from trips t join users tu on tu.id = t.user_id where t.end_date >= current_date and tu.deleted_at is null) as upcoming_trips,
        (select count(*)::int from email_log where status = 'sent' and sent_at > now() - interval '7 days') as emails7`;
    return {
      users: u, daily,
      activity: { dau: u.dau, wau: u.wau, mau: u.mau, source: 'users.last_seen_at (bumped on every signed-in request; no history is kept)' },
      plus: { total: plus.reduce((n, r) => n + r.n, 0), ...Object.fromEntries(plus.map(r => [r.source, r.n])) },
      queues: q,
      revenue: await revenue(),
    };
  });

  app.get('/admin/revenue', async req => { await requireAdmin(req); return revenue(); });

  app.get('/admin/users', async req => {
    await requireAdmin(req);
    const f = z.object({
      q: z.string().trim().max(100).optional(),
      filter: z.enum(['all', 'plus', 'comp', 'banned', 'deleted', 'unverified', 'pending', 'reported', 'admin', ...DRILL_FILTERS]).default('all'),
      plus: z.enum(['google', 'razorpay', 'pass', 'wallet', 'comp', 'other']).optional(),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // Filtered here, not on the page: a filter over one page of 50 showed "1–0 of 26" and hid matches on later pages.
      source: z.enum([...ATTRIBUTION_SOURCES, 'other']).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0),
    }).parse(req.query);
    const src = sql`coalesce(nullif(u.attribution->>'source', ''), 'Direct')`;
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    const where = sql`where (${like}::text is null or u.email ilike ${like} or u.name ilike ${like} or u.city ilike ${like} or u.id::text = ${f.q ?? ''})
      and ${f.filter === 'deleted' ? sql`u.deleted_at is not null` : SIGNUP_FILTERS.has(f.filter) || f.day ? sql`true` : sql`u.deleted_at is null`}
      ${(DRILL_FILTERS as readonly string[]).includes(f.filter) || f.day ? sql`and u.account_kind = 'person'` : sql``}
      ${f.filter === 'onboarded' ? sql`and u.onboarded` : sql``}
      ${f.filter === 'verified' ? sql`and u.verified` : sql``}
      ${f.filter === 'signup_today' ? sql`and (u.created_at at time zone ${TZ})::date = (now() at time zone ${TZ})::date` : sql``}
      ${f.filter === 'signup_7d' ? sql`and u.created_at > now() - interval '7 days'` : sql``}
      ${f.filter === 'signup_30d' ? sql`and u.created_at > now() - interval '30 days'` : sql``}
      ${f.filter === 'active_1d' ? sql`and u.last_seen_at > now() - interval '1 day'` : sql``}
      ${f.filter === 'active_7d' ? sql`and u.last_seen_at > now() - interval '7 days'` : sql``}
      ${f.filter === 'active_30d' ? sql`and u.last_seen_at > now() - interval '30 days'` : sql``}
      ${f.day ? sql`and (u.created_at at time zone ${TZ})::date = ${f.day}::date` : sql``}
      ${f.plus ? sql`and u.plus_until > now() and ${plusSource} = ${f.plus}` : sql``}
      ${f.filter === 'plus' ? sql`and u.plus_until > now()` : sql``}
      ${f.filter === 'comp' ? sql`and u.comp_until > now()` : sql``}
      ${f.filter === 'banned' ? sql`and u.banned_at is not null` : sql``}
      ${f.filter === 'unverified' ? sql`and not u.verified` : sql``}
      ${f.filter === 'pending' ? sql`and exists(select 1 from verification_requests v where v.user_id = u.id and v.status = 'pending')` : sql``}
      ${f.filter === 'reported' ? sql`and coalesce(rc.open, 0) > 0` : sql``}
      ${f.filter === 'admin' ? sql`and u.role = 'admin'` : sql``}
      ${f.source === 'other' ? sql`and ${src} not in ${sql(ATTRIBUTION_SOURCES as unknown as string[])}` : f.source ? sql`and ${src} = ${f.source}` : sql``}`;
    const rc = sql`left join (select owner_id, count(*)::int as total, count(*) filter (where status = 'open')::int as open
      from (select r.status, ${reportOwner} as owner_id from reports r) x where owner_id is not null group by owner_id) rc on rc.owner_id = u.id`;
    const [{ total }] = await sql`select count(*)::int as total from users u ${rc} ${where}`;
    const users = await sql`select u.id, u.email, u.name, u.photo_url, u.city, u.home_country, u.gender, u.role, u.verified, u.onboarded,
        u.created_at, u.last_seen_at, u.plus_until, u.comp_until, u.banned_at, u.deleted_at, u.attribution, u.heard_from,
        date_part('year', age(u.birthdate))::int as age, ${plusSource} as plus_source,
        (select v.status from verification_requests v where v.user_id = u.id order by v.created_at desc limit 1) as verification,
        coalesce(rc.total, 0) as reports, coalesce(rc.open, 0) as open_reports
      from users u ${rc} ${where}
      order by u.created_at desc limit ${f.limit} offset ${f.offset}`;
    return { total, users };
  });

  app.get('/admin/users/:id', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [user] = await sql`select u.id, u.email, u.name, u.photo_url, u.bio, u.city, u.home_country, u.gender, u.role, u.verified, u.onboarded,
        u.languages, u.interests, u.created_at, u.last_seen_at, u.location_at, u.plus_until, u.comp_until, u.billing_disputed_at, u.billing_dispute_ref, u.banned_at, u.deleted_at, u.email_prefs, u.attribution, u.heard_from, u.heard_from_at,
        date_part('year', age(u.birthdate))::int as age, ${plusSource} as plus_source,
        (select count(*)::int from activities a where a.host_id = u.id) as hosted,
        (select count(*)::int from activity_members m where m.user_id = u.id) as joined,
        (select count(*)::int from vouches v where v.vouched_id = u.id) as vouches
      from users u where u.id = ${id}`;

    if (!user) throw notFound();
    const [subscriptions, passes, reports, trips, emails] = await Promise.all([
      sql`select purchase_token, platform, product_id, status, expires_at, updated_at, cancel_requested_at, offer_id from subscriptions where user_id = ${id} order by updated_at desc`,
      sql`select purchase_token, product_id, order_id, expires_at, voided_at, created_at, (raw->>'amount')::int as amount from passes where user_id = ${id} order by created_at desc`,
      sql`select r.id, r.target_type, r.reason, r.details, r.status, r.created_at, rep.name as reporter_name
        from reports r left join users rep on rep.id = r.reporter_id where ${reportOwner} = ${id} order by r.created_at desc limit 50`,
      sql`select id, city, country_code, start_date, end_date from trips where user_id = ${id} order by start_date desc limit 20`,
      sql`select id, kind, subject, status, created_at from email_log where user_id = ${id} order by created_at desc limit 20`,
    ]);
    return { user, subscriptions: subscriptions.map(s => ({ ...s, offer: playOfferLabel(s.offerId, config.playYearlyTrialOfferId), offerId: undefined, purchaseToken: tokenRef(s.purchaseToken) })), passes: passes.map(p => ({ ...p, purchaseToken: tokenRef(p.purchaseToken) })), reports, trips, emails };
  });

  // Hand-granted Plus. plus_until is derived, so this sets comp_until and lets recomputePlus decide.
  app.post('/admin/users/:id/comp', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { days } = z.object({ days: z.number().int().min(1).max(3650) }).parse(req.body);
    const [u] = await sql`update users set comp_until = now() + ${days + ' days'}::interval where id = ${id} and deleted_at is null returning id`;
    if (!u) throw notFound();
    await recomputePlus(id);
    const [r] = await sql`select comp_until, plus_until from users where id = ${id}`;
    return { ok: true, ...r };
  });

  app.delete('/admin/users/:id/comp', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [u] = await sql`update users set comp_until = null where id = ${id} returning id`;
    if (!u) throw notFound();
    await recomputePlus(id);
    const [r] = await sql`select comp_until, plus_until from users where id = ${id}`;
    return { ok: true, ...r };
  });

  // A chargeback locked this account's web purchases (lib/billing-disputes.ts). Clearing lets it buy again and brings back
  // Plus from comps and passes; subscriptions the dispute ended stay ended (SC-14/15: winning never restores by itself).
  app.post('/admin/users/:id/billing-dispute/clear', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!(await clearBillingDispute(id))) throw notFound();
    const [r] = await sql`select billing_disputed_at, plus_until from users where id = ${id}`;
    return { ok: true, ...r };
  });

  // Ban: requireUser refuses them (403), sign-in refuses them, every feed hides them, their upcoming plans are cancelled.
  app.post('/admin/users/:id/ban', async req => {
    const adminId = await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (id === adminId) throw bad('cannot_ban_self');
    const [t] = await sql`select role, email from users where id = ${id}`;
    if (!t) throw notFound();
    if (isAdmin(t)) throw forbidden('cannot_ban_admin');   // role = 'admin' or an ADMIN_EMAILS address
    const cancelled = await sql.begin(async tx => {
      await tx`update users set banned_at = coalesce(banned_at, now()) where id = ${id}`;
      const plans = await tx`update activities set status = 'cancelled' where host_id = ${id} and status = 'active' and starts_at > now() returning id`;
      await tx`update refresh_tokens set revoked_at = now() where user_id = ${id} and revoked_at is null`;
      return plans.map(p => p.id as string);
    });
    disconnectUser(id);   // open sockets would keep delivering every chat the banned user is in
    await announceCancelled(cancelled, 'This plan was removed by the Tablamigo team.', t => `${t} was removed by the Tablamigo team`);
    return { ok: true };
  });

  app.post('/admin/users/:id/unban', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [u] = await sql`update users set banned_at = null where id = ${id} returning id`;
    if (!u) throw notFound();
    return { ok: true };
  });

  // User Impersonation ("Login as User")
  app.post('/admin/users/:id/impersonate', async req => {
    const adminId = await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [target] = await sql`select id, email, name, role, account_kind, deleted_at from users where id = ${id}`;
    if (!target) throw notFound();
    // A deleted account is an anonymised tombstone: there is no one to look at, and the app would refuse its token anyway.
    if (target.deletedAt) throw forbidden('deleted_account', 'This account was deleted.');
    // The Tablamigo Host is not onboarded (the app would open onboarding) and is answered from the Host inbox below.
    if (target.accountKind === 'team') throw forbidden('team_account', 'Reply as the Tablamigo Host from the Host inbox instead.');

    // Read-only, 15 minutes, no refresh token (lib/auth.ts signImpersonation): it can't write as the person or outlive the look.
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${adminId}, 'admin_impersonate', ${sql.json({ targetUserId: id, targetEmail: target.email })})`.catch(() => {});

    return {
      ok: true,
      accessToken: signImpersonation(id, adminId),
      expiresIn: IMPERSONATION_TTL_SEC,
      readOnly: true,
      targetUser: { id: target.id, email: target.email, name: target.name }
    };
  });

  // Comprehensive User Journey & Activity Timeline
  app.get('/admin/users/:id/journey', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [user] = await sql`select id, email, name, city, home_country, created_at, last_seen_at, onboarded, verified, attribution, deleted_at, banned_at from users where id = ${id}`;
    if (!user) throw notFound();

    const [events, hostedPlans, joinedPlans, messages, trips, emails, verifications] = await Promise.all([
      sql`select id, event_name, properties, created_at from analytics_events where user_id = ${id} order by created_at asc limit 100`,
      sql`select id, title, category, place_name, city, starts_at, status, created_at from activities where host_id = ${id} order by created_at asc limit 50`,
      sql`select m.activity_id, m.joined_at as created_at, a.title, a.city, a.category from activity_members m join activities a on a.id = m.activity_id where m.user_id = ${id} and a.host_id != ${id} order by m.joined_at asc limit 50`,
      sql`select m.id, m.chat_id, m.kind, m.body, m.created_at, c.kind as chat_kind, c.title as chat_title from messages m join chats c on c.id = m.chat_id where m.sender_id = ${id} order by m.created_at asc limit 50`,
      sql`select id, city, country_code, start_date, end_date, created_at from trips where user_id = ${id} order by created_at asc limit 30`,
      sql`select id, kind, subject, status, created_at from email_log where user_id = ${id} order by created_at asc limit 50`,
      sql`select id, status, reason, scores, created_at from verification_requests where user_id = ${id} order by created_at asc limit 20`,
    ]);

    type TimelineItem = {
      id: string;
      time: string;
      type: string;
      title: string;
      subtitle?: string;
      badge?: string;
      icon: string;
      data?: any;
    };

    const items: TimelineItem[] = [];

    // 1. Initial Signup & Attribution Milestone
    const attr = (user.attribution as any) || {};
    const srcDesc = attr.source ? `${attr.source}${attr.medium ? ` · ${attr.medium}` : ''}` : 'Direct';
    items.push({
      id: `signup-${user.id}`,
      time: user.createdAt,
      type: 'signup',
      title: `Account Created via ${srcDesc}`,
      subtitle: [attr.device, attr.city || user.city, attr.country || user.homeCountry].filter(Boolean).join(' · ') || 'New sign-up',
      icon: '🚀',
      badge: 'Signup',
      data: attr,
    });

    for (const ev of events) {
      if (ev.eventName === 'signup') continue;
      if (ev.eventName === 'onboarding_complete') {
        items.push({
          id: `onboarding-${ev.id}`,
          time: ev.createdAt,
          type: 'onboarding',
          title: 'Completed Profile Onboarding',
          subtitle: `${user.name || 'User'} setup photos, interests & bio`,
          icon: '👤',
          badge: 'Profile',
        });
      } else {
        items.push({
          id: `event-${ev.id}`,
          time: ev.createdAt,
          type: 'event',
          title: `Action: ${ev.eventName.replace(/_/g, ' ')}`,
          subtitle: JSON.stringify(ev.properties || {}).slice(0, 100),
          icon: '⚡',
          badge: 'Event',
          data: ev.properties,
        });
      }
    }

    for (const p of hostedPlans) {
      items.push({
        id: `plan-host-${p.id}`,
        time: p.createdAt,
        type: 'plan_hosted',
        title: `Posted Plan: "${p.title}"`,
        subtitle: `${p.city || ''} · ${p.placeName || ''} (${p.category}) · Status: ${p.status}`,
        icon: '🗓️',
        badge: 'Host',
        data: p,
      });
    }

    for (const j of joinedPlans) {
      items.push({
        id: `plan-join-${j.activityId}`,
        time: j.createdAt,
        type: 'plan_joined',
        title: `Joined Plan: "${j.title}"`,
        subtitle: `${j.city || ''} (${j.category})`,
        icon: '🤝',
        badge: 'Joined',
      });
    }

    for (const m of messages) {
      items.push({
        id: `msg-${m.id}`,
        time: m.createdAt,
        type: 'message',
        title: `Sent Chat Message in "${m.chatTitle || m.chatKind}"`,
        subtitle: `"${m.body.slice(0, 120)}"`,
        icon: '💬',
        badge: m.chatKind,
      });
    }

    for (const t of trips) {
      items.push({
        id: `trip-${t.id}`,
        time: t.createdAt,
        type: 'trip',
        title: `Planned Trip to ${t.city}, ${t.countryCode}`,
        subtitle: `${t.startDate} → ${t.endDate}`,
        icon: '✈️',
        badge: 'Trip',
      });
    }

    for (const e of emails) {
      items.push({
        id: `email-${e.id}`,
        time: e.createdAt,
        type: 'email',
        title: `Email: ${e.subject || e.kind}`,
        subtitle: `Status: ${e.status} (${e.kind})`,
        icon: '✉️',
        badge: e.status,
      });
    }

    for (const v of verifications) {
      items.push({
        id: `verif-${v.id}`,
        time: v.createdAt,
        type: 'verification',
        title: `Identity Verification: ${v.status}`,
        subtitle: v.reason ? `Reason: ${v.reason}` : 'Automated selfie check',
        icon: v.status === 'approved' ? '✅' : '❌',
        badge: v.status,
      });
    }

    if (user.deletedAt) {
      items.push({ id: `deleted-${user.id}`, time: user.deletedAt, type: 'deleted', title: 'Deleted their account',
        subtitle: `${lifespan(user.createdAt, user.deletedAt)} after signing up. Their activity was anonymised, so only emails remain here.`, icon: '🗑️', badge: 'Deleted' });
    }
    items.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());

    let dropoffStage = 'Active';
    let recommendation = 'User is engaged and healthy.';
    if (user.deletedAt) {
      dropoffStage = 'Deleted';
      recommendation = deletedAdvice(user.createdAt, user.deletedAt, user.onboarded);
    } else if (user.bannedAt) {
      dropoffStage = 'Banned';
      recommendation = 'Banned: nothing to do unless the ban is appealed.';
    } else if (!user.onboarded) {
      dropoffStage = 'Dropped off during Onboarding';
      recommendation = 'Send nudge email: "Finish your profile to connect with travelers in your destination".';
    } else if (hostedPlans.length > 0 && joinedPlans.length === 0 && messages.length === 0) {
      dropoffStage = 'Waiting for table companions';
      recommendation = 'AI Persona / travelers in that city should join the table so host does not feel abandoned.';
    } else if (messages.length > 0 && hostedPlans.length === 0 && joinedPlans.length === 0) {
      dropoffStage = 'Sent chat message, awaiting response';
      recommendation = 'Reply in destination chat immediately to keep conversation flowing.';
    } else if (user.lastSeenAt && new Date().getTime() - new Date(user.lastSeenAt).getTime() > 3 * 86400_000) {
      dropoffStage = 'Inactive for > 3 days';
      recommendation = 'Send weekly travel digest with top plans in their home country / destination.';
    }

    return {
      user: { id: user.id, name: user.name, email: user.email, attribution: user.attribution, lastSeenAt: user.lastSeenAt, deletedAt: user.deletedAt },
      summary: {
        totalEvents: items.length,
        firstActive: user.createdAt,
        lastActive: user.lastSeenAt || user.createdAt,
        dropoffStage,
        recommendation,
      },
      timeline: items,
    };
  });

  // Manual trigger for AI engagement loop
  app.post('/admin/ai-engagement/run', async req => {
    await requireAdmin(req);
    return runAiEngagement();
  });


  // --- The Tablamigo Host (lib/host.ts): its DMs, replies from the team, the welcome preview, and the starter plans ---------
  const theHost = async () => { const h = await getHost(); if (!h) throw notFound('no_host'); return h; };

  app.get('/admin/host/chats', async req => {
    await requireAdmin(req);
    const host = await theHost();
    return { host, modes: { hostWelcome: config.hostWelcome, starterPlans: config.starterPlans }, stats: await hostStats(host.id), chats: await hostChats(host.id) };
  });

  app.get('/admin/host/chats/:id/messages', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const host = await theHost();
    const other = await hostDmOther(host.id, id);
    if (!other) throw notFound();
    return { other, messages: await hostChatMessages(host.id, id) };
  });

  // A reply from the team, sent as the Host. Not to someone who declined the request, blocked the Host (or was blocked by it),
  // or whose account is gone: the message would never reach them. The admin who wrote it is recorded.
  app.post('/admin/host/chats/:id/messages', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const adminId = await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const host = await theHost();
    const other = await hostDmOther(host.id, id);
    if (!other) throw notFound();
    if (other.requestStatus === 'declined') throw bad('request_declined', 'They declined the Host\'s message request.');
    const [gone] = await sql`select 1 from users where id = ${other.userId} and (deleted_at is not null or banned_at is not null)`;
    if (gone) throw bad('user_gone', 'That account is deleted or banned.');
    const [blocked] = await sql`select 1 from blocks where (blocker_id = ${other.userId} and blocked_id = ${host.id}) or (blocker_id = ${host.id} and blocked_id = ${other.userId})`;
    if (blocked) throw forbidden('blocked');
    const msg = await replyAsHost(host.id, id, body);
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${adminId}, 'admin_host_reply', ${sql.json({ chatId: id, messageId: msg.id, toUserId: other.userId })})`.catch(() => {});
    return msg;
  });

  // The exact welcome a user would get now, in any mode, and whether they are due one.
  app.get('/admin/host/preview', async req => {
    await requireAdmin(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.query);
    const p = await previewWelcome(userId);
    if (!p) throw notFound();
    return p;
  });

  // Create plan as Tablamigo team: place search for the form (Photon, the app's own place search), then the plan itself, listed as the
  // Host through lib/host-plans.ts (the service the starter-plans worker uses). Admin only; the admin who made it is recorded.
  app.get('/admin/host/places', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    await requireAdmin(req);
    const q = z.object({ q: z.string().trim().min(2).max(120), lat: z.coerce.number().min(-90).max(90).optional(), lng: z.coerce.number().min(-180).max(180).optional() }).parse(req.query);
    return { places: await searchPlaces(q.q, q.lat != null && q.lng != null ? { lat: q.lat, lng: q.lng } : null) };
  });

  app.post('/admin/host/plans', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const adminId = await requireAdmin(req);
    const b = z.object({
      title: z.string().trim().min(3).max(80),
      emoji: z.string().trim().min(1).max(8).default('☕'),
      category: z.enum(HOST_PLAN_CATEGORIES),
      description: z.string().trim().min(10).max(600),
      placeName: z.string().trim().min(2).max(120),
      lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
      city: z.string().trim().min(2).max(80).optional(),
      // Either an exact instant, or the wall-clock time at the venue ('2026-11-14T16:00'), read in the venue's own time zone.
      startsAt: z.string().datetime().optional(),
      localAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).optional(),
      maxPeople: z.number().int().min(2).max(50).optional(),
    }).strict().refine(x => (x.startsAt == null) !== (x.localAt == null), { message: 'Give startsAt or localAt, not both', path: ['startsAt'] }).parse(req.body);
    const startsAt = b.startsAt ? new Date(b.startsAt) : (() => {
      const [d, t] = b.localAt!.split('T'), [y, mo, dd] = d.split('-').map(Number), [h, mi] = t.split(':').map(Number);
      if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || h > 23 || mi > 59 || new Date(Date.UTC(y, mo - 1, dd)).getUTCDate() !== dd) throw bad('bad_time', 'That date or time does not exist.');
      return new Date(instantAt(zoneAt(b.lat, b.lng), { y, mo, d: dd, h, mi, s: 0 }));
    })();
    const city = b.city ?? (await cityFor(b.lat, b.lng)).city;
    if (!city) throw bad('no_city', 'Could not work out the city for that point: pass the city.');
    const made = await createHostPlan({ title: b.title, emoji: b.emoji, category: b.category, description: b.description, placeName: b.placeName,
      lat: b.lat, lng: b.lng, city, startsAt, maxPeople: b.maxPeople ?? null });
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${adminId}, 'admin_host_plan_create', ${sql.json({ activityId: made.id, chatId: made.chatId, city, placeName: b.placeName, startsAt: startsAt.toISOString(), title: b.title })})`.catch(e => console.error('admin_host_plan_create audit failed', (e as Error).message));
    return { id: made.id, chatId: made.chatId, city, startsAt: startsAt.toISOString() };
  });

  app.get('/admin/starter-plans', async req => {
    await requireAdmin(req);
    return { mode: config.starterPlans, plans: await starterPlansList(new Date(Date.now() - 7 * 86400_000)) };
  });

  app.get('/admin/plans', async req => {
    await requireAdmin(req);
    const f = z.object({
      q: z.string().trim().max(100).optional(),
      status: z.enum(['active', 'cancelled', 'all']).default('active'),
      when: z.enum(['upcoming', 'past', 'all']).default('upcoming'),
      created: z.enum(['7d', '30d']).optional(),
      host: z.enum(['people', 'all']).default('all'),
    }).parse(req.query);
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    const plans = await sql`select a.id, a.title, a.emoji, a.category, a.city, a.place_name, a.starts_at, a.status, a.closed, a.women_only, a.max_people, a.created_at,
        h.id as host_id, h.name as host_name, h.email as host_email, h.banned_at as host_banned_at,
        (select count(*)::int from activity_members m where m.activity_id = a.id) as going,
        (select count(*)::int from reports r where r.target_type = 'activity' and r.target_id = a.id::text) as reports
      from activities a join users h on h.id = a.host_id
      where (${like}::text is null or a.title ilike ${like} or a.city ilike ${like} or a.place_name ilike ${like} or h.name ilike ${like} or h.email ilike ${like})
        ${f.status === 'all' ? sql`` : sql`and a.status = ${f.status}`}
        ${f.when === 'upcoming' ? sql`and a.starts_at > now() - interval '2 hours'` : f.when === 'past' ? sql`and a.starts_at <= now() - interval '2 hours'` : sql``}
        ${f.created ? sql`and a.created_at > now() - ${f.created === '7d' ? '7 days' : '30 days'}::interval` : sql``}
        ${f.host === 'people' ? sql`and h.account_kind = 'person'` : sql``}
      order by ${f.created ? sql`a.created_at desc` : f.when === 'upcoming' ? sql`a.starts_at asc` : sql`a.starts_at desc`} limit 300`;
    return { plans };
  });

  // One plan, for the plan drawer: who hosts it, who is in it, and any reports on it.
  app.get('/admin/plans/:id', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [plan] = await sql`select a.id, a.title, a.emoji, a.category, a.description, a.city, a.place_name, a.place_address, a.starts_at, a.status,
        a.closed, a.women_only, a.max_people, a.created_at, h.id as host_id, h.name as host_name, h.email as host_email, h.photo_url as host_photo,
        h.account_kind as host_kind, h.deleted_at as host_deleted_at, h.banned_at as host_banned_at
      from activities a join users h on h.id = a.host_id where a.id = ${id}`;
    if (!plan) throw notFound();
    const [members, reports] = await Promise.all([
      sql`select u.id, u.name, u.email, u.photo_url, u.account_kind, u.deleted_at, m.rsvp_status, m.joined_at, m.checked_in_at
        from activity_members m join users u on u.id = m.user_id where m.activity_id = ${id} order by m.joined_at`,
      sql`select r.id, r.reason, r.details, r.status, r.created_at, r.reporter_id, rep.name as reporter_name, rep.email as reporter_email
        from reports r left join users rep on rep.id = r.reporter_id where r.target_type = 'activity' and r.target_id = ${id} order by r.created_at desc`,
    ]);
    return { plan, members, reports };
  });

  // Trips (the Overview's "Upcoming trips" drills down here). Deleted accounts' trips are removed with the account.
  app.get('/admin/trips', async req => {
    await requireAdmin(req);
    const f = z.object({ q: z.string().trim().max(100).optional(), when: z.enum(['upcoming', 'past', 'all']).default('upcoming') }).parse(req.query);
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    const trips = await sql`select t.id, t.city, t.country_code, t.city_key, t.start_date, t.end_date, t.created_at,
        u.id as user_id, u.name, u.email, u.photo_url, u.account_kind, u.banned_at,
        (select count(*)::int from trips o join users ou on ou.id = o.user_id
          where o.city_key = t.city_key and o.user_id <> t.user_id and o.start_date <= t.end_date and o.end_date >= t.start_date
            and ou.deleted_at is null and ou.banned_at is null and ou.account_kind = 'person') as overlaps
      from trips t join users u on u.id = t.user_id
      where u.deleted_at is null
        and (${like}::text is null or t.city ilike ${like} or u.name ilike ${like} or u.email ilike ${like})
        ${f.when === 'upcoming' ? sql`and t.end_date >= current_date` : f.when === 'past' ? sql`and t.end_date < current_date` : sql``}
      order by ${f.when === 'past' ? sql`t.start_date desc` : sql`t.start_date asc`} limit 300`;
    return { trips };
  });

  app.post('/admin/plans/:id/cancel', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [a] = await sql`update activities set status = 'cancelled' where id = ${id} and status = 'active' returning id, title`;
    if (!a) throw notFound();
    const [c] = await sql`select id from chats where activity_id = ${id}`;
    if (c) {
      const [msg] = await sql`insert into messages (chat_id, kind, body) values (${c.id}, 'system', 'This plan was removed by the Tablamigo team.') returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${c.id}`;
      emitToChat(c.id, 'message:new', msg);
    }
    const members = await sql`select user_id from activity_members where activity_id = ${id}`;
    await addNotice(members.map(m => m.userId), { kind: 'cancelled', activityId: id, chatId: c?.id, body: `${a.title} was removed by the Tablamigo team` });
    return { ok: true };
  });

  app.get('/admin/reports', async req => {
    await requireAdmin(req);
    const { status } = z.object({ status: z.enum(['open', 'actioned', 'dismissed', 'all']).default('open') }).parse(req.query);
    const reports = await sql`select x.*, tu.name as target_user_name, tu.email as target_user_email, tu.photo_url as target_user_photo, tu.banned_at as target_banned_at,
        (select count(*)::int from reports r2 where r2.status = 'open' and r2.id <> x.id and (r2.target_id = x.target_id)) as same_target_open
      from (select r.id, r.target_type, r.target_id, r.reason, r.details, r.status, r.created_at, r.reporter_id,
          rep.name as reporter_name, rep.email as reporter_email, ${reportOwner} as target_user_id,
          (select a.title from activities a where r.target_type = 'activity' and a.id = ${uuidOrNull(sql`r.target_id`)}) as activity_title,
          -- Only the message a report is about, and only here: an admin can read the reported text to judge the report. A message its
          -- sender (or their account's deletion) removed is still shown, marked as deleted, so nobody mistakes it for live content.
          (select m.body from messages m where r.target_type = 'message' and m.id = ${bigOrNull(sql`r.target_id`)}) as message_body,
          (select m.deleted_at is not null from messages m where r.target_type = 'message' and m.id = ${bigOrNull(sql`r.target_id`)}) as message_deleted,
          (select m.deleted_at from messages m where r.target_type = 'message' and m.id = ${bigOrNull(sql`r.target_id`)}) as message_deleted_at
        from reports r left join users rep on rep.id = r.reporter_id
        where ${status === 'all' ? sql`true` : sql`r.status = ${status}`}
        order by r.created_at desc limit 300) x
      left join users tu on tu.id = x.target_user_id
      order by x.created_at desc`;
    return { reports };
  });

  for (const [action, status] of [['resolve', 'actioned'], ['dismiss', 'dismissed'], ['reopen', 'open']] as const) {
    app.post(`/admin/reports/:id/${action}`, async req => {
      await requireAdmin(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const [r] = await sql`update reports set status = ${status} where id = ${id} returning id, status`;
      if (!r) throw notFound();
      return { ok: true, status: r.status };
    });
  }

  app.get('/admin/subscriptions', async req => {
    await requireAdmin(req);
    const [subs, passes, comps] = await Promise.all([
      sql`select s.purchase_token, s.platform, s.product_id, s.status, s.expires_at, s.updated_at, s.cancel_requested_at,
          coalesce(s.raw->'notes'->>'product', s.raw->'lineItems'->0->'offerDetails'->>'basePlanId') as plan, s.offer_id,
          u.id as user_id, u.email, u.name
        from subscriptions s join users u on u.id = s.user_id order by s.updated_at desc limit 300`,
      sql`select p.purchase_token, p.product_id, p.order_id, p.expires_at, p.voided_at, p.created_at,
          (p.raw->>'amount')::int as amount, p.raw->>'currency' as currency, u.id as user_id, u.email, u.name
        from passes p join users u on u.id = p.user_id order by p.created_at desc limit 300`,
      sql`select id as user_id, email, name, comp_until, plus_until from users where comp_until > now() and deleted_at is null order by comp_until desc limit 300`,
    ]);
    return {
      // offer: the Play intro offer it was bought with, in words (lib/play-offers.ts), or null for the base plan.
      subscriptions: subs.map(s => ({ ...s, offer: playOfferLabel(s.offerId, config.playYearlyTrialOfferId), offerId: undefined, ref: tokenRef(s.purchaseToken), purchaseToken: undefined })),
      // Wallet redemptions are rows in passes too, but nobody paid for them: labelled 'wallet', never a purchase.
      passes: passes.map(p => ({ ...p, ref: tokenRef(p.purchaseToken), platform: passPlatform(p.purchaseToken), purchase: !p.purchaseToken.startsWith('wallet:'), purchaseToken: undefined })),
      comps,
    };
  });

  app.get('/admin/emails', async req => {
    await requireAdmin(req);
    const f = z.object({ kind: z.string().max(40).optional(), status: z.enum(['pending', 'sent', 'failed', 'skipped']).optional(), q: z.string().trim().max(100).optional(),
      days: z.coerce.number().int().min(1).max(90).optional() }).parse(req.query);
    const like = f.q ? `%${f.q.replace(/[\\%_]/g, m => '\\' + m)}%` : null;
    const [emails, kinds] = await Promise.all([
      // Sign-in codes are logged before the account exists (user_id null): the recipient's account, if there is one now, is linked by address.
      sql`select e.id, e.kind, coalesce(e.user_id, (select u.id from users u where u.email = e.to_email limit 1)) as user_id,
          e.to_email, e.subject, e.status, e.attempts, e.error, e.created_at, e.sent_at from email_log e
        where (${f.kind ?? null}::text is null or e.kind = ${f.kind ?? null}) and (${f.status ?? null}::text is null or e.status = ${f.status ?? null})
          and (${like}::text is null or e.to_email ilike ${like} or e.subject ilike ${like})
          ${f.days ? sql`and coalesce(e.sent_at, e.created_at) > now() - ${f.days + ' days'}::interval` : sql``}
        order by e.created_at desc limit 300`,
      sql`select kind, count(*) filter (where status = 'sent' and sent_at > now() - interval '7 days')::int as sent7,
          count(*) filter (where status = 'sent' and sent_at > now() - interval '30 days')::int as sent30,
          count(*) filter (where status = 'failed')::int as failed
        from email_log group by kind order by kind`,
    ]);
    return { emails, kinds };
  });

  app.get('/admin/analytics', async req => {
    await requireAdmin(req);
    const summary = await sql`
      select event_name as "eventName",
        count(*)::int as total,
        count(*) filter (where created_at > now() - interval '24 hours')::int as "last24h",
        count(*) filter (where created_at > now() - interval '7 days')::int as "last7d"
      from analytics_events
      group by event_name
      order by total desc`;
    return { ok: true, summary };
  });

  // Feature 33: Product Activation Funnel Analytics & Realtime Cohort Retention Tracker
  // (signup -> onboarding_complete -> first_action -> first_join -> first_meetup)
  app.get('/admin/analytics/funnel', async req => {
    await requireAdmin(req);
    const { days = 30 } = z.object({
      days: z.coerce.number().int().min(0).max(3650).default(30),
    }).parse(req.query ?? {});

    const timeFilter = days > 0
      ? sql`and u.created_at >= now() - (${days} || ' days')::interval`
      : sql``;

    // 1. Funnel Stages aggregation
    const [counts] = await sql`
      with cohort_users as (
        select
          u.id,
          u.created_at,
          u.onboarded,
          exists (
            select 1 from activities a where a.host_id = u.id
            union all
            select 1 from trips t where t.user_id = u.id
            union all
            select 1 from messages m where m.sender_id = u.id
            union all
            select 1 from analytics_events e where e.user_id = u.id and e.event_name in ('plan_created', 'trip_created', 'message_sent', 'first_action')
          ) as has_first_action,
          exists (
            select 1 from activity_members am where am.user_id = u.id
            union all
            select 1 from analytics_events e where e.user_id = u.id and e.event_name in ('plan_joined')
          ) as has_joined_plan,
          exists (
            select 1 from activity_members am where am.user_id = u.id and am.checked_in_at is not null
            union all
            select 1 from analytics_events e where e.user_id = u.id and e.event_name in ('plan_checked_in')
          ) as has_met_up
        from users u
        where u.deleted_at is null and u.account_kind = 'person' ${timeFilter}
      )
      select
        count(*)::int as "totalSignups",
        count(*) filter (where onboarded)::int as "totalOnboarded",
        count(*) filter (where has_first_action)::int as "totalFirstAction",
        count(*) filter (where has_joined_plan)::int as "totalJoinedPlan",
        count(*) filter (where has_met_up)::int as "totalMetUp"
      from cohort_users
    `;

    // "How did you hear about us?" (onboarding, lib/heard-from.ts) for the same people: how many said each answer and how far
    // they got. 'not_asked' is everyone who signed up before the step existed or left onboarding before it.
    const heardFrom = await sql`
      select coalesce(u.heard_from, 'not_asked') as source, count(*)::int as signups,
        count(*) filter (where u.onboarded)::int as onboarded,
        count(*) filter (where exists (select 1 from activity_members am where am.user_id = u.id))::int as "joinedPlan",
        count(*) filter (where exists (select 1 from activity_members am where am.user_id = u.id and am.checked_in_at is not null))::int as "metUp"
      from users u
      where u.deleted_at is null and u.account_kind = 'person' ${timeFilter}
      group by 1 order by signups desc, source`;

    const signups = counts?.totalSignups ?? 0;
    const onboarded = counts?.totalOnboarded ?? 0;
    const firstAction = counts?.totalFirstAction ?? 0;
    const joinedPlan = counts?.totalJoinedPlan ?? 0;
    const metUp = counts?.totalMetUp ?? 0;

    const pct = (num: number, den: number) => den > 0 ? Math.round((num / den) * 1000) / 10 : 0;

    const stages = [
      {
        stage: 'signups',
        name: 'Account Created',
        count: signups,
        conversionFromPrevious: 100,
        conversionFromSignup: 100,
        dropoffRate: 0,
      },
      {
        stage: 'onboarding_complete',
        name: 'Onboarding Completed',
        count: onboarded,
        conversionFromPrevious: pct(onboarded, signups),
        conversionFromSignup: pct(onboarded, signups),
        dropoffRate: pct(Math.max(0, signups - onboarded), signups),
      },
      {
        stage: 'first_action',
        name: 'First Intent / Action (Plan/Trip/DM)',
        count: firstAction,
        conversionFromPrevious: pct(firstAction, onboarded),
        conversionFromSignup: pct(firstAction, signups),
        dropoffRate: pct(Math.max(0, onboarded - firstAction), onboarded),
      },
      {
        stage: 'plan_joined',
        name: 'First Plan Joined',
        count: joinedPlan,
        conversionFromPrevious: pct(joinedPlan, firstAction),
        conversionFromSignup: pct(joinedPlan, signups),
        dropoffRate: pct(Math.max(0, firstAction - joinedPlan), firstAction),
      },
      {
        stage: 'first_meetup',
        name: 'First Real-World Meetup (Checked In)',
        count: metUp,
        conversionFromPrevious: pct(metUp, joinedPlan),
        conversionFromSignup: pct(metUp, signups),
        dropoffRate: pct(Math.max(0, joinedPlan - metUp), joinedPlan),
      },
    ];

    // 2. Weekly Cohort Breakdown
    const cohorts = await sql`
      with cohort_users as (
        select
          u.id,
          u.created_at,
          u.onboarded,
          exists (
            select 1 from activities a where a.host_id = u.id
            union all
            select 1 from trips t where t.user_id = u.id
            union all
            select 1 from messages m where m.sender_id = u.id
            union all
            select 1 from analytics_events e where e.user_id = u.id and e.event_name in ('plan_created', 'trip_created', 'message_sent', 'first_action')
          ) as has_first_action,
          exists (
            select 1 from activity_members am where am.user_id = u.id
            union all
            select 1 from analytics_events e where e.user_id = u.id and e.event_name in ('plan_joined')
          ) as has_joined_plan,
          exists (
            select 1 from activity_members am where am.user_id = u.id and am.checked_in_at is not null
            union all
            select 1 from analytics_events e where e.user_id = u.id and e.event_name in ('plan_checked_in')
          ) as has_met_up
        from users u
        where u.deleted_at is null and u.account_kind = 'person' ${timeFilter}
      )
      select
        to_char(date_trunc('week', created_at), 'YYYY-MM-DD') as "cohortWeek",
        count(*)::int as signups,
        count(*) filter (where onboarded)::int as onboarded,
        count(*) filter (where has_first_action)::int as "firstAction",
        count(*) filter (where has_joined_plan)::int as "joinedPlan",
        count(*) filter (where has_met_up)::int as "metUp"
      from cohort_users
      group by date_trunc('week', created_at)
      order by date_trunc('week', created_at) desc
      limit 12
    `;

    const cohortList = cohorts.map(c => ({
      ...c,
      onboardingPct: pct(c.onboarded, c.signups),
      firstActionPct: pct(c.firstAction, c.signups),
      joinedPlanPct: pct(c.joinedPlan, c.signups),
      metUpPct: pct(c.metUp, c.signups),
    }));

    // 3. Velocity / Time to Activate (hours from signup to first join & meetup)
    const [velocity] = await sql`
      with user_first_join as (
        select am.user_id, min(am.joined_at) as first_joined_at
        from activity_members am
        group by am.user_id
      ),
      user_first_checkin as (
        select am.user_id, min(am.checked_in_at) as first_checked_in_at
        from activity_members am
        where am.checked_in_at is not null
        group by am.user_id
      )
      select
        coalesce(round(avg(extract(epoch from (j.first_joined_at - u.created_at)) / 3600)::numeric, 1), 0)::float as "avgHoursToJoin",
        coalesce(round(avg(extract(epoch from (c.first_checked_in_at - u.created_at)) / 3600)::numeric, 1), 0)::float as "avgHoursToMeet"
      from users u
      left join user_first_join j on j.user_id = u.id
      left join user_first_checkin c on c.user_id = u.id
      where u.deleted_at is null and u.account_kind = 'person' ${timeFilter}
    `;

    return {
      ok: true,
      timeWindowDays: days,
      summary: {
        totalSignups: signups,
        activationRate: pct(metUp, signups),
        onboardingRate: pct(onboarded, signups),
        avgHoursToJoin: velocity?.avgHoursToJoin ?? 0,
        avgHoursToMeet: velocity?.avgHoursToMeet ?? 0,
      },
      stages,
      heardFrom,
      cohorts: cohortList,
    };
  });
}
