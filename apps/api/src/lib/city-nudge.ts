/**
 * The empty-city nudge: 3 to 10 days before a trip, if nobody has posted a plan in that city (or within NUDGE_RADIUS_KM of the
 * trip's point) for the trip's dates, the traveller gets one DM from the Tablamigo Host suggesting they post the first one,
 * with one-tap templates (coffee, walk, food) that open the new-plan screen prefilled for the trip's first day and city. The
 * team never posts a plan on anyone's behalf here.
 *
 * Once per trip (city_nudges, claimed before sending) and at most one nudge per person per NUDGE_GAP_DAYS. Only real travellers
 * (lib/team-dm.ts), not snoozed, with plan alerts on, in their daytime (9:00-21:00 at the trip). A women-only plan counts only
 * for a woman, as only women can see it. The email follows only if the DM goes unread (lib/ladder.ts, 'city_nudge').
 *
 * CITY_NUDGE (config.cityNudge): 'off' | 'dry' (log only) | 'on'. The scheduler runs it every minute.
 */
import { sql } from './db.js';
import { config, type Mode } from './config.js';
import { clock } from './clock.js';
import { getHost } from './host.js';
import { firstName, fmtRange, fmtDate } from './emails/templates.js';
import type { Email } from './emails/layout.js';
import { instantAt, localDate, zoneAt } from './local-time.js';
import { realTraveller, inDaytime, zoneFor, appLink, postAsTeam, alertsOffUrl } from './team-dm.js';
import { recordInApp, registerFallback } from './ladder.js';

export const NUDGE_FROM_DAYS = 3, NUDGE_TO_DAYS = 10;
export const NUDGE_RADIUS_KM = 20;
export const NUDGE_GAP_DAYS = 7;

export type Template = { key: 'coffee' | 'walk' | 'food'; emoji: string; label: string; title: (city: string) => string; category: string };
export const TEMPLATES: Template[] = [
  { key: 'coffee', emoji: '☕', label: 'Coffee meetup', title: c => `Coffee meetup in ${c}`, category: 'drinks' },
  { key: 'walk', emoji: '🚶', label: 'Morning walk', title: c => `Morning walk in ${c}`, category: 'outdoors' },
  { key: 'food', emoji: '🍜', label: 'Food crawl', title: c => `Food crawl in ${c}`, category: 'food' },
];

/** The new-plan screen, prefilled (apps/mobile/src/app/activity/new.tsx reads title, emoji, category, date and near). */
export function templateLink(t: Template, city: string, date: string, point: { lat: number; lng: number } | null) {
  const q = new URLSearchParams({ title: t.title(city).slice(0, 80), emoji: t.emoji, category: t.category, date });
  if (point) q.set('near', `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`);
  return appLink(`/activity/new?${q.toString()}`);
}

export type NudgeText = { userId?: string; name: string | null; hinglish: boolean; city: string; startDate: string; endDate: string; point: { lat: number; lng: number } | null };

/** The DM. Pure. */
export function renderNudge(d: NudgeText): string {
  const when = fmtRange(d.startDate, d.endDate), start = fmtDate(d.startDate).replace(/ \d{4}$/, '');
  const links = TEMPLATES.map(t => `${t.emoji} ${t.label}: ${templateLink(t, d.city, d.startDate, d.point)}`).join('\n');
  return d.hinglish ? [
    `Hi ${firstName(d.name)} 👋 Aapki ${d.city} trip ${start} se shuru ho rahi hai. ${when} ke liye ${d.city} mein abhi koi plan nahi hai, toh pehla plan aapka ho sakta hai.`,
    `Ek tap mein shuru karo:\n${links}`,
    'Koi busy public jagah chuno. Aapki dates pe aane wale travellers ek tap mein join kar sakte hain.',
  ].join('\n\n') : [
    `Hi ${firstName(d.name)} 👋 Your ${d.city} trip starts ${start}. Nobody has posted a plan in ${d.city} for ${when} yet, so yours would be the first one travellers there see.`,
    `Start one in a tap:\n${links}`,
    'Pick a busy public place. Travellers on your dates can join with one tap.',
  ].join('\n\n');
}

/** The email (the ladder's fallback). Pure. */
export function cityNudgeEmail(d: NudgeText): Email {
  return {
    subject: `Be the first plan in ${d.city}`.slice(0, 70), category: 'activity',
    preheader: `No plans there for ${fmtRange(d.startDate, d.endDate)} yet. Start one in a tap.`,
    blocks: [
      { t: 'h1', text: `Nobody has posted a plan in ${d.city} yet` },
      { t: 'p', text: `Hi ${firstName(d.name)}, your trip is ${fmtRange(d.startDate, d.endDate)}. A first plan is what other travellers there look for. Pick one to start:` },
      { t: 'list', items: TEMPLATES.map(t => `[${t.emoji} ${t.label}](${templateLink(t, d.city, d.startDate, d.point)})`) },
      { t: 'small', text: `Choose a busy public place. ${d.userId ? `[Stop plan alerts](${alertsOffUrl(d.userId, 'plan')}) or switch` : 'Switch'} them off in Profile.` },
    ],
  };
}

/** Whether a city has a plan anyone on this trip could join, between the trip's first and last day (local). */
export async function hasPlans(trip: { city: string; lat: number | null; lng: number | null; startDate: string; endDate: string }, viewer: { id: string; gender: string | null }) {
  const zone = trip.lat != null && trip.lng != null ? zoneAt(trip.lat, trip.lng) : 'UTC';
  const [y1, m1, d1] = trip.startDate.split('-').map(Number), [y2, m2, d2] = trip.endDate.split('-').map(Number);
  const from = new Date(instantAt(zone, { y: y1, mo: m1, d: d1, h: 0, mi: 0, s: 0 }));
  const to = new Date(instantAt(zone, { y: y2, mo: m2, d: d2, h: 0, mi: 0, s: 0 }) + 86400_000);
  const point = trip.lat != null && trip.lng != null;
  const [r] = await sql`select exists (select 1 from activities a
      where a.status = 'active' and not a.closed and a.starts_at >= ${from} and a.starts_at < ${to}
        and (not a.women_only or ${viewer.gender === 'woman'})
        and not exists (select 1 from blocks b where (b.blocker_id = ${viewer.id} and b.blocked_id = a.host_id) or (b.blocker_id = a.host_id and b.blocked_id = ${viewer.id}))
        and ((${point} and st_dwithin(a.location, st_setsrid(st_makepoint(${trip.lng}::float8, ${trip.lat}::float8), 4326)::geography, ${NUDGE_RADIUS_KM * 1000}))
          or (a.city is not null and lower(a.city) = lower(${trip.city})))) as any`;
  return !!r.any;
}

const dryLogged = new Set<string>();
export type NudgeTally = { mode: Mode; sent: number; skipped: number; failed: number; waiting: number; planned: number };

export async function processCityNudges(now: Date = clock.now(), o: { mode?: Mode; dryLog?: Set<string> } = {}): Promise<NudgeTally> {
  const mode = o.mode ?? config.cityNudge;
  const t: NudgeTally = { mode, sent: 0, skipped: 0, failed: 0, waiting: 0, planned: 0 };
  if (mode === 'off') return t;
  // Candidates by UTC date with a day of slack each side; each trip's own local "today" decides below.
  const utc = now.toISOString().slice(0, 10);
  const trips = await sql`select t.id, t.user_id, t.city, t.city_key, t.start_date::text as start_date, t.end_date::text as end_date,
      st_y(t.location::geometry) as lat, st_x(t.location::geometry) as lng, u.name, u.gender, u.home_country
    from trips t join users u on u.id = t.user_id
    where t.start_date between ${utc}::date + ${NUDGE_FROM_DAYS - 1}::int and ${utc}::date + ${NUDGE_TO_DAYS + 1}::int
      and ${realTraveller('u')} and u.plan_alerts and (u.snoozed_until is null or u.snoozed_until <= now())
      and not exists (select 1 from city_nudges n where n.trip_id = t.id)
      and not exists (select 1 from city_nudges n where n.user_id = t.user_id and n.status = 'sent'
        and n.created_at > ${now}::timestamptz - ${NUDGE_GAP_DAYS + ' days'}::interval)
    order by t.start_date limit 500`;
  if (!trips.length) return t;
  const host = await getHost();
  const done = new Set<string>();
  for (const tr of trips) {
    if (done.has(tr.userId)) continue;
    const zone = zoneFor({ lat: tr.lat, lng: tr.lng, homeCountry: tr.homeCountry, cityKey: tr.cityKey });
    const today = localDate(now, zone);
    const daysOut = Math.round((Date.parse(tr.startDate) - Date.parse(today)) / 86400_000);
    if (daysOut < NUDGE_FROM_DAYS || daysOut > NUDGE_TO_DAYS) continue;
    if (!inDaytime(now, zone)) { t.waiting++; continue; }
    if (await hasPlans({ city: tr.city, lat: tr.lat, lng: tr.lng, startDate: tr.startDate, endDate: tr.endDate }, { id: tr.userId, gender: tr.gender })) continue;
    if (mode === 'dry') {
      const logged = o.dryLog ?? dryLogged;
      if (!logged.has(tr.id)) { logged.add(tr.id); console.log(`city nudge (dry): user=${tr.userId} trip=${tr.id} city=${tr.cityKey}`); t.planned++; }
      continue;
    }
    if (!host) { t.waiting++; continue; }
    const [claim] = await sql`insert into city_nudges (trip_id, user_id, created_at) values (${tr.id}, ${tr.userId}, ${now}) on conflict (trip_id) do nothing returning trip_id`;
    if (!claim) continue;
    done.add(tr.userId);
    const text: NudgeText = { userId: tr.userId, name: tr.name, hinglish: tr.homeCountry === 'IN', city: tr.city, startDate: tr.startDate, endDate: tr.endDate,
      point: tr.lat != null && tr.lng != null ? { lat: tr.lat, lng: tr.lng } : null };
    try {
      const dm = await postAsTeam(host, tr.userId, renderNudge(text));
      if (dm.status === 'sent') await recordInApp(tr.userId, 'city_nudge', tr.id, { chatId: dm.chatId, messageId: dm.messageId, payload: text });
      await sql`update city_nudges set status = ${dm.status === 'sent' ? 'sent' : 'skipped'}, reason = ${dm.status === 'declined' ? 'dm_declined' : null},
        chat_id = ${dm.chatId}, message_id = ${dm.status === 'sent' ? dm.messageId : null}, sent_at = now() where trip_id = ${tr.id}`;
      if (dm.status === 'sent') { t.sent++; console.log(`city nudge: sent to user=${tr.userId} trip=${tr.id} city=${tr.cityKey}`); } else t.skipped++;
    } catch (e) {
      const err = String((e as Error)?.message ?? e).slice(0, 300);
      await sql`update city_nudges set status = 'failed', reason = ${err} where trip_id = ${tr.id}`.catch(() => {});
      console.error('city nudge failed', tr.userId, err);
      t.failed++;
    }
  }
  return t;
}

// The ladder's email: only while the city is still empty for the trip (someone may have posted since).
registerFallback('city_nudge', {
  email: (p: NudgeText, u) => cityNudgeEmail({ ...p, name: u.name }),
  short: (p: NudgeText) => ({ title: `Be the first plan in ${p.city}`, body: `No plans there for ${fmtRange(p.startDate, p.endDate)} yet. Start one in a tap.`,
    url: templateLink(TEMPLATES[0], p.city, p.startDate, p.point) }),
  stillValid: async (userId, p: NudgeText) => {
    const [u] = await sql`select gender from users where id = ${userId}`;
    return !(await hasPlans({ city: p.city, lat: p.point?.lat ?? null, lng: p.point?.lng ?? null, startDate: p.startDate, endDate: p.endDate }, { id: userId, gender: u?.gender ?? null }));
  },
});
