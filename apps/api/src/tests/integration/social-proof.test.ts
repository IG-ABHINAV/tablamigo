// Live counts (lib/social-proof.ts, 1 Nov 2026): GET /public/social-proof and /public/popular-cities count real travellers only,
// say nothing about a city below 10 upcoming trips, and list the popular-cities page only from 3 such cities. Every person here
// is inserted straight into the database (a real traveller can't be a review account, which realTraveller leaves out), in cities
// no other test uses, so the assertions only look at those cities.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const D = '@proof.tablamigo';
process.env.REVIEW_EMAILS = `reviewer${D}`;
process.env.ADMIN_EMAILS = `staff${D}`;
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { SOCIAL_PROOF, computeSocialProof, clearSocialProofCache } = await import('../../lib/social-proof.js');

let app: Awaited<ReturnType<typeof build>>;
const RUN = Math.random().toString(36).slice(2, 7);
const CITY = (n: string) => ({ name: `Proofville${n}${RUN}`, key: `proofville${n}${RUN}-zz` });
const A = CITY('a'), B = CITY('b'), C = CITY('c'), SMALL = CITY('s');
const DAY = 86_400_000;
const day = (d: number) => new Date(Date.now() + d * DAY).toISOString().slice(0, 10);
let n = 0;

async function traveller(o: { email?: string; onboarded?: boolean; deleted?: boolean; banned?: boolean; role?: string; incognito?: boolean } = {}) {
  const email = o.email ?? `t${++n}-${RUN}${D}`;
  const [u] = await sql`insert into users (email, name, onboarded, birthdate, gender, role, deleted_at, banned_at, is_incognito)
    values (${email}, 'Traveller', ${o.onboarded ?? true}, '1993-04-05', 'woman', ${o.role ?? 'user'}, ${o.deleted ? new Date() : null}, ${o.banned ? new Date() : null}, ${o.incognito ?? false})
    returning id`;
  return u.id as string;
}
// Every trip to these cities is at (10, 10); a plan far from there with the same city name is another place of that name.
async function trip(userId: string, c: { name: string; key: string }, from = 2, to = 6) {
  await sql`insert into trips (user_id, city, country_code, city_key, location, start_date, end_date)
    values (${userId}, ${c.name}, 'ZZ', ${c.key}, st_setsrid(st_makepoint(10, 10), 4326)::geography, ${day(from)}, ${day(to)})`;
}
async function plan(hostId: string, c: { name: string }, hours: number, o: { womenOnly?: boolean; status?: string; closed?: boolean; going?: string[]; lng?: number } = {}) {
  const [a] = await sql`insert into activities (host_id, title, category, place_name, city, location, starts_at, status, closed, women_only)
    values (${hostId}, ${'Plan ' + (++n)}, 'food', 'Square', ${c.name}, st_setsrid(st_makepoint(${o.lng ?? 10}, 10), 4326)::geography, ${new Date(Date.now() + hours * 3600_000)},
      ${o.status ?? 'active'}, ${o.closed ?? false}, ${o.womenOnly ?? false}) returning id`;
  // The team account can't be a member of a plan (migration 059), so its starter plans have no host row in activity_members.
  if (hostId !== teamId) await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${a.id}, ${hostId}, 'going')`;
  for (const g of o.going ?? []) await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${a.id}, ${g}, 'going')`;
  return a.id as string;
}
const fresh = async () => { clearSocialProofCache(); return computeSocialProof(); };
const cityIn = (p: Awaited<ReturnType<typeof computeSocialProof>>, c: { key: string }) => p.cities.find(x => x.cityKey === c.key);

let real: string[] = [];
let teamId: string;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  // 9 real travellers going to A; one of them added three trips there (still one).
  for (let i = 0; i < 9; i++) real.push(await traveller());
  for (const id of real) await trip(id, A);
  await trip(real[0], A, 10, 12); await trip(real[0], A, 20, 22);
  // People who must never count, each with a trip to A.
  const [team] = await sql`select id from users where account_kind = 'team' limit 1`;
  teamId = team?.id ?? (await sql`insert into users (email, name, account_kind, onboarded) values (${`team-${RUN}@team.tablamigo`}, 'Tablamigo Host (Team)', 'team', false) returning id`)[0].id;
  const never = [
    teamId,
    await traveller({ email: `persona-${RUN}@demo.tablamigo` }),
    await traveller({ email: `reviewer${D}` }),
    await traveller({ email: `staff${D}` }),
    await traveller({ role: 'admin' }),
    await traveller({ email: `qa-${RUN}@qa.test` }),
    await traveller({ email: `x-${RUN}@example.com` }),
    await traveller({ deleted: true }),
    await traveller({ banned: true }),
    await traveller({ onboarded: false }),
    await traveller({ incognito: true }),
  ];
  for (const id of never) await trip(id, A);
  // A trip that already ended doesn't count.
  const past = await traveller();
  await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${past}, ${A.name}, 'ZZ', ${A.key}, ${day(-10)}, ${day(-3)})`;
  // A small city: 3 real travellers, never published.
  for (let i = 0; i < 3; i++) await trip(await traveller(), SMALL);
});
beforeEach(() => { config.socialProof = 'auto'; });
afterAll(async () => {
  await sql`delete from trips where city_key like ${'proofville%' + RUN + '-zz'}`;
  await sql`delete from activities where city like ${'Proofville%' + RUN}`;
  await sql`delete from users where email like ${'%' + D} or email like ${'%-' + RUN + '%'}`;
  clearSocialProofCache();
  await app.close();
});

describe('the per-city threshold', () => {
  it('9 real travellers (and a crowd of demo, team, review, admin, test, deleted, banned, unfinished, hidden accounts): nothing about the city', async () => {
    const p = await fresh();
    expect(cityIn(p, A)).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain(A.name);
  });

  it(`the ${SOCIAL_PROOF.MIN_TRIPS}th real traveller turns the city on, with the true count`, async () => {
    const tenth = await traveller(); real.push(tenth);
    await trip(tenth, A);
    const c = cityIn(await fresh(), A);
    expect(c).toMatchObject({ city: A.name, countryCode: 'ZZ', upcomingTrips: 10 });
  });

  it('a city below the threshold is never in either answer, even beside a qualifying one', async () => {
    const r = await app.inject({ method: 'GET', url: '/public/social-proof' });
    clearSocialProofCache();
    expect(r.body).not.toContain(SMALL.key);
    expect(r.body).not.toContain(SMALL.name);
    const pc = await app.inject({ method: 'GET', url: '/public/popular-cities' });
    expect(pc.body).not.toContain(SMALL.name);
  });

  it('a traveller who is deleted drops the city back below the line', async () => {
    await sql`update users set deleted_at = now() where id = ${real[9]}`;
    expect(cityIn(await fresh(), A)).toBeUndefined();
    await sql`update users set deleted_at = null where id = ${real[9]}`;
    expect(cityIn(await fresh(), A)?.upcomingTrips).toBe(10);
  });
});

describe('plans', () => {
  it('counts plans by real, visible hosts only, and lists today only the open, not women-only ones with 3+ real people going', async () => {
    const demo = await traveller({ email: `host-${RUN}@demo.tablamigo` });
    const hidden = await traveller({ incognito: true });
    const listed = await plan(real[1], A, 3, { going: [real[2], real[8], demo, hidden] }); // today: host + 2 real guests (+ demo, hidden)
    await plan(real[0], A, 2, { going: [real[2], demo] });                    // today, counted, but only 2 real people: not listed
    await plan(hidden, A, 4, { going: [real[2], real[8]] });                  // an incognito host's plan: never counted or listed
    await plan(real[3], A, 6, { lng: 60, going: [real[2], real[8]] });       // same city name, 5,000 km away: another place
    await plan(real[3], A, 50);                                               // later this week
    await plan(real[4], A, 5, { womenOnly: true });                           // counted, never listed
    await plan(teamId, A, 4);                                                 // the team's starter plan
    await plan(demo, A, 4);                                                   // a demo persona's
    await plan(real[5], A, 6, { status: 'cancelled' });
    await plan(real[6], A, 7, { closed: true });
    await plan(real[7], A, 24 * 9);                                           // beyond the week
    const p = await fresh();
    expect(cityIn(p, A)?.plansThisWeek).toBe(4);
    const today = p.today.filter(t => t.city === A.name);
    expect(today.length).toBe(1);
    expect(today[0].going).toBe(3); // the host and the 2 real guests, not the demo persona or the hidden one
    const [row] = await sql`select title from activities where id = ${listed}`;
    expect(today[0].title).toBe(row.title);
    expect(Object.keys(today[0]).sort()).toEqual(['city', 'emoji', 'going', 'startsAt', 'title']); // no id, no host
  });

  it('the totals add up the published cities only, so they never reveal a small one', async () => {
    const p = await fresh();
    expect(p.totals).toEqual({
      upcomingTrips: p.cities.reduce((n, c) => n + c.upcomingTrips, 0),
      plansThisWeek: p.cities.reduce((n, c) => n + c.plansThisWeek, 0),
      cities: p.cities.length,
    });
  });
});

describe('the popular-cities page', () => {
  it(`stays off with fewer than ${SOCIAL_PROOF.MIN_CITIES} qualifying cities, then ranks them by trips, then plans`, async () => {
    clearSocialProofCache();
    const before = (await app.inject({ method: 'GET', url: '/public/popular-cities' })).json();
    if (!before.enabled) expect(before.cities).toEqual([]);
    for (const [c, k] of [[B, 12], [C, 11]] as const) for (let i = 0; i < k; i++) await trip(await traveller(), c);
    clearSocialProofCache();
    const r = await app.inject({ method: 'GET', url: '/public/popular-cities' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    const body = r.json();
    expect(body.enabled).toBe(true);
    const mine = body.cities.filter((c: any) => [A.key, B.key, C.key].includes(c.cityKey)).map((c: any) => [c.cityKey, c.upcomingTrips]);
    expect(mine).toEqual([[B.key, 12], [C.key, 11], [A.key, 10]]);
    const trending = (await fresh()).trending.map(t => t.cityKey);
    expect(trending.filter(k => [A.key, B.key, C.key].includes(k))).toEqual([B.key, C.key, A.key]);
  });

  it('SOCIAL_PROOF=off: nothing anywhere', async () => {
    config.socialProof = 'off';
    const p = await fresh();
    expect(p).toMatchObject({ cities: [], totals: null, trending: [], today: [] });
    clearSocialProofCache();
    expect((await app.inject({ method: 'GET', url: '/public/popular-cities' })).json()).toMatchObject({ enabled: false, cities: [] });
    clearSocialProofCache();
  });

  it('is public (no sign-in) and never says who', async () => {
    clearSocialProofCache();
    const r = await app.inject({ method: 'GET', url: '/public/social-proof' });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toMatch(/@|"email"|"name"|hostId|userId/);
  });
});
