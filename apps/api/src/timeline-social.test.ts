import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['tl_host', 'tl_guest', 'tl_stranger'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@timeline.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 700;
async function login(name: string): Promise<Api> {
  const email = `${name}@timeline.tablamigo`;
  const remoteAddress = `10.95.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1995-05-15', gender: 'woman', homeCountry: 'ES' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@timeline.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@timeline.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});

afterAll(async () => {
  await sql`delete from users where email like '%@timeline.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Social Links & Contact Shielding', () => {
  it('saves and sanitizes Instagram handle', async () => {
    // Strips @
    const r1 = await u.tl_host('PATCH', '/me', { instagram: '@globetrotter_maya' });
    expect(r1.statusCode).toBe(200);
    const me1 = await u.tl_host('GET', '/me');
    expect(me1.json().instagram).toBe('globetrotter_maya');

    // Strips full URL
    const r2 = await u.tl_host('PATCH', '/me', { instagram: 'https://instagram.com/maya_travels' });
    expect(r2.statusCode).toBe(200);
    const me2 = await u.tl_host('GET', '/me');
    expect(me2.json().instagram).toBe('maya_travels');

    // Clears with null
    const r3 = await u.tl_host('PATCH', '/me', { instagram: null });
    expect(r3.statusCode).toBe(200);
    const me3 = await u.tl_host('GET', '/me');
    expect(me3.json().instagram).toBeNull();

    // Re-set for next tests
    await u.tl_host('PATCH', '/me', { instagram: 'maya_travels' });
  });

  it('shields Instagram from strangers, but shows locked notice', async () => {
    const hostId = await idOf('tl_host');
    const r = await u.tl_stranger('GET', `/users/${hostId}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().instagram).toBeNull();
    expect(r.json().instagramLocked).toBe(true);
    expect(r.json().memberSince).toBeDefined();
  });

  it('reveals Instagram if viewer has Plus or shares a plan', async () => {
    const hostId = await idOf('tl_host');
    const strangerId = await idOf('tl_stranger');

    // Plus user views profile -> instagram is revealed
    await sql`update users set plus_until = now() + interval '1 day' where id = ${strangerId}`;
    const rPlus = await u.tl_stranger('GET', `/users/${hostId}`);
    expect(rPlus.statusCode).toBe(200);
    expect(rPlus.json().instagram).toBe('maya_travels');
    expect(rPlus.json().instagramLocked).toBe(false);

    // Remove Plus
    await sql`update users set plus_until = null where id = ${strangerId}`;
    const rLocked = await u.tl_stranger('GET', `/users/${hostId}`);
    expect(rLocked.json().instagram).toBeNull();
    expect(rLocked.json().instagramLocked).toBe(true);
  });
});

describe('Plan Photo Album & Timeline', () => {
  let activityId: string;

  it('allows plan members to upload and view photos after plan starts', async () => {
    const hostId = await idOf('tl_host');
    const guestId = await idOf('tl_guest');

    // Create a plan that started 1 hour ago
    const [act] = await sql`
      insert into activities (host_id, title, emoji, category, description, place_name, city, starts_at, max_people, location)
      values (${hostId}, 'Sunset Tapas Walk', '🍷', 'food', 'Great tapas', 'El Born', 'Barcelona', now() - interval '1 hour', 6, ST_SetSRID(ST_MakePoint(2.1734, 41.3851), 4326)::geography)
      returning id`;
    activityId = act.id;

    // Join guest to plan
    await sql`insert into activity_members (activity_id, user_id) values (${activityId}, ${hostId}), (${activityId}, ${guestId})`;

    // Upload photo to plan
    const photoRes = await u.tl_guest('POST', `/activities/${activityId}/photos`, {
      url: 'https://images.unsplash.com/photo-1543007630-9710e4a00a20',
      caption: 'Delicious patatas bravas!'
    });
    expect(photoRes.statusCode).toBe(200);
    expect(photoRes.json().ok).toBe(true);
    const photoId = photoRes.json().photo.id;

    // View plan photos
    const listRes = await u.tl_host('GET', `/activities/${activityId}/photos`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().photos.length).toBe(1);
    expect(listRes.json().photos[0].caption).toBe('Delicious patatas bravas!');

    // Stranger cannot upload photo
    const strangerRes = await u.tl_stranger('POST', `/activities/${activityId}/photos`, {
      url: 'https://images.unsplash.com/photo-1543007630-9710e4a00a20'
    });
    expect(strangerRes.statusCode).toBe(403);
  });

  it('returns timeline items for user including trips, plans, and album photos', async () => {
    const hostId = await idOf('tl_host');

    // Add a trip
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date)
      values (${hostId}, 'Rome', 'IT', 'rome-it', '2026-11-01', '2026-11-08')`;

    const r = await u.tl_guest('GET', `/users/${hostId}/timeline`);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.timeline).toBeDefined();
    expect(body.stats.tripsCount).toBeGreaterThanOrEqual(1);
    expect(body.stats.plansHostedCount).toBeGreaterThanOrEqual(1);

    const planItem = body.timeline.find((t: any) => t.kind === 'plan');
    expect(planItem).toBeDefined();
    expect(planItem.photos.length).toBeGreaterThanOrEqual(1);
    expect(planItem.photos[0].url).toContain('unsplash');
  });

  it('respects hide_plan_history privacy toggle', async () => {
    const hostId = await idOf('tl_host');

    // Set hidePlanHistory to true
    await u.tl_host('PATCH', '/me', { hidePlanHistory: true });

    // Stranger views timeline -> plan items hidden
    const rStranger = await u.tl_stranger('GET', `/users/${hostId}/timeline`);
    expect(rStranger.statusCode).toBe(200);
    expect(rStranger.json().planHistoryHidden).toBe(true);
    const strangerPlans = rStranger.json().timeline.filter((t: any) => t.kind === 'plan');
    expect(strangerPlans.length).toBe(0);

    // Host views own timeline -> plan items still visible to self
    const rSelf = await u.tl_host('GET', `/users/${hostId}/timeline`);
    expect(rSelf.statusCode).toBe(200);
    expect(rSelf.json().planHistoryHidden).toBe(false);
    const selfPlans = rSelf.json().timeline.filter((t: any) => t.kind === 'plan');
    expect(selfPlans.length).toBeGreaterThanOrEqual(1);
  });
});
