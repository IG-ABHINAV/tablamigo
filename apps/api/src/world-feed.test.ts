// The plan list's world fallback (4 Nov 2026): with few or no plans within the radius, GET /activities adds `world`, plans
// from anywhere else, nearest first, and GET /activities/world pages on from its cursor. Same rules as the nearby list:
// cancelled, past, women-only (for men) and blocked hosts' plans never show.
//
// The test database is shared with other files that post plans (Mumbai, Bangkok, Istanbul...), so the viewers stand on remote
// islands and the checks look at this file's own plans and at the order of the whole list.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['wf_viewer', 'wf_host', 'wf_blocked', 'wf_woman'];
const DOMAIN = 'worldfeed.tablamigo';
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@${DOMAIN}`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { FEW_NEARBY_PLANS, WORLD_PAGE } = await import('./routes/activities.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = ((method: string, url: string) => Promise<import('light-my-request').Response>) & { id: string };

let ip = 60;
async function login(name: string, gender: string): Promise<Api> {
  const email = `${name}@${DOMAIN}`, remoteAddress = `10.78.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call = ((method: string, url: string) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${tok}` }, remoteAddress })) as Api;
  await app.inject({ method: 'PATCH', url: '/me', payload: { name: name.slice(3), birthdate: '1993-03-03', gender, homeCountry: 'GB' }, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  call.id = (await sql`select id from users where email = ${email}`)[0].id;
  return call;
}

// Tristan da Cunha: nothing else in the test database is anywhere near it.
const TRISTAN = { lat: -37.1052, lng: -12.2777 };
// Pitcairn: the viewer's second spot, with plenty of plans nearby.
const PITCAIRN = { lat: -25.0660, lng: -130.1015 };
// Kerguelen: nothing within 1,500 km at all.
const KERGUELEN = { lat: -49.3500, lng: 70.2200 };

const u: Record<string, Api> = {};
const ids: Record<string, string> = {};
async function plan(key: string, hostId: string, at: { lat: number; lng: number }, o: { category?: string; womenOnly?: boolean; status?: string; inHours?: number } = {}) {
  const [a] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at, women_only, status)
    values (${hostId}, ${'WF ' + key}, ${o.category ?? 'outdoors'}, ${'Spot ' + key},
      ST_SetSRID(ST_MakePoint(${at.lng}, ${at.lat}), 4326)::geography, now() + make_interval(hours => ${o.inHours ?? 24}),
      ${o.womenOnly ?? false}, ${o.status ?? 'active'}) returning id`;
  ids[key] = a.id;
}
const clean = async () => {
  await sql`delete from activities where host_id in (select id from users where email like ${'%@' + DOMAIN})`;
  await sql`delete from users where email like ${'%@' + DOMAIN}`;
};
const q = (at: { lat: number; lng: number }, extra = '') => `lat=${at.lat}&lng=${at.lng}${extra}`;
// This file's plans in a list, by key. The Pitcairn ones only in their own test (from Tristan they sit between Buenos Aires and Tokyo).
const mine = (list: any[], withPitcairn = false) => list.map(a => Object.keys(ids).find(k => ids[k] === a.id))
  .filter((k): k is string => !!k && (withPitcairn || !k.startsWith('pitcairn')));
const ascending = (list: any[]) => list.every((a, i) => i === 0 || list[i - 1].distanceM <= a.distanceM);

beforeAll(async () => {
  app = await build();
  await clean();
  u.viewer = await login('wf_viewer', 'man');
  u.host = await login('wf_host', 'woman');
  u.blocked = await login('wf_blocked', 'man');
  u.woman = await login('wf_woman', 'woman');
  await sql`insert into blocks (blocker_id, blocked_id) values (${u.viewer.id}, ${u.blocked.id})`;
  // One plan 3 km from the viewer on Tristan, then the world at growing distances.
  await plan('near', u.host.id, { lat: -37.08, lng: -12.25 });
  await plan('capeTown', u.host.id, { lat: -33.9249, lng: 18.4241 });            // ~2,800 km
  await plan('rio', u.host.id, { lat: -22.9068, lng: -43.1729 }, { category: 'food' }); // ~3,300 km
  await plan('buenosAires', u.host.id, { lat: -34.6037, lng: -58.3816 });       // ~4,000 km
  await plan('tokyo', u.host.id, { lat: 35.6762, lng: 139.6503 });               // ~15,000 km
  // Never shown to this viewer: women-only (he's a man), a blocked host, cancelled, already over.
  await plan('womenOnly', u.woman.id, { lat: -33.93, lng: 18.43 }, { womenOnly: true });
  await plan('blockedHost', u.blocked.id, { lat: -33.93, lng: 18.43 });
  await plan('cancelled', u.host.id, { lat: -33.93, lng: 18.43 }, { status: 'cancelled' });
  await plan('past', u.host.id, { lat: -33.93, lng: 18.43 }, { inHours: -30 });
  // Pitcairn: enough plans nearby that no world list is added.
  for (let i = 0; i < FEW_NEARBY_PLANS; i++) await plan(`pitcairn${i}`, u.host.id, { lat: PITCAIRN.lat + i * 0.01, lng: PITCAIRN.lng });
});
afterAll(async () => { await clean(); await app.close(); await sql.end(); });

describe('few plans nearby: the rest of the world, nearest first', () => {
  it('adds `world` after the nearby plans, never repeating them, under the same safety rules', async () => {
    const r = (await u.viewer('GET', `/activities?${q(TRISTAN)}`)).json();
    expect(mine(r.activities)).toEqual(['near']);
    expect(r.world).toBeTruthy();
    expect(r.world.activities.length).toBeGreaterThan(0);
    expect(r.world.activities.length).toBeLessThanOrEqual(WORLD_PAGE);
    expect(ascending(r.world.activities)).toBe(true);
    expect(r.world.activities.every((a: any) => a.distanceM > 25_000)).toBe(true);
    // This file's plans in distance order; the world is bigger than one page only if other files left plans around.
    const first = mine(r.world.activities);
    expect(first.slice(0, 4)).toEqual(['capeTown', 'rio', 'buenosAires', 'tokyo'].slice(0, first.length));
    for (const hidden of ['near', 'womenOnly', 'blockedHost', 'cancelled', 'past']) expect(first).not.toContain(hidden);
    // The shape the app renders: same columns as a nearby plan, no live location of anyone, no internal sort key.
    const cape = r.world.activities.find((a: any) => a.id === ids.capeTown);
    expect(cape).toMatchObject({ title: 'WF capeTown', host: { id: u.host.id }, lat: expect.any(Number), lng: expect.any(Number) });
    expect(cape.distanceM).toBeGreaterThan(2_500_000);
    expect(cape).not.toHaveProperty('hostRank');
  });

  it('pages on with GET /activities/world: no duplicates, still nearest first, every plan reached once', async () => {
    const seen: any[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 500; page++) {
      const r: import('light-my-request').Response = await u.viewer('GET', `/activities/world?${q(TRISTAN, '&limit=3')}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.statusCode).toBe(200);
      const body: { activities: any[]; nextCursor: string | null } = r.json();
      expect(body.activities.length).toBeLessThanOrEqual(3);
      seen.push(...body.activities);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(new Set(seen.map(a => a.id)).size).toBe(seen.length);
    expect(ascending(seen)).toBe(true);
    expect(mine(seen)).toEqual(['capeTown', 'rio', 'buenosAires', 'tokyo']);
    // The first page of GET /activities is the start of the same list (other files add and delete plans while this runs, so
    // this compares this file's plans only).
    const first = mine((await u.viewer('GET', `/activities?${q(TRISTAN)}`)).json().world.activities);
    expect(mine(seen).slice(0, first.length)).toEqual(first);
  });

  it('a woman sees the women-only plan; nobody sees a host they blocked', async () => {
    const r = (await u.woman('GET', `/activities?${q(TRISTAN)}`)).json();
    const all: any[] = [...r.world.activities];
    let cursor = r.world.nextCursor;
    while (cursor) { const p = (await u.woman('GET', `/activities/world?${q(TRISTAN)}&cursor=${cursor}`)).json(); all.push(...p.activities); cursor = p.nextCursor; }
    expect(mine(all)).toContain('womenOnly');
    expect(mine(all)).toContain('blockedHost');
  });

  it('keeps the filters: a category filter applies to the world list too', async () => {
    const r = (await u.viewer('GET', `/activities?${q(TRISTAN, '&category=food')}`)).json();
    expect(mine(r.activities)).toEqual([]);
    expect(mine(r.world.activities)).toEqual(['rio']);
    expect(r.world.activities.every((a: any) => a.category === 'food')).toBe(true);
  });

  it('no plans within 1,500 km: an empty nearby list and the world from the nearest one', async () => {
    const r = (await u.viewer('GET', `/activities?${q(KERGUELEN)}`)).json();
    expect(r.activities).toEqual([]);
    expect(r.world.activities.length).toBeGreaterThan(0);
    expect(ascending(r.world.activities)).toBe(true);
  });

  it(`${FEW_NEARBY_PLANS} or more plans nearby: no world list`, async () => {
    const r = (await u.viewer('GET', `/activities?${q(PITCAIRN)}`)).json();
    expect(mine(r.activities, true)).toHaveLength(FEW_NEARBY_PLANS);
    expect(r.world).toBeNull();
  });

  it('refuses a malformed cursor and a missing point', async () => {
    expect((await u.viewer('GET', `/activities/world?${q(TRISTAN)}&cursor=abc`)).statusCode).toBe(400);
    expect((await u.viewer('GET', `/activities/world?${q(TRISTAN)}&cursor=1_${"'; drop table activities; --".padEnd(36, 'x')}`)).statusCode).toBe(400);
    expect((await u.viewer('GET', '/activities/world')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: `/activities/world?${q(TRISTAN)}` })).statusCode).toBe(401);
  });
});
