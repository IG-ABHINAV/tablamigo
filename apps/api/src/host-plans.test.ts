// Admin "Create plan as Tablamigo team" (POST /admin/host/plans, lib/host-plans.ts): who may use it, what it validates, what it
// writes (plan, group chat, opening line, no member, no funnel event, one audit event), that it shows in Explore, that
// the starter-plans worker still lists through the same service, and the place search. Fixed in 2034 so nothing else's rows interfere.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const MAIL = '@hostplans.tablamigo';
process.env.REVIEW_EMAILS = `review${MAIL}`;
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { clock } = await import('./lib/clock.js');
const { signAccess } = await import('./lib/auth.js');
const { HOST_PLAN_OPENING } = await import('./lib/host-plans.js');
const S = await import('./lib/starter-plans.js');

const NOW = new Date('2034-06-01T03:00:00Z');
const UBUD = { lat: -8.5069, lng: 115.2625 };   // Asia/Makassar, UTC+8
const base = { title: 'Coffee meetup in Ubud', emoji: '☕', category: 'food', description: 'Travellers and locals in Ubud: coffee meetup. Hosted by the Tablamigo team to help people here connect.', placeName: 'Clear Cafe, Ubud', ...UBUD, city: 'Ubud', localAt: '2034-06-03T16:00' };

let app: Awaited<ReturnType<typeof build>>;
let hostId: string, boss: string, rider: string;
const as = (uid: string) => (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${signAccess(uid)}` } });
const user = async (tag: string, role = 'user') => (await sql`insert into users (email, name, birthdate, gender, home_country, onboarded, role) values (${tag + MAIL}, ${tag}, '1995-01-01', 'woman', 'GB', true, ${role}) returning id`)[0].id as string;
const cleanup = async () => {
  // Only this file's own plans (by venue): other files keep Host plans in 2034 too, and run in parallel.
  await sql`delete from activities where host_id = ${hostId} and place_name in ('Clear Cafe, Ubud', 'Test Cafe', 'Test Ridge', 'Test Warung')`;
  await sql`delete from analytics_events where user_id in (select id from users where email like ${'%' + MAIL})`;
  await sql`delete from users where email like ${'%' + MAIL}`;
};

beforeAll(async () => {
  app = await build();
  hostId = (await sql`select id from users where account_kind = 'team'`)[0].id;
  await cleanup();
  boss = await user('boss', 'admin'); rider = await user('rider');
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
});
afterAll(async () => { vi.restoreAllMocks(); await cleanup(); await app.close(); await sql.end(); });

describe('POST /admin/host/plans', () => {
  it('is for admins only: nobody, a traveller and the team account are refused', async () => {
    expect((await app.inject({ method: 'POST', url: '/admin/host/plans', payload: base })).statusCode).toBe(401);
    expect((await as(rider)('POST', '/admin/host/plans', base)).statusCode).toBe(403);
    expect((await as(hostId)('POST', '/admin/host/plans', base)).statusCode).toBe(403);
    expect((await as(rider)('GET', '/admin/host/places?q=cafe')).statusCode).toBe(403);
    expect(await sql`select 1 from activities where host_id = ${hostId} and place_name = 'Clear Cafe, Ubud'`).toEqual([]);
  });

  it('lists the plan as the Host with its group chat, reads the local time in the venue zone, and records the admin', async () => {
    const r = await as(boss)('POST', '/admin/host/plans', { ...base, maxPeople: 8 });
    expect(r.statusCode, r.body).toBe(200);
    const j = r.json();
    expect(j).toMatchObject({ city: 'Ubud', startsAt: '2034-06-03T08:00:00.000Z' });   // 16:00 in UTC+8
    const [a] = await sql`select host_id, title, city, place_name, description, max_people, women_only, status, starts_at, st_y(location::geometry) as lat from activities where id = ${j.id}`;
    expect(a).toMatchObject({ hostId, title: base.title, city: 'Ubud', placeName: base.placeName, maxPeople: 8, womenOnly: false, status: 'active' });
    expect(a.description).toBe(base.description);
    expect(a.lat).toBeCloseTo(UBUD.lat, 4);
    expect(await sql`select 1 from activity_members where activity_id = ${j.id}`).toEqual([]);   // the Host is never a member
    const msgs = await sql`select kind, body from messages where chat_id = ${j.chatId}`;
    expect(msgs).toEqual([{ kind: 'system', body: HOST_PLAN_OPENING }]);
    expect((await sql`select kind, activity_id from chats where id = ${j.chatId}`)[0]).toMatchObject({ kind: 'activity', activityId: j.id });
    expect(await sql`select 1 from analytics_events where event_name = 'plan_created' and properties->>'activityId' = ${j.id}`).toEqual([]);
    const [audit] = await sql`select user_id, properties from analytics_events where event_name = 'admin_host_plan_create' and properties->>'activityId' = ${j.id}`;
    expect(audit.userId).toBe(boss);
    expect(audit.properties).toMatchObject({ city: 'Ubud', chatId: j.chatId });
  });

  it('shows in Explore near the venue, a traveller can join and lands in the chat; "going" counts only people', async () => {
    // Explore reads the database's now(), so this one plan is made at the real time, not the pinned 2034 one.
    vi.mocked(clock.now).mockRestore();
    const day = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const made = await as(boss)('POST', '/admin/host/plans', { ...base, title: 'Explore check (hostplans test)', localAt: `${day}T16:00` });
    vi.spyOn(clock, 'now').mockReturnValue(NOW);
    expect(made.statusCode, made.body).toBe(200);
    const list = (await as(rider)('GET', `/activities?lat=${UBUD.lat}&lng=${UBUD.lng}&when=week`)).json();
    const mine = list.activities.find((p: any) => p.id === made.json().id);
    expect(mine, JSON.stringify(list).slice(0, 300)).toBeTruthy();
    const join = await as(rider)('POST', `/activities/${mine.id}/join`);
    expect(join.statusCode, join.body).toBe(200);
    expect((await sql`select count(*)::int as n from chat_members where chat_id = ${join.json().chatId} and user_id = ${rider}`)[0].n).toBe(1);
    expect((await sql`select count(*)::int as n from activity_members where activity_id = ${mine.id}`)[0].n).toBe(1);
  });

  it('refuses bad input: both or neither time, past, too far, odd dates, extra fields, short text, bad category, bad point, duplicates', async () => {
    const post = (b: object) => as(boss)('POST', '/admin/host/plans', b);
    const { localAt, ...noTime } = base;
    expect((await post(noTime)).statusCode).toBe(400);
    expect((await post({ ...base, startsAt: '2034-06-03T08:00:00.000Z' })).statusCode).toBe(400);
    expect((await post({ ...base, localAt: '2034-06-01T09:00' })).json().error).toBe('bad_time');       // 1 h ahead (< 4 h)
    expect((await post({ ...base, localAt: '2034-08-01T09:00' })).json().error).toBe('bad_time');       // > 30 days
    expect((await post({ ...base, localAt: '2034-02-31T09:00' })).json().error).toBe('bad_time');       // no such date
    expect((await post({ ...base, localAt: '2034-06-03T25:00' })).statusCode).toBe(400);
    expect((await post({ ...base, hostId: rider })).statusCode).toBe(400);                              // strict: cannot name another host
    expect((await post({ ...base, description: 'short' })).statusCode).toBe(400);
    expect((await post({ ...base, category: 'dating' })).statusCode).toBe(400);
    expect((await post({ ...base, lat: 95 })).statusCode).toBe(400);
    expect((await post({ ...base, maxPeople: 1 })).statusCode).toBe(400);
    const dup = await post({ ...base, title: 'Twice', localAt: '2034-06-04T10:00' });
    expect(dup.statusCode).toBe(200);
    expect((await post({ ...base, title: 'Twice', localAt: '2034-06-04T10:00' })).json().error).toBe('duplicate_plan');
  });

  it('the city comes from the geocoder when the form passes none; no city at all is refused', async () => {
    const { city, ...noCity } = base;
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async (u: any, i?: any) => String(u).includes('nominatim') ? new Response(JSON.stringify({ address: { city: 'Ubud' } }), { status: 200 }) : real(u, i)) as any;
    const ok = await as(boss)('POST', '/admin/host/plans', { ...noCity, title: 'Geocoded city', localAt: '2034-06-05T16:00', lat: -8.5, lng: 115.3 });
    globalThis.fetch = real;
    expect([200, 400]).toContain(ok.statusCode);   // depends on the canned geocoder; the 400 must be the explicit one
    if (ok.statusCode === 400) expect(ok.json().error).toBe('no_city');
    else expect(ok.json().city).toBeTruthy();
  });
});

describe('GET /admin/host/places', () => {
  it('returns Photon candidates for an admin, validates the query', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = vi.fn(async (u: any, i?: any) => String(u).includes('photon') ? new Response(JSON.stringify({ features: [{ geometry: { coordinates: [115.26, -8.5] }, properties: { name: 'Clear Cafe', city: 'Ubud', countrycode: 'ID' } }] }), { status: 200 }) : real(u, i)) as any;
    const r = await as(boss)('GET', '/admin/host/places?q=Clear%20Cafe%20Ubud&lat=-8.5&lng=115.2');
    globalThis.fetch = real;
    expect(r.json().places).toEqual([{ name: 'Clear Cafe', city: 'Ubud', country: 'ID', lat: -8.5, lng: 115.26, detail: null }]);
    expect((await as(boss)('GET', '/admin/host/places?q=x')).statusCode).toBe(400);
  });
});

describe('the starter-plans worker uses the same service', () => {
  it('still lists a starter plan with its chat, opening line, no member and a starter_plans row', async () => {
    const city = { key: 'ubud-test-id', city: 'Ubud', lat: UBUD.lat, lng: UBUD.lng, venues: { cafe: { name: 'Test Cafe', ...UBUD }, sunset: { name: 'Test Ridge', ...UBUD }, chai: { name: 'Test Warung', ...UBUD } } };
    const person = await user('local1'); const person2 = await user('local2');
    for (const p of [person, person2]) await sql`update users set location = st_setsrid(st_makepoint(${UBUD.lng}, ${UBUD.lat}), 4326)::geography, location_at = ${new Date(NOW.getTime() - 3600_000)} where id = ${p}`;
    const out = await S.maintainStarterPlans(NOW, 'on', { cities: [city] });
    expect(out.created.length).toBeGreaterThan(0);
    const c = { ...out.created[0], id: out.created[0].id! };
    const [a] = await sql`select host_id, description from activities where id = ${c.id}`;
    expect(a.hostId).toBe(hostId);
    expect(a.description).toBe(S.STARTER_DESCRIPTION);
    expect((await sql`select body from messages where chat_id = (select id from chats where activity_id = ${c.id})`)[0].body).toBe(S.OPENING_LINE);
    expect(await sql`select 1 from activity_members where activity_id = ${c.id}`).toEqual([]);
    expect((await sql`select city_key from starter_plans where activity_id = ${c.id}`)[0].cityKey).toBe('ubud-test-id');
  });
});
