import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['fhn_alice', 'fhn_bob', 'fhn_charlie'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@fhn.tablamigo`).join(',');
process.env.REVIEW_CODE = '777777';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1400;
async function login(name: string): Promise<Api> {
  const email = `${name}@fhn.tablamigo`;
  const remoteAddress = `10.99.4.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '777777' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1995-05-15', gender: 'woman', homeCountry: 'IN' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@fhn.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@fhn.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
  await sql`update users set plus_until = now() + interval '30 days' where email like '%@fhn.tablamigo'`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@fhn.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Feature 21: Friends & Follow Feed (/connections/trips)', () => {
  it('connects Alice and Bob, then returns Bob upcoming trips and excludes non-friends and past trips', async () => {
    const aliceId = await idOf('fhn_alice');
    const bobId = await idOf('fhn_bob');
    const charlieId = await idOf('fhn_charlie');

    // Alice connects with Bob
    const connectRes = await u.fhn_alice('POST', `/users/${bobId}/connect`);
    expect(connectRes.statusCode).toBe(200);
    expect(connectRes.json().connected).toBe(false);
    // Not connected (and no friend's trips) until Bob accepts.
    expect((await u.fhn_alice('GET', '/connections/trips')).json().trips).toHaveLength(0);
    const reqs = (await u.fhn_bob('GET', '/connections/requests')).json();
    expect(reqs.received).toHaveLength(1);
    expect((await u.fhn_bob('POST', `/connections/requests/${reqs.received[0].id}/respond`, { action: 'accept' })).json().connected).toBe(true);

    // Bob posts an upcoming trip to Goa (30 days from now)
    const futureStart = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const futureEnd = new Date(Date.now() + 37 * 86400000).toISOString().slice(0, 10);
    const tripBobFuture = await u.fhn_bob('POST', '/trips', {
      city: 'Goa',
      countryCode: 'IN',
      startDate: futureStart,
      endDate: futureEnd
    });
    expect(tripBobFuture.statusCode).toBe(200);

    // Bob also posts a past trip to Manali (ended 60 days ago)
    const pastStart = new Date(Date.now() - 70 * 86400000).toISOString().slice(0, 10);
    const pastEnd = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date)
              values (${bobId}, 'Manali', 'IN', 'manali', ${pastStart}, ${pastEnd})`;

    // Charlie (not connected to Alice) adds an upcoming trip to Bali
    await u.fhn_charlie('POST', '/trips', {
      city: 'Bali',
      countryCode: 'ID',
      startDate: futureStart,
      endDate: futureEnd
    });

    // Alice requests /connections/trips
    const res = await u.fhn_alice('GET', '/connections/trips');
    expect(res.statusCode).toBe(200);
    const { trips } = res.json();
    expect(Array.isArray(trips)).toBe(true);

    // Should include Bob's Goa trip
    const bobTrip = trips.find((t: any) => t.friendId === bobId);
    expect(bobTrip).toBeDefined();
    expect(bobTrip.city).toBe('Goa');
    expect(bobTrip.countryCode).toBe('IN');
    expect(bobTrip.friendName).toBe('fhn_bob');
    expect(bobTrip.isOverlapping).toBe(false);

    // Should NOT include Bob's past trip to Manali
    const pastTrip = trips.find((t: any) => t.city === 'Manali');
    expect(pastTrip).toBeUndefined();

    // Should NOT include Charlie's trip because Alice is not connected with Charlie
    const charlieTrip = trips.find((t: any) => t.friendId === charlieId);
    expect(charlieTrip).toBeUndefined();

    // Now Alice ALSO adds an overlapping trip to Goa
    await u.fhn_alice('POST', '/trips', {
      city: 'Goa',
      countryCode: 'IN',
      startDate: futureStart,
      endDate: futureEnd
    });

    // Alice checks /connections/trips again -> isOverlapping should now be true!
    const resAfterOverlap = await u.fhn_alice('GET', '/connections/trips');
    const bobTripAfter = resAfterOverlap.json().trips.find((t: any) => t.friendId === bobId);
    expect(bobTripAfter.isOverlapping).toBe(true);
  });
});

describe('Feature 22: "Who is Here Now" & Snooze Settings', () => {
  it('manages caller here-now settings, status, and snooze', async () => {
    // 1. Check default settings
    const defRes = await u.fhn_bob('GET', '/me/here-now');
    expect(defRes.statusCode).toBe(200);
    // Off until the person turns it on (migration 053): nobody is listed by default.
    expect(defRes.json().optIn).toBe(false);
    expect((await sql`select here_now_opt_in from users where email = 'fhn_bob@fhn.tablamigo'`)[0].hereNowOptIn).toBe(false);
    expect(defRes.json().isSnoozed).toBe(false);

    // 2. Set status and snooze for 24 hours
    const putRes = await u.fhn_bob('PUT', '/me/here-now', {
      status: 'Working from cafe ☕',
      snoozeHours: 24
    });
    expect(putRes.statusCode).toBe(200);
    expect(putRes.json().status).toBe('Working from cafe ☕');
    expect(putRes.json().isSnoozed).toBe(true);
    expect(putRes.json().snoozeUntil).toBeDefined();

    // 3. Clear snooze (snoozeHours = 0)
    const clearRes = await u.fhn_bob('PUT', '/me/here-now', {
      snoozeHours: 0
    });
    expect(clearRes.statusCode).toBe(200);
    expect(clearRes.json().isSnoozed).toBe(false);
    expect(clearRes.json().status).toBe('Working from cafe ☕');
  });

  it('lists travelers currently in a city and respects snooze / opt-out', async () => {
    const bobId = await idOf('fhn_bob');
    const charlieId = await idOf('fhn_charlie');

    // Set Bob's resident city to Goa, opt-in true, not snoozed
    await sql`update users set city = 'Goa', here_now_opt_in = true, here_now_snooze_until = null, here_now_status = 'Sunset at Anjuna 🌅' where id = ${bobId}`;

    // Set Charlie with an active trip in Goa today. The database's today: here-now compares with Postgres current_date, so a
    // UTC date from new Date() missed it late in the UTC day on the CI runner, whose database is ahead of UTC.
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date)
              values (${charlieId}, 'Goa', 'IN', 'goa', current_date, current_date)`;
    await sql`update users set here_now_opt_in = true, here_now_snooze_until = null, here_now_status = 'Exploring local markets 🛍️' where id = ${charlieId}`;

    // Query /cities/goa/here-now
    const res = await u.fhn_alice('GET', '/cities/goa/here-now');
    expect(res.statusCode).toBe(200);
    const { travelers, count } = res.json();
    expect(count).toBeGreaterThanOrEqual(2);

    const bobInList = travelers.find((t: any) => t.id === bobId);
    expect(bobInList).toBeDefined();
    expect(bobInList.status).toBe('Sunset at Anjuna 🌅');

    const charlieInList = travelers.find((t: any) => t.id === charlieId);
    expect(charlieInList).toBeDefined();
    expect(charlieInList.status).toBe('Exploring local markets 🛍️');

    // Now Bob snoozes for 48 hours
    await u.fhn_bob('PUT', '/me/here-now', { snoozeHours: 48 });

    // Query again: Bob should be hidden, Charlie should still be present
    const resSnoozed = await u.fhn_alice('GET', '/cities/goa/here-now');
    const travelersSnoozed = resSnoozed.json().travelers;
    expect(travelersSnoozed.find((t: any) => t.id === bobId)).toBeUndefined();
    expect(travelersSnoozed.find((t: any) => t.id === charlieId)).toBeDefined();
  });

  it('exploit: the city endpoints need a signed-in user and hide opted-out, snoozed, incognito and blocked people', async () => {
    const bobId = await idOf('fhn_bob');
    const charlieId = await idOf('fhn_charlie');
    await sql`update users set city = 'Goa', here_now_opt_in = true, here_now_snooze_until = null, snoozed_until = null, is_incognito = false where id in (${bobId}, ${charlieId})`;
    await sql`delete from blocks where blocker_id in (${bobId}, ${charlieId}) or blocked_id in (${bobId}, ${charlieId})`;
    const ids = async () => ((await u.fhn_alice('GET', '/cities/goa/here-now')).json().travelers as any[]).map(t => t.id);
    expect(await ids()).toEqual(expect.arrayContaining([bobId, charlieId]));

    // No token: 401 on the city page and on here-now (they returned names, photos and ages to anyone before).
    for (const url of ['/cities/goa', '/cities/goa/here-now', '/cities/mumbai/here-now', '/cities/pathankot/here-now']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    // A slug that isn't a city guide is not a city page (it used to fall back to any raw city name).
    expect((await u.fhn_alice('GET', '/cities/pathankot/here-now')).statusCode).toBe(404);

    // The general snooze (Travelers and map) hides you here too.
    await sql`update users set snoozed_until = now() + interval '1 day' where id = ${bobId}`;
    expect(await ids()).not.toContain(bobId);
    await sql`update users set snoozed_until = null where id = ${bobId}`;

    // Incognito.
    await sql`update users set is_incognito = true where id = ${bobId}`;
    expect(await ids()).not.toContain(bobId);
    await sql`update users set is_incognito = false where id = ${bobId}`;

    // A block, either way.
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${bobId}, 'Goa', 'IN', 'goa', current_date, current_date)`;
    expect(((await u.fhn_alice('GET', '/cities/goa')).json().visitingTravelers as any[]).map(t => t.id)).toContain(bobId);
    await u.fhn_bob('POST', `/blocks/${await idOf('fhn_alice')}`);
    expect(await ids()).not.toContain(bobId);
    const guide = (await u.fhn_alice('GET', '/cities/goa')).json();
    expect((guide.visitingTravelers as any[]).map(t => t.id)).not.toContain(bobId);
    await u.fhn_bob('DELETE', `/blocks/${await idOf('fhn_alice')}`);

    // Opting out.
    await u.fhn_charlie('PUT', '/me/here-now', { optIn: false });
    expect(await ids()).not.toContain(charlieId);
    expect(await ids()).toContain(bobId);
  });
});
