// "Travellers this week" (lib/travellers-week.ts) against the database, and GET /travelers/this-week. Everything happens in
// June 2032 (the clock is pinned for the endpoint), so no other test file's trips or locations fall inside these windows.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { clock } = await import('./lib/clock.js');
const { signAccess } = await import('./lib/auth.js');
const { travellersThisWeek, TRAVELLERS_RADIUS_KM } = await import('./lib/travellers-week.js');

const MAIL = '@tweek.tablamigo';
const NOW = new Date('2032-06-09T06:30:00Z');            // Wednesday, 12:00 in India
const H = 3600_000, DAY = 24 * H;
const GOA = { lat: 15.4909, lng: 73.8278 };              // the Goa guide's point; 'goa-in', and 'panaji-in' is its alias (migration 056)
const NEAR = { lat: 15.5440, lng: 73.7550 };             // Calangute, ~10 km away
const FAR = { lat: 15.0100, lng: 74.0232 };              // Palolem, ~55 km away
const date = (days: number) => new Date(NOW.getTime() + days * DAY).toISOString().slice(0, 10);
const pt = (p: { lat: number; lng: number }) => sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;

let app: Awaited<ReturnType<typeof build>>;
const id: Record<string, string> = {};
let hostId: string;

async function person(tag: string, o: { email?: string; onboarded?: boolean; at?: { lat: number; lng: number }; seenAgoDays?: number; snoozed?: boolean; incognito?: boolean } = {}) {
  const [u] = await sql`insert into users (email, name, birthdate, gender, home_country, onboarded, snoozed_until, is_incognito, location, location_at, created_at)
    values (${o.email ?? tag + MAIL}, ${tag}, '1995-01-01', 'woman', 'IN', ${o.onboarded ?? true},
      ${o.snoozed ? new Date(NOW.getTime() + DAY) : null}, ${o.incognito ?? false},
      ${o.at ? pt(o.at) : null}, ${o.at ? new Date(NOW.getTime() - (o.seenAgoDays ?? 1) * DAY) : null}, ${new Date(NOW.getTime() - 30 * DAY)}) returning id`;
  return (id[tag] = u.id as string);
}
const trip = (userId: string, key: string, from: number, to: number, at?: { lat: number; lng: number }) =>
  sql`insert into trips (user_id, city, country_code, city_key, location, start_date, end_date)
    values (${userId}, ${key.split('-')[0]}, 'IN', ${key}, ${at ? pt(at) : null}, ${date(from)}, ${date(to)})`;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + MAIL}`;
  hostId = (await sql`select id from users where account_kind = 'team'`)[0].id;
  await sql`delete from trips where user_id = ${hostId} and start_date >= '2032-01-01' and start_date < '2033-01-01'`;

  await person('me', { at: GOA, seenAgoDays: 0 });
  // Counted
  await trip(await person('tripPoint'), 'tweekville-in', 2, 5, NEAR);                // a trip whose point is within 30 km (its key is no alias)
  await trip(await person('tripAlias'), 'panaji-in', 6, 9);                           // no point, but 'panaji-in' is Goa
  const both = await person('both', { at: NEAR, seenAgoDays: 0.5 });
  await trip(both, 'goa-in', -2, 3);                                                  // here AND on a trip there: counted once
  await person('hereNow', { at: NEAR, seenAgoDays: 2 });
  // Not counted
  await person('staleHere', { at: NEAR, seenAgoDays: 4 });                            // last seen 4 days ago
  await person('farHere', { at: FAR, seenAgoDays: 0 });                               // 55 km away
  await trip(await person('later'), 'goa-in', 8, 12);                                 // starts after the 7 days
  await trip(await person('over'), 'goa-in', -6, -1);                                 // ended yesterday
  await trip(await person('demo', { email: `tweek${Date.now()}@demo.tablamigo` }), 'goa-in', 0, 3);
  await trip(await person('snoozed', { snoozed: true }), 'goa-in', 0, 3);
  await trip(await person('incognito', { incognito: true }), 'goa-in', 0, 3);
  await trip(await person('notOnboarded', { onboarded: false }), 'goa-in', 0, 3);
  await trip(await person('blocked'), 'goa-in', 0, 3);
  await sql`insert into blocks (blocker_id, blocked_id) values (${id.blocked}, ${id.me})`;
  await trip(id.me, 'goa-in', 0, 3);                                                  // the person asking
  await trip(hostId, 'goa-in', 0, 3);                                                 // the team account (deleted again below)
});
afterAll(async () => {
  await sql`delete from trips where user_id = ${hostId} and start_date >= '2032-01-01' and start_date < '2033-01-01'`;
  await sql`delete from users where email like ${'%' + MAIL} or (email like 'tweek%@demo.tablamigo')`;
  vi.restoreAllMocks();
  await app.close();
  await sql.end();
});

describe('travellersThisWeek', () => {
  it('counts trips (by point or by aliased key) and recent locations, each person once, real and visible people only', async () => {
    const r = await travellersThisWeek({ ...GOA, cityKey: 'goa-in', excludeUserId: id.me, now: NOW });
    // arriving: tripPoint, tripAlias, both; here: both, hereNow; total: the four of them.
    expect(r).toEqual({ arriving: 3, here: 2, total: 4 });
  });

  it('an alias key reaches the same city, and without a point only trips count', async () => {
    expect(await travellersThisWeek({ cityKey: 'panaji-in', excludeUserId: id.me, now: NOW })).toEqual({ arriving: 2, here: 0, total: 2 });   // tripAlias, both
  });

  it('without the person asking, they count themselves out only when named; blocks only apply to them', async () => {
    const all = await travellersThisWeek({ ...GOA, cityKey: 'goa-in', now: NOW });
    expect(all.total).toBe(6);   // + me (trip and location) + blocked: nobody is asking, so no block applies
  });

  it('nothing to look for gives zeros, and a place with nobody gives zeros', async () => {
    expect(await travellersThisWeek({ now: NOW })).toEqual({ arriving: 0, here: 0, total: 0 });
    expect(await travellersThisWeek({ lat: -45.1, lng: 170.1, now: NOW })).toEqual({ arriving: 0, here: 0, total: 0 });
  });
});

describe('GET /travelers/this-week', () => {
  it('needs a signed-in user', async () => {
    const r = await app.inject({ method: 'GET', url: `/travelers/this-week?lat=${GOA.lat}&lng=${GOA.lng}` });
    expect(r.statusCode).toBe(401);
  });

  it('returns the counts for the caller, leaving them out', async () => {
    vi.spyOn(clock, 'now').mockReturnValue(NOW);
    const r = await app.inject({ method: 'GET', url: `/travelers/this-week?lat=${GOA.lat}&lng=${GOA.lng}&cityKey=goa-in`, headers: { authorization: `Bearer ${signAccess(id.me)}` } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ arriving: 3, here: 2, total: 4, radiusKm: TRAVELLERS_RADIUS_KM, days: 7 });
    const bad = await app.inject({ method: 'GET', url: `/travelers/this-week?lat=${GOA.lat}&lng=${GOA.lng}&cityKey=goa:women`, headers: { authorization: `Bearer ${signAccess(id.me)}` } });
    expect(bad.statusCode).toBe(400);
  });
});
