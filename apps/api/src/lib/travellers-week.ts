/**
 * "Travellers this week": how many real people are in a city, or heading there, in the next 7 days. Only what the database
 * holds (trips, and where people last opened the app), never an estimate: a count of 0 is 0, and callers say nothing then.
 *
 *   arriving  a trip that overlaps today .. today + 7 days, whose point is within 30 km, or whose city key is the same city
 *             (after city_chat_aliases, so 'bengaluru-in' and 'bangalore-in' are one city)
 *   here      the app last reported their location within 30 km in the last 3 days (the Travelers list uses the same 3 days)
 *   total     the distinct people in either
 *
 * Only real, visible people count: onboarded, not deleted, banned, snoozed or incognito, never a demo persona, a store review
 * account or the team account, never the person asking, and nobody on either side of a block with them.
 */
import { sql } from './db.js';
import { config } from './config.js';
import { clock } from './clock.js';
import { localDate, zoneAt } from './local-time.js';

export const TRAVELLERS_RADIUS_KM = 30;
export const WEEK_DAYS = 7;
export const HERE_DAYS = 3;

/** A real person, as the users row `u`: not a demo persona, store review account or the team account; onboarded; not deleted or banned. */
export const realPerson = () => sql`u.account_kind = 'person' and u.onboarded and u.deleted_at is null and u.banned_at is null
  and u.email not like '%@demo.tablamigo' and not (lower(u.email) = any(${config.reviewEmails}::text[]))`;

export type TravellersWeek = { arriving: number; here: number; total: number };

export async function travellersThisWeek(o: { lat?: number | null; lng?: number | null; cityKey?: string | null; excludeUserId?: string | null; now?: Date }): Promise<TravellersWeek> {
  const now = o.now ?? clock.now();
  const point = o.lat != null && o.lng != null && Number.isFinite(o.lat) && Number.isFinite(o.lng) ? { lat: o.lat, lng: o.lng } : null;
  const key = o.cityKey?.trim().toLowerCase() || null;
  if (!point && !key) return { arriving: 0, here: 0, total: 0 };
  // Trip dates are calendar dates: "today" on the city's own calendar (India's when there is no point).
  const today = localDate(now, point ? zoneAt(point.lat, point.lng) : 'Asia/Kolkata');
  const me = o.excludeUserId ?? null;
  const visible = sql`${realPerson()} and (u.snoozed_until is null or u.snoozed_until <= ${now}) and not coalesce(u.is_incognito, false)
    and (${me}::uuid is null or (u.id <> ${me}::uuid
      and not exists (select 1 from blocks b where (b.blocker_id = ${me}::uuid and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${me}::uuid))))`;
  const m = TRAVELLERS_RADIUS_KM * 1000;
  const [r] = await sql`
    with pt as (select case when ${!!point} then st_setsrid(st_makepoint(${point?.lng ?? null}::float8, ${point?.lat ?? null}::float8), 4326)::geography end as g),
      tk as (select coalesce((select canonical_key from city_chat_aliases where alias_key = ${key}::text), ${key}::text) as k),
      arriving as (
        select distinct t.user_id as id
        from trips t join users u on u.id = t.user_id
          left join city_chat_aliases al on al.alias_key = t.city_key
          cross join pt cross join tk
        where t.start_date <= ${today}::date + ${WEEK_DAYS}::int and t.end_date >= ${today}::date
          and ((pt.g is not null and t.location is not null and st_dwithin(t.location, pt.g, ${m}))
            or (tk.k is not null and coalesce(al.canonical_key, t.city_key) = tk.k))
          and ${visible}),
      here as (
        select u.id from users u cross join pt
        where pt.g is not null and u.location is not null
          and u.location_at > ${now}::timestamptz - ${HERE_DAYS + ' days'}::interval and u.location_at <= ${now}::timestamptz
          and st_dwithin(u.location, pt.g, ${m})
          and ${visible})
    select (select count(*)::int from arriving) as arriving, (select count(*)::int from here) as here,
      (select count(*)::int from (select id from arriving union select id from here) x) as total`;
  return { arriving: r.arriving, here: r.here, total: r.total };
}
