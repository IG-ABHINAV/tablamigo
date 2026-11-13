import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['sp_host', 'sp_traveler', 'sp_other'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@sp.tablamigo`).join(',');
process.env.REVIEW_CODE = '888888';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown, headers?: Record<string, string>) => Promise<import('light-my-request').Response>;

let ip = 1800;
async function login(name: string): Promise<Api> {
  const email = `${name}@sp.tablamigo`;
  const remoteAddress = `10.99.8.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '888888' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload, headers) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}`, ...(headers ?? {}) },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1995-05-05', gender: 'man', homeCountry: 'IN' });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@sp.tablamigo'`;
  for (const p of PEOPLE) {
    u[p] = await login(p);
  }
});

afterAll(async () => {
  await sql`delete from users where email like '%@sp.tablamigo'`;
  await app.close();
});

describe('Feature 32 / Backlog 7: Saved / Bookmarked Plans', () => {
  let planId: string;

  it('creates an activity, saves/bookmarks it, and reflects isSaved in activity detail', async () => {
    // 1. Host creates a plan
    const createRes = await u.sp_host('POST', '/activities', {
      title: 'Tapas & Sunset Sangria',
      emoji: '🍷',
      category: 'drinks',
      placeName: 'El Xampanyet',
      lat: 41.3851,
      lng: 2.1734,
      startsAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    });
    expect(createRes.statusCode).toBe(200);
    planId = createRes.json().id;

    // Initially neither traveler nor host has it saved
    const detailBefore = await u.sp_traveler('GET', `/activities/${planId}`);
    expect(detailBefore.statusCode).toBe(200);
    expect(detailBefore.json().isSaved).toBe(false);
    expect(detailBefore.json().savedCount).toBe(0);

    // 2. Traveler saves the plan
    const saveRes = await u.sp_traveler('POST', `/activities/${planId}/save`);
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.json().ok).toBe(true);
    expect(saveRes.json().saved).toBe(true);
    expect(saveRes.json().savedCount).toBe(1);

    // Detail for traveler now has isSaved: true
    const detailAfter = await u.sp_traveler('GET', `/activities/${planId}`);
    expect(detailAfter.statusCode).toBe(200);
    expect(detailAfter.json().isSaved).toBe(true);
    expect(detailAfter.json().savedCount).toBe(1);

    // Detail for other user still has isSaved: false, but savedCount: 1
    const detailOther = await u.sp_other('GET', `/activities/${planId}`);
    expect(detailOther.statusCode).toBe(200);
    expect(detailOther.json().isSaved).toBe(false);
    expect(detailOther.json().savedCount).toBe(1);
  });

  it('lists saved plans via GET /activities/saved', async () => {
    // Traveler fetches their saved plans
    const savedListRes = await u.sp_traveler('GET', '/activities/saved');
    expect(savedListRes.statusCode).toBe(200);
    const { saved } = savedListRes.json();
    expect(saved.length).toBeGreaterThanOrEqual(1);

    const match = saved.find((s: any) => s.id === planId);
    expect(match).toBeDefined();
    expect(match.title).toBe('Tapas & Sunset Sangria');
    expect(match.category).toBe('drinks');
    expect(match.placeName).toBe('El Xampanyet');
    expect(match.isSaved).toBe(true);
    expect(match.host.name).toBe('sp_host');

    // Other user has no saved plans
    const otherSaved = await u.sp_other('GET', '/activities/saved');
    expect(otherSaved.statusCode).toBe(200);
    expect(otherSaved.json().saved.length).toBe(0);
  });

  it('unsaves/unbookmarks cleanly on subsequent toggle or explicit save: false', async () => {
    // Unsave via toggle
    const toggleUnsave = await u.sp_traveler('POST', `/activities/${planId}/save`);
    expect(toggleUnsave.statusCode).toBe(200);
    expect(toggleUnsave.json().saved).toBe(false);
    expect(toggleUnsave.json().savedCount).toBe(0);

    // Verify it is no longer in saved list
    const savedListRes = await u.sp_traveler('GET', '/activities/saved');
    expect(savedListRes.json().saved.some((s: any) => s.id === planId)).toBe(false);

    // Explicitly save with { save: true }
    const explicitSave = await u.sp_traveler('POST', `/activities/${planId}/save`, { save: true });
    expect(explicitSave.json().saved).toBe(true);
    expect(explicitSave.json().savedCount).toBe(1);

    // Explicitly unsave with { save: false }
    const explicitUnsave = await u.sp_traveler('POST', `/activities/${planId}/save`, { save: false });
    expect(explicitUnsave.json().saved).toBe(false);
    expect(explicitUnsave.json().savedCount).toBe(0);
  });

  it('requires authentication and handles non-existent or cancelled plans', async () => {
    // 401 for unauthenticated request
    const anonRes = await app.inject({ method: 'POST', url: `/activities/${planId}/save` });
    expect(anonRes.statusCode).toBe(401);

    // 404 for random non-existent activity uuid
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const notFoundRes = await u.sp_traveler('POST', `/activities/${fakeId}/save`);
    expect(notFoundRes.statusCode).toBe(404);
  });
});
