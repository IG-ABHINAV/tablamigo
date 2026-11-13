import { describe, it, expect, beforeAll, afterAll } from 'vitest';

// A place link from a feed moment or a plan ('📍 Mapusa') opens /city/<key> in the app. Only 42 places have a curated
// guide; any other place people really posted from answers with its upcoming plans (guide: false) instead of 404, and
// lists no people: no visiting travellers and no here-now, which stay with the guides.
const PEOPLE = ['place_host', 'place_traveller', 'place_shy'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@places.tablamigo`).join(',');
process.env.REVIEW_CODE = '666666';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 40;
async function login(name: string): Promise<Api> {
  const email = `${name}@places.tablamigo`;
  const remoteAddress = `10.99.41.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '666666' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1995-05-05', gender: 'man', homeCountry: 'IN' });
  return call;
}
const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@places.tablamigo'}`)[0].id as string;
const u: Record<string, Api> = {};
let planId = '';

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@places.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
  await sql`update users set onboarded = true where email like '%@places.tablamigo'`;
  const host = await idOf('place_host'), trav = await idOf('place_traveller'), shy = await idOf('place_shy');
  // A moment posted in Mapusa (no guide), and one with no place at all.
  await sql`insert into moments (user_id, city, country_code, image_url, caption) values (${host}, 'Mapusa', 'IN', 'https://x.test/a.jpg', 'Friday market')`;
  await sql`insert into moments (user_id, city, country_code, image_url, caption) values (${host}, 'Worldwide', 'IN', 'https://x.test/b.jpg', 'somewhere')`;
  // A plan there (the city is what the geocoder would have written).
  const r = await u.place_host('POST', '/activities', { title: 'Market breakfast', emoji: '🥐', category: 'food', placeName: 'Mapusa Market', lat: 15.5937, lng: 73.8143, startsAt: new Date(Date.now() + 20 * 3600e3).toISOString(), maxPeople: 6 });
  expect(r.statusCode).toBe(200);
  planId = r.json().id ?? r.json().activity?.id;
  await sql`update activities set city = 'Mapusa' where id = ${planId}`;
  // Two travellers there today; only one turned on "Who's here now".
  await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values
    (${trav}, 'Mapusa', 'IN', 'mapusa-in', current_date, current_date + 3),
    (${shy}, 'Mapusa', 'IN', 'mapusa-in', current_date, current_date + 3)`;
  await sql`update users set here_now_opt_in = true where id = ${trav}`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@places.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('place pages for places without a city guide', () => {
  it('answers /cities/mapusa-in with the plans there, marked as no guide, and no people', async () => {
    const r = await u.place_shy('GET', '/cities/mapusa-in');
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.guide).toBe(false);
    expect(d.city).toBe('Mapusa');
    expect(d.countryCode).toBe('IN');
    expect(d.chatId).toBeNull();
    expect(d.intro).toBeNull();
    expect(d.activities.map((a: any) => a.id)).toContain(planId);
    expect(d.visitingTravelers).toEqual([]);
    expect(d.travelersCount).toBe(0);
  });

  it('also finds it by the bare name, the way a link without a country is built', async () => {
    const r = await u.place_shy('GET', '/cities/mapusa');
    expect(r.statusCode).toBe(200);
    expect(r.json().city).toBe('Mapusa');
  });

  it('has no here-now list: that stays with the curated guides', async () => {
    expect((await u.place_host('GET', '/cities/mapusa-in/here-now')).statusCode).toBe(404);
  });

  it('opens no city chat for a place without a guide', async () => {
    const r = await u.place_traveller('POST', '/cities/mapusa-in/join-chat', {});
    expect(r.statusCode).toBe(404);
  });

  it('is still 404 for a place nobody posted from, and for the "Worldwide" fallback', async () => {
    expect((await u.place_host('GET', '/cities/nowhere-xx')).statusCode).toBe(404);
    expect((await u.place_host('GET', '/cities/worldwide')).statusCode).toBe(404);
  });

  it('a bare name ending in a 2-letter word is still that name, and a wrong country is not the place', async () => {
    await sql`insert into moments (user_id, city, country_code, image_url, caption) values (${await idOf('place_host')}, 'Hoi An', 'VN', 'https://x.test/h.jpg', 'lanterns')`;
    expect((await u.place_host('GET', '/cities/hoi-an')).json().city).toBe('Hoi An');
    expect((await u.place_host('GET', '/cities/hoi-an-vn')).json().city).toBe('Hoi An');
    expect((await u.place_host('GET', '/cities/mapusa-fr')).statusCode).toBe(404);
  });

  it("a banned account's trip alone doesn't make a place page, and signed out is 401", async () => {
    const shy = await idOf('place_shy');
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${shy}, 'Ghostville', 'IN', 'ghostville-in', current_date, current_date + 2)`;
    await sql`update users set banned_at = now() where id = ${shy}`;
    try {
      expect((await u.place_host('GET', '/cities/ghostville-in')).statusCode).toBe(404);
    } finally {
      await sql`update users set banned_at = null where id = ${shy}`;
    }
    expect((await app.inject({ method: 'GET', url: '/cities/mapusa-in' })).statusCode).toBe(401);
  });

  it('keeps a curated guide a guide, with its travellers', async () => {
    const trav = await idOf('place_traveller');
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${trav}, 'Goa', 'IN', 'goa-in', current_date, current_date + 2)`;
    const r = await u.place_host('GET', '/cities/goa-in');
    expect(r.statusCode).toBe(200);
    expect(r.json().guide).toBe(true);
    expect(r.json().intro).toBeTruthy();
    expect(r.json().visitingTravelers.map((t: any) => t.id)).toContain(trav);
  });

  it("never lists the viewer in their own city's here-now", async () => {
    const trav = await idOf('place_traveller');
    await sql`update users set city = 'Goa' where id = ${trav}`;
    const ids = async (as: Api) => ((await as('GET', '/cities/goa/here-now')).json().travelers as any[]).map(t => t.id);
    expect(await ids(u.place_host)).toContain(trav);
    expect(await ids(u.place_traveller)).not.toContain(trav);
  });
});
