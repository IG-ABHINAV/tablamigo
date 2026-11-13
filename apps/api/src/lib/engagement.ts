/**
 * Honest engagement loops. Each says something true and specific, is opt-out-able, rate-limited and quiet at night; none has
 * a streak, a countdown, a fake "people are waiting", or a guilt line.
 *
 *   plan views    "N people looked at your plan" to its host, at most once a day per plan, counting real people who opened the
 *                 plan and haven't joined (plan_views, written by GET /activities/:id; incognito and snoozed viewers are never
 *                 counted, as with profile views). In-app notice and push. Off with plan alerts (Profile).
 *   trip soon     an email 3 days before a trip to someone who hasn't opened the app for 3 days: how many people are there on
 *                 their dates and how many plans are posted, the real numbers (0 is said as 0). email_prefs 'reminders'.
 *   joins         already live: the host gets the join in the plan chat (push) and the batched plan_joined email.
 *   weekly digest already live (lib/emails/jobs.ts): trips in the next 60 days, Monday 09:00 IST, opt-out "digest".
 */
import { sql } from './db.js';
import { clock } from './clock.js';
import { config, type Mode } from './config.js';
import { addNotice } from './inbox.js';
import { notify } from './push.js';
import { deliver } from './emails/send.js';
import { firstName, fmtRange, appUrl } from './emails/templates.js';
import type { Email } from './emails/layout.js';
import { localDate } from './local-time.js';
import { realTraveller, inDaytime, zoneFor } from './team-dm.js';
import { recordInApp, registerFallback } from './ladder.js';
import { overlapping } from './trip-match.js';

export const VIEW_SUMMARY_MIN_VIEWS = 2;
export const VIEW_SUMMARY_GAP_H = 20;
export const TRIP_SOON_DAYS = 3;
export const AWAY_DAYS = 3;

/** Records a plan view: a real, visible person who isn't in the plan. Never throws. */
export async function recordPlanView(activityId: string, viewerId: string) {
  try {
    await sql`insert into plan_views (activity_id, viewer_id, viewed_at)
      select a.id, v.id, ${clock.now()}::timestamptz from activities a, users v
      where a.id = ${activityId} and v.id = ${viewerId} and a.host_id <> v.id and ${realTraveller('v')}
        and not coalesce(v.is_incognito, false) and (v.snoozed_until is null or v.snoozed_until <= now())
        and not exists (select 1 from activity_members m where m.activity_id = a.id and m.user_id = v.id)
        and not exists (select 1 from blocks b where (b.blocker_id = v.id and b.blocked_id = a.host_id) or (b.blocker_id = a.host_id and b.blocked_id = v.id))
      on conflict (activity_id, viewer_id) do nothing`;
  } catch (e) { console.error('plan view failed', (e as Error)?.message); }
}

export const planViewsText = (n: number, title: string) => `${n} ${n === 1 ? 'person' : 'people'} looked at your plan "${title}" since yesterday. A clear place and time helps them say yes.`;

/** One summary per plan per day to its host, in the host's daytime. */
export async function planViewSummaries(now: Date = clock.now(), o: { mode?: Mode } = {}) {
  let sent = 0;
  const mode = o.mode ?? config.engagement;
  if (mode === 'off') return { sent };
  const rows = await sql`
    select a.id, a.title, a.host_id, st_y(a.location::geometry) as lat, st_x(a.location::geometry) as lng, h.home_country,
      count(*)::int as views
    from plan_views v join activities a on a.id = v.activity_id join users h on h.id = a.host_id
    where a.status = 'active' and not a.closed and a.starts_at > ${now}
      and v.viewed_at > ${now}::timestamptz - interval '24 hours'
      and not exists (select 1 from activity_members m where m.activity_id = a.id and m.user_id = v.viewer_id)
      and ${realTraveller('h')} and h.plan_alerts
      and not exists (select 1 from notification_log l where l.user_id = a.host_id and l.kind = 'plan_views' and l.channel = 'inapp'
        and l.ref like a.id::text || ':%' and l.created_at > ${now}::timestamptz - ${VIEW_SUMMARY_GAP_H + ' hours'}::interval)
    group by a.id, h.id having count(*) >= ${VIEW_SUMMARY_MIN_VIEWS}
    order by min(v.viewed_at) limit 500`;
  for (const r of rows) {
    if (!inDaytime(now, zoneFor({ lat: r.lat, lng: r.lng, homeCountry: r.homeCountry }))) continue;
    if (mode === 'dry') { console.log(`plan views (dry): host=${r.hostId} plan=${r.id} views=${r.views}`); continue; }
    const ref = `${r.id}:${localDate(now, 'UTC')}`;
    const payload = { activityId: r.id, title: r.title, views: r.views };
    // The claim (one summary per plan per day) is the in-app row itself, with what the escalation needs.
    const [fresh] = await sql`insert into notification_log (user_id, kind, ref, channel, status, payload, created_at)
      values (${r.hostId}, 'plan_views', ${ref}, 'inapp', 'sent', ${sql.json(payload)}, ${now})
      on conflict do nothing returning id`;
    if (!fresh) continue;
    const body = planViewsText(r.views, r.title);
    await addNotice([r.hostId], { kind: 'plan_views', activityId: r.id, body });
    const [notice] = await sql`select id from notifications where user_id = ${r.hostId} and kind = 'plan_views' and activity_id = ${r.id} order by created_at desc limit 1`;
    if (notice) await sql`update notification_log set payload = payload || ${sql.json({ noticeId: notice.id })} where id = ${fresh.id}`;
    await recordInApp(r.hostId, 'plan_views', ref, { payload });
    void notify([r.hostId], { title: 'Your plan is getting looks', body, data: { activityId: r.id, nkind: 'plan_views', nref: ref }, tag: `plan-views-${r.id}` });
    sent++;
  }
  return { sent };
}

export function tripSoonEmail(d: { name: string | null; trip: { id: string; city: string; startDate: string; endDate: string }; travellers: number; plans: number }): Email {
  const { city } = d.trip, t = d.travellers, p = d.plans;
  const facts = [
    t === 0 ? 'Nobody else has added it on your dates yet.' : `${t} other ${t === 1 ? 'traveller is' : 'travellers are'} there on your dates.`,
    p === 0 ? `No plans are posted in ${city} for your dates yet: the first one could be yours.` : `${p} ${p === 1 ? 'plan is' : 'plans are'} posted in ${city} for your dates.`,
  ];
  return {
    subject: `${city} in ${TRIP_SOON_DAYS} days`, category: 'reminders',
    preheader: facts[0],
    blocks: [
      { t: 'eyebrow', text: `Your trip · ${fmtRange(d.trip.startDate, d.trip.endDate)}` },
      { t: 'h1', text: `${city} in ${TRIP_SOON_DAYS} days` },
      { t: 'p', text: `Hi ${firstName(d.name)}, a quick look before you go. ${facts.join(' ')}` },
      { t: 'button', label: 'Open your trip', url: appUrl(`/trip/${d.trip.id}`) },
      { t: 'small', text: 'One email per trip, only if you haven\'t opened Tablamigo for a few days. Turn trip reminders off with the link below.' },
    ],
  };
}

/** The email jobs' pass: trips starting in TRIP_SOON_DAYS (the trip's own calendar) for people away from the app. */
export async function tripSoon(now: Date = clock.now(), o: { mode?: Mode } = {}) {
  let sent = 0;
  const mode = o.mode ?? config.engagement;
  if (mode === 'off') return { sent };
  const utc = now.toISOString().slice(0, 10);
  const rows = await sql`select t.id, t.user_id, t.city, t.city_key, t.start_date::text as start_date, t.end_date::text as end_date,
      st_y(t.location::geometry) as lat, st_x(t.location::geometry) as lng, u.home_country, u.gender
    from trips t join users u on u.id = t.user_id
    where t.start_date between ${utc}::date + ${TRIP_SOON_DAYS - 1}::int and ${utc}::date + ${TRIP_SOON_DAYS + 1}::int
      and ${realTraveller('u')} and u.last_seen_at < ${now}::timestamptz - ${AWAY_DAYS + ' days'}::interval
      and not exists (select 1 from email_log l where l.kind = 'trip_soon' and l.user_id = u.id and l.period_key = t.id::text)
    order by t.start_date limit 500`;
  for (const r of rows) {
    const zone = zoneFor({ lat: r.lat, lng: r.lng, homeCountry: r.homeCountry, cityKey: r.cityKey });
    const days = Math.round((Date.parse(r.startDate) - Date.parse(localDate(now, zone))) / 86400_000);
    if (days !== TRIP_SOON_DAYS || !inDaytime(now, zone)) continue;
    if (mode === 'dry') { console.log(`trip soon (dry): user=${r.userId} trip=${r.id}`); continue; }
    const travellers = (await overlapping(r.userId, r.cityKey, r.startDate, r.endDate)).length;
    const [{ plans }] = await sql`select count(*)::int as plans from activities a
      where a.status = 'active' and not a.closed and a.starts_at >= ${r.startDate}::date and a.starts_at < ${r.endDate}::date + 1
        and (not a.women_only or ${r.gender === 'woman'}) and a.host_id <> ${r.userId}
        and ((${r.lat != null} and st_dwithin(a.location, st_setsrid(st_makepoint(${r.lng ?? 0}::float8, ${r.lat ?? 0}::float8), 4326)::geography, 20000))
          or lower(a.city) = lower(${r.city}))`;
    const out = await deliver({ kind: 'trip_soon', userId: r.userId, periodKey: r.id, ref: r.id, meta: { travellers, plans },
      build: u => tripSoonEmail({ name: u.name, trip: { id: r.id, city: r.city, startDate: r.startDate, endDate: r.endDate }, travellers, plans }) });
    if (out === 'sent') sent++;
  }
  return { sent };
}

// Digest-type: unread the next day, one email (or the next channel) with the same numbers.
registerFallback('plan_views', {
  email: (p, u): Email => ({
    subject: `${p.views} people looked at ${p.title}`.slice(0, 70), category: 'activity', preheader: 'A clear place and time helps them say yes.',
    blocks: [
      { t: 'h1', text: `Your plan is getting looks` },
      { t: 'p', text: `Hi ${firstName(u.name)}, ${planViewsText(p.views, p.title)}` },
      { t: 'button', label: 'Open your plan', url: appUrl(`/activity/${p.activityId}`) },
      { t: 'small', text: 'At most one of these a day. Plan alerts can be switched off in Profile.' },
    ],
  }),
  short: p => ({ title: 'Your plan is getting looks', body: planViewsText(p.views, p.title), url: appUrl(`/activity/${p.activityId}`) }),
  stillValid: async (_u, p) => (await sql`select 1 from activities where id = ${p.activityId} and status = 'active' and starts_at > ${clock.now()}`).length > 0,
});
