import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['ct_author', 'ct_traveler', 'ct_other'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@ct.tablamigo`).join(',');
process.env.REVIEW_CODE = '777777';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown, headers?: Record<string, string>) => Promise<import('light-my-request').Response>;

let ip = 1900;
async function login(name: string): Promise<Api> {
  const email = `${name}@ct.tablamigo`;
  const remoteAddress = `10.99.9.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '777777' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload, headers) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}`, ...(headers ?? {}) },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1995-05-05', gender: 'woman', homeCountry: 'ES' });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@ct.tablamigo'`;
  for (const p of PEOPLE) {
    u[p] = await login(p);
  }
});

afterAll(async () => {
  await sql`delete from users where email like '%@ct.tablamigo'`;
  await app.close();
});

describe('Feature 25: Community City Tips & Hidden Gems', () => {
  let tipId: string;

  it('allows an onboarded traveler to post a local tip for a city', async () => {
    const postRes = await u.ct_author('POST', '/cities/barcelona/tips', {
      category: 'sunset',
      title: 'Best sunset with cheap drinks',
      body: 'Bunkers del Carmel has panoramic 360 views of Barcelona. Bring your own cold beer and tapas before 7 PM.',
      placeName: 'Bunkers del Carmel',
    });

    expect(postRes.statusCode).toBe(200);
    const tip = postRes.json();
    expect(tip.id).toBeDefined();
    expect(tip.citySlug).toBe('barcelona');
    expect(tip.category).toBe('sunset');
    expect(tip.title).toBe('Best sunset with cheap drinks');
    expect(tip.placeName).toBe('Bunkers del Carmel');
    expect(tip.helpfulCount).toBe(0);
    expect(tip.author.name).toBe('ct_author');
    tipId = tip.id;
  });

  it('lists city tips with category filter and author metadata', async () => {
    // 1. Fetch all tips for barcelona
    const listRes = await u.ct_traveler('GET', '/cities/barcelona/tips');
    expect(listRes.statusCode).toBe(200);
    const { tips } = listRes.json();
    expect(tips.length).toBeGreaterThanOrEqual(1);

    const match = tips.find((t: any) => t.id === tipId);
    expect(match).toBeDefined();
    expect(match.title).toBe('Best sunset with cheap drinks');
    expect(match.hasUpvoted).toBe(false);

    // 2. Filter by category
    const sunsetTips = await u.ct_traveler('GET', '/cities/barcelona/tips?category=sunset');
    expect(sunsetTips.statusCode).toBe(200);
    expect(sunsetTips.json().tips.some((t: any) => t.id === tipId)).toBe(true);

    const foodTips = await u.ct_traveler('GET', '/cities/barcelona/tips?category=food');
    expect(foodTips.statusCode).toBe(200);
    expect(foodTips.json().tips.some((t: any) => t.id === tipId)).toBe(false);
  });

  it('toggles helpful upvotes on a tip and updates counts', async () => {
    // 1. Traveler upvotes tip
    const upvote1 = await u.ct_traveler('POST', `/cities/tips/${tipId}/upvote`);
    expect(upvote1.statusCode).toBe(200);
    expect(upvote1.json().ok).toBe(true);
    expect(upvote1.json().upvoted).toBe(true);
    expect(upvote1.json().helpfulCount).toBe(1);

    // Check list hasUpvoted flag for traveler
    const listAfter = await u.ct_traveler('GET', '/cities/barcelona/tips');
    const tipAfter = listAfter.json().tips.find((t: any) => t.id === tipId);
    expect(tipAfter.hasUpvoted).toBe(true);
    expect(tipAfter.helpfulCount).toBe(1);

    // Check list hasUpvoted flag for other user (should be false)
    const listOther = await u.ct_other('GET', '/cities/barcelona/tips');
    const tipOther = listOther.json().tips.find((t: any) => t.id === tipId);
    expect(tipOther.hasUpvoted).toBe(false);
    expect(tipOther.helpfulCount).toBe(1);

    // 2. Traveler removes upvote
    const upvote2 = await u.ct_traveler('POST', `/cities/tips/${tipId}/upvote`);
    expect(upvote2.statusCode).toBe(200);
    expect(upvote2.json().upvoted).toBe(false);
    expect(upvote2.json().helpfulCount).toBe(0);
  });

  it('validates input length and handles non-existent tip upvote', async () => {
    // Short title -> 400
    const shortRes = await u.ct_author('POST', '/cities/barcelona/tips', {
      category: 'general',
      title: 'hi',
      body: 'This is a long enough body text description.',
    });
    expect(shortRes.statusCode).toBe(400);

    // Fake tip id upvote -> 404
    const fakeId = '00000000-0000-0000-0000-000000000000';
    const notFoundRes = await u.ct_traveler('POST', `/cities/tips/${fakeId}/upvote`);
    expect(notFoundRes.statusCode).toBe(404);
  });
});
