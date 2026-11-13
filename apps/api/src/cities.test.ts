import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['city_host', 'city_traveler'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@cities.tablamigo`).join(',');
process.env.REVIEW_CODE = '666666';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1200;
async function login(name: string): Promise<Api> {
  const email = `${name}@cities.tablamigo`;
  const remoteAddress = `10.99.3.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '666666' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1996-06-06', gender: 'woman', homeCountry: 'IN' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@cities.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@cities.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
  await sql`update users set plus_until = now() + interval '30 days' where email like '%@cities.tablamigo'`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@cities.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Feature 25: In-App City Guides & Hubs (/cities)', () => {
  it('lists curated cities with metadata', async () => {
    const res = await u.city_host('GET', '/cities');
    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(Array.isArray(json.cities)).toBe(true);
    expect(json.cities.length).toBeGreaterThanOrEqual(8);

    const mumbai = json.cities.find((c: any) => c.slug === 'mumbai');
    expect(mumbai).toBeDefined();
    expect(mumbai.city).toBe('Mumbai');
    expect(mumbai.country).toBe('India');
    expect(mumbai.emoji).toBe('🌊');
  });

  it('fetches specific city guide with upcoming activities and visiting travelers', async () => {
    const hostId = await idOf('city_host');
    const travelerId = await idOf('city_traveler');

    // 1. Host creates a plan in Mumbai
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    const actRes = await u.city_host('POST', '/activities', {
      title: 'Chai & Walk in Fort',
      emoji: '☕',
      category: 'explore',
      placeName: 'Kala Ghoda Cafe',
      lat: 18.9288,
      lng: 72.8331,
      startsAt: tomorrow,
      maxPeople: 6
    });
    expect(actRes.statusCode).toBe(200);

    // 2. Traveler adds a trip to Mumbai
    const tripStart = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    const tripEnd = new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
    const tripRes = await u.city_traveler('POST', '/trips', {
      city: 'Mumbai',
      countryCode: 'IN',
      startDate: tripStart,
      endDate: tripEnd
    });
    expect(tripRes.statusCode).toBe(200);

    // 3. Query GET /cities/mumbai
    const cityRes = await u.city_traveler('GET', '/cities/mumbai');
    expect(cityRes.statusCode).toBe(200);
    const data = cityRes.json();

    expect(data.slug).toBe('mumbai');
    expect(data.city).toBe('Mumbai');
    expect(data.country).toBe('India');
    expect(Array.isArray(data.areas)).toBe(true);
    expect(Array.isArray(data.safety)).toBe(true);
    expect(data.areas.length).toBeGreaterThanOrEqual(1);

    // Verify activity appears in city activities
    const foundAct = data.activities.find((a: any) => a.title === 'Chai & Walk in Fort');
    expect(foundAct).toBeDefined();
    expect(foundAct.host.name).toBe('city_host');

    // Verify visiting traveler appears
    const foundTraveler = data.visitingTravelers.find((t: any) => t.id === travelerId);
    expect(foundTraveler).toBeDefined();
    expect(foundTraveler.name).toBe('city_traveler');
  });

  it('returns 404 for an unknown city slug', async () => {
    const res = await u.city_host('GET', '/cities/atlantis-city');
    expect(res.statusCode).toBe(404);
  });
});
