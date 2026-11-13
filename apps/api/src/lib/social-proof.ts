/**
 * Live counts for the website's home page, the app's Explore sheet and the site's "popular cities" page (NomadTable teardown
 * gaps 7 and 8, 1 Nov 2026). NomadTable's home page shows a live counter; with 79 real accounts Tablamigo's honest numbers would
 * hurt, so nothing shows until a city is busy enough, and then only true numbers.
 *
 * Only real travellers count (lib/team-dm.ts realTraveller: never the team account, a demo persona, a store review account, an
 * admin, a test address, a deleted, banned or not-yet-onboarded account), and nobody incognito. A plan counts only when its host
 * is a real traveller who isn't hidden, so the team's starter plans never make a city look busy.
 *
 *   upcoming trips   travellers with a trip to the city that has not ended (one per traveller, however many trips they added);
 *                    cities are one after city_chat_aliases, so 'bangalore-in' and 'bengaluru-in' are counted together
 *   plans this week  open plans (not cancelled or closed) starting in the next 7 days whose city is one of the city's names and,
 *                    when the city's trips carry a point, within 60 km of their centre (so Valencia, Spain never takes Valencia,
 *                    Venezuela's plans)
 *   today            plans starting in the next 24 hours in a qualifying city with at least TODAY_MIN_GOING real people going:
 *                    never women-only ones, never the host's name, never the plan's id
 *
 * The per-city switch: a city is shown only once it has MIN_TRIPS upcoming trips; below that, no number about it leaves this
 * file, not even through the totals: they add up the qualifying cities only, so subtracting them never reveals a small one.
 * The popular-cities page needs MIN_CITIES qualifying cities. SOCIAL_PROOF=off turns all of it off.
 */
import { sql } from './db.js';
import { config } from './config.js';
import { clock } from './clock.js';
import { localDate } from './local-time.js';
import { realTraveller } from './team-dm.js';

export const SOCIAL_PROOF = { MIN_TRIPS: 10, MIN_CITIES: 3, TODAY_MIN_GOING: 3, NEAR_KM: 60, CACHE_MS: 5 * 60_000 } as const;

export type CityCount = { cityKey: string; city: string; countryCode: string; upcomingTrips: number; plansThisWeek: number };
export type TodayPlan = { title: string; emoji: string; city: string; startsAt: string; going: number };
export type SocialProof = {
  minTrips: number;
  /** Qualifying cities, busiest first. Empty: nothing renders anywhere. */
  cities: CityCount[];
  /** Over the qualifying cities only, only while there is one. */
  totals: { upcomingTrips: number; plansThisWeek: number; cities: number } | null;
  /** The qualifying cities with the most trips starting in the next 30 days. */
  trending: { cityKey: string; city: string; countryCode: string; travellers: number }[];
  today: TodayPlan[];
};

const EMPTY: SocialProof = { minTrips: SOCIAL_PROOF.MIN_TRIPS, cities: [], totals: null, trending: [], today: [] };

/** Computed from the database, no cache (tests and the cached getter use it). */
export async function computeSocialProof(now: Date = clock.now()): Promise<SocialProof> {
  if (config.socialProof === 'off') return EMPTY;
  // Trip dates are calendar dates; the product's home is India, so "today" is India's (as lib/travellers-week.ts without a point).
  const today = localDate(now, 'Asia/Kolkata');
  const goingReal = sql`(select count(*)::int from activity_members m join users g on g.id = m.user_id
    where m.activity_id = a.id and m.rsvp_status = 'going' and ${realTraveller('g')} and not coalesce(g.is_incognito, false))`;
  const hostShown = sql`${realTraveller('h')} and not coalesce(h.is_incognito, false)`;
  const rows = await sql`
    with real_trips as (
      select coalesce(al.canonical_key, t.city_key) as k, t.user_id, t.city, t.country_code, t.start_date, t.location
      from trips t join users u on u.id = t.user_id left join city_chat_aliases al on al.alias_key = t.city_key
      where t.end_date >= ${today}::date and ${realTraveller('u')} and not coalesce(u.is_incognito, false)),
    cities as (
      select k, mode() within group (order by city) as city, mode() within group (order by country_code) as country_code,
        count(distinct user_id)::int as upcoming_trips,
        count(distinct user_id) filter (where start_date <= ${today}::date + 30)::int as next30,
        array_agg(distinct lower(city)) as names,
        st_centroid(st_collect(location::geometry))::geography as centre
      from real_trips group by k),
    real_plans as (
      select a.id, a.location, lower(a.city) as lc
      from activities a join users h on h.id = a.host_id
      where a.status = 'active' and not a.closed and a.starts_at >= ${now}::timestamptz - interval '1 hour'
        and a.starts_at < ${now}::timestamptz + interval '7 days' and ${hostShown})
    select c.k as city_key, c.city, c.country_code, c.upcoming_trips, c.next30,
      (select count(*)::int from real_plans p where p.lc = any(c.names)
        and (c.centre is null or st_dwithin(p.location, c.centre, ${SOCIAL_PROOF.NEAR_KM * 1000}))) as plans_this_week
    from cities c order by c.upcoming_trips desc, c.k`;
  const all = rows.map(r => ({ cityKey: r.cityKey as string, city: r.city as string, countryCode: r.countryCode as string,
    upcomingTrips: r.upcomingTrips as number, plansThisWeek: r.plansThisWeek as number, next30: r.next30 as number }));
  const qualifying = all.filter(c => c.upcomingTrips >= SOCIAL_PROOF.MIN_TRIPS);
  if (!qualifying.length) return EMPTY;

  const cities = qualifying.map(({ next30: _, ...c }) => c)
    .sort((x, y) => y.upcomingTrips - x.upcomingTrips || y.plansThisWeek - x.plansThisWeek || x.cityKey.localeCompare(y.cityKey));
  const trending = qualifying.filter(c => c.next30 > 0).sort((x, y) => y.next30 - x.next30 || x.cityKey.localeCompare(y.cityKey)).slice(0, 5)
    .map(c => ({ cityKey: c.cityKey, city: c.city, countryCode: c.countryCode, travellers: c.next30 }));
  // Today's plans in the qualifying cities: the same name-and-distance match as the counts, per city.
  const today24 = await sql`
    with q as (
      select coalesce(al.canonical_key, t.city_key) as k, array_agg(distinct lower(t.city)) as names,
        st_centroid(st_collect(t.location::geometry))::geography as centre
      from trips t left join city_chat_aliases al on al.alias_key = t.city_key
      where coalesce(al.canonical_key, t.city_key) = any(${qualifying.map(c => c.cityKey)}::text[]) and t.end_date >= ${today}::date
      group by 1),
    p as (
      select a.title, a.emoji, a.city, a.starts_at, ${goingReal} as going
      from activities a join users h on h.id = a.host_id
      where a.status = 'active' and not a.closed and not a.women_only
        and a.starts_at >= ${now}::timestamptz and a.starts_at < ${now}::timestamptz + interval '24 hours'
        and ${hostShown}
        and exists (select 1 from q where lower(a.city) = any(q.names)
          and (q.centre is null or st_dwithin(a.location, q.centre, ${SOCIAL_PROOF.NEAR_KM * 1000}))))
    select * from p where going >= ${SOCIAL_PROOF.TODAY_MIN_GOING} order by starts_at limit 6`;
  return {
    minTrips: SOCIAL_PROOF.MIN_TRIPS, cities,
    totals: {
      upcomingTrips: cities.reduce((n, c) => n + c.upcomingTrips, 0),
      plansThisWeek: cities.reduce((n, c) => n + c.plansThisWeek, 0),
      cities: cities.length,
    },
    trending,
    today: today24.map(p => ({ title: p.title, emoji: p.emoji, city: p.city, startsAt: new Date(p.startsAt).toISOString(), going: p.going })),
  };
}

let cache: { at: number; value: Promise<SocialProof> } | null = null;
/** The same, at most SOCIAL_PROOF.CACHE_MS old: the endpoints are public, so one query serves everyone for a few minutes. */
export function socialProof(now: Date = clock.now()): Promise<SocialProof> {
  if (!cache || now.getTime() - cache.at > SOCIAL_PROOF.CACHE_MS || now.getTime() < cache.at) {
    const value = computeSocialProof(now);
    cache = { at: now.getTime(), value };
    value.catch(() => { if (cache?.value === value) cache = null; });
  }
  return cache.value;
}
export const clearSocialProofCache = () => { cache = null; };

/** The popular-cities page: ranked qualifying cities, and whether the page may be listed (MIN_CITIES of them). */
export async function popularCities(now: Date = clock.now()) {
  const p = await socialProof(now);
  const enabled = p.cities.length >= SOCIAL_PROOF.MIN_CITIES;
  return { enabled, minTrips: SOCIAL_PROOF.MIN_TRIPS, minCities: SOCIAL_PROOF.MIN_CITIES, cities: enabled ? p.cities : [] };
}
