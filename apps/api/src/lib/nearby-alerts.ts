/**
 * Explore's empty state (12 Nov 2026): 19 of 22 new people from 2 to 12 Nov had no plan within 50 km, and 11 of the 14 who did
 * nothing left within 5 minutes of an empty map. Two things here:
 *
 * 1. nearestPlanCities: when nothing is within NEARBY_KM, the nearest cities that have upcoming plans, with the distance to the
 *    nearest plan in each and how many plans each has (GET /activities `nearestCities`). Same rules as the plan list: active,
 *    starting from 2 hours ago to 14 days ahead, closed only for members, women-only plans only for women, never a deleted or
 *    banned host, nobody on either side of a block.
 *
 * 2. "Notify me when someone near me posts" (users.nearby_plan_alerts, off unless switched on): when a plan is posted, everyone
 *    with the switch on whose saved location is within NEARBY_KM of it hears about it once: a push now (notification_log kind
 *    'nearby_plan', ref = the plan id), and through the email ladder (lib/ladder.ts) when they have no push token or never
 *    open it. At most NEARBY_ALERTS_PER_DAY a person per rolling 24 hours. Never for the host, a plan they couldn't see
 *    (women-only, a block), a snoozed or non-real account, or a plan hosted by an account that isn't a real person or the
 *    team account (lib/team-dm.ts realTraveller).
 */
import { sql } from './db.js';
import { clock } from './clock.js';
import { notify } from './push.js';
import { recordInApp, registerFallback } from './ladder.js';
import { realTraveller, alertsOffUrl } from './team-dm.js';
import { appUrl, firstName } from './emails/templates.js';
import type { Email } from './emails/layout.js';

export const NEARBY_KM = 50;
export const NEAREST_CITIES = 5;
export const NEARBY_ALERTS_PER_DAY = 2;

export type PlanCity = { city: string; distanceKm: number; plans: number; activityId: string };

/**
 * Up to NEAREST_CITIES cities with upcoming plans `uid` may see, nearest first, or null when a plan is within NEARBY_KM (the
 * list itself then has something to show). Plans without a city are left out.
 */
export async function nearestPlanCities(uid: string, lat: number, lng: number): Promise<PlanCity[] | null> {
  const here = sql`ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography`;
  const rows = await sql`
    with v as (
      select a.id, a.city, ST_Distance(a.location, ${here}) as d
      from activities a join users h on h.id = a.host_id
      where a.status = 'active'
        and (not a.closed or exists (select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${uid}))
        and a.starts_at between now() - interval '2 hours' and now() + interval '14 days'
        and (not a.women_only or exists (select 1 from users me where me.id = ${uid} and me.gender = 'woman'))
        and h.deleted_at is null and h.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = a.host_id) or (b.blocker_id = a.host_id and b.blocked_id = ${uid})))
    select exists (select 1 from v where d <= ${NEARBY_KM * 1000}) as near,
      coalesce((select json_agg(c order by c."distanceKm") from (
        select city, round(min(d) / 1000)::int as "distanceKm", count(*)::int as plans,
          (array_agg(id order by d))[1] as "activityId"
        from v where city is not null and city <> '' group by city order by min(d) limit ${NEAREST_CITIES}) c), '[]') as cities`;
  return rows[0].near ? null : rows[0].cities as PlanCity[];
}

export type NearbyPayload = { activityId: string; title: string; emoji: string | null; placeName: string; city: string | null; distanceKm: number };

export const nearbyPushText = (p: NearbyPayload) => ({
  title: `New plan near you: ${p.emoji ? `${p.emoji} ` : ''}${p.title}`.slice(0, 90),
  body: `${p.placeName}${p.city && p.city !== p.placeName ? `, ${p.city}` : ''} · ${p.distanceKm} km away. Tap to see who's going.`,
});

/** The email fallback. Pure. */
export function nearbyPlanEmail(p: NearbyPayload, u: { name: string | null }, userId?: string): Email {
  const where = p.city ?? p.placeName;
  return {
    subject: `New plan near you: ${p.title}`.slice(0, 70), category: 'activity',
    preheader: `${p.placeName}, ${p.distanceKm} km from you. You asked to hear about plans nearby.`,
    blocks: [
      { t: 'eyebrow', text: `Near you · ${where}` },
      { t: 'h1', text: `${p.emoji ? `${p.emoji} ` : ''}${p.title}` },
      { t: 'p', text: `Hi ${firstName(u.name)}, someone just posted a plan at ${p.placeName}, ${p.distanceKm} km from you. Join it, or say hi in its chat.` },
      { t: 'button', label: 'See the plan', url: appUrl(`/activity/${p.activityId}`) },
      { t: 'small', text: `You switched on "Notify me when someone near me posts". At most ${NEARBY_ALERTS_PER_DAY} a day.${userId ? ` [Stop these alerts](${alertsOffUrl(userId, 'nearby')})` : ' Switch it off on Explore or in Profile.'}` },
    ],
  };
}

/**
 * Tells the people near a newly posted plan who asked for it. Returns how many were told. Never throws (it runs after the plan
 * is saved). Idempotent per (person, plan): the in-app row is the claim.
 */
export async function alertNearbyPlan(activityId: string, now: Date = clock.now()): Promise<number> {
  try {
    const rows = await sql`
      select u.id as user_id, a.title, a.emoji, a.place_name, a.city, round(ST_Distance(u.location, a.location) / 1000)::int as distance_km
      from activities a join users h on h.id = a.host_id
      join users u on u.nearby_plan_alerts and u.location is not null and u.id <> a.host_id
        and ST_DWithin(u.location, a.location, ${NEARBY_KM * 1000})
      where a.id = ${activityId} and a.status = 'active' and not a.closed and a.starts_at > ${now}
        and (${realTraveller('h')} or h.account_kind = 'team')
        and ${realTraveller('u')} and (u.snoozed_until is null or u.snoozed_until <= ${now})
        and (not a.women_only or u.gender = 'woman')
        and not exists (select 1 from blocks b where (b.blocker_id = u.id and b.blocked_id = h.id) or (b.blocker_id = h.id and b.blocked_id = u.id))
        and not exists (select 1 from notification_log l where l.user_id = u.id and l.kind = 'nearby_plan' and l.ref = ${activityId} and l.channel = 'inapp')
        and (select count(*) from notification_log l where l.user_id = u.id and l.kind = 'nearby_plan' and l.channel = 'inapp'
          and l.created_at > ${now}::timestamptz - interval '24 hours') < ${NEARBY_ALERTS_PER_DAY}
      order by distance_km limit 500`;
    let told = 0;
    for (const r of rows) {
      const payload: NearbyPayload = { activityId, title: r.title, emoji: r.emoji ?? null, placeName: r.placeName, city: r.city ?? null, distanceKm: r.distanceKm };
      const tokens = (await sql`select 1 from push_tokens where user_id = ${r.userId} limit 1`).length > 0;
      await recordInApp(r.userId, 'nearby_plan', activityId, { payload, pushed: tokens, at: now });
      if (tokens) void notify([r.userId], { ...nearbyPushText(payload), data: { activityId, nkind: 'nearby_plan', nref: activityId }, tag: `nearby-${activityId}` });
      told++;
    }
    return told;
  } catch (e) { console.error('nearby plan alert failed', (e as Error)?.message); return 0; }
}

registerFallback('nearby_plan', {
  email: (p: NearbyPayload, u) => nearbyPlanEmail(p, u),
  short: (p: NearbyPayload) => ({ ...nearbyPushText(p), url: appUrl(`/activity/${p.activityId}`) }),
  // Re-checked at email time: still open and ahead, not joined yet, and still a plan this person may see (women-only, blocks).
  stillValid: async (userId, p: NearbyPayload) => (await sql`select 1 from activities a join users u on u.id = ${userId}
    where a.id = ${p.activityId} and a.status = 'active' and not a.closed and a.starts_at > ${clock.now()}
      and (not a.women_only or u.gender = 'woman')
      and not exists (select 1 from blocks b where (b.blocker_id = u.id and b.blocked_id = a.host_id) or (b.blocker_id = a.host_id and b.blocked_id = u.id))
      and not exists (select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${userId})`).length > 0,
});
