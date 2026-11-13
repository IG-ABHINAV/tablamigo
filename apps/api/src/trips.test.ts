// Trending cities: counts, date range and the face stack, which never shows hidden people.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
process.env.REVIEW_EMAILS = 'ana@trips.tablamigo,ben@trips.tablamigo,cai@trips.tablamigo,dev@trips.tablamigo,eve@trips.tablamigo,fay@trips.tablamigo';
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
const CITY = { city: 'Tripsville', countryCode: 'UY' };
// "Today" is the database's: trending compares with Postgres current_date, which follows the database's time zone (ahead of
// UTC on the CI runner, IST by the hours it failed), so a UTC date from Date.now() was a day behind late in the UTC day.
let today = '';
const iso = (days: number) => new Date(Date.parse(today) + days * 86400_000).toISOString().slice(0, 10);

// Each login gets its own address: /auth/email/start allows 5 per IP per 10 minutes.
let ip = 0;
async function login(email: string) {
  const remoteAddress = `10.77.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
}

// Trending only lists cities with a guide (6781d5d, 18 Oct), so the test city gets one; without it this test was red on main.
const GUIDE = sql`insert into city_guides (slug, city, country, country_code, emoji, intro) values ('tripsville', 'Tripsville', 'Uruguay', 'UY', '🧪', 'Test guide for trips.test.ts') on conflict (slug) do nothing`;
beforeAll(async () => {
  app = await build(); await sql`delete from users where email like '%@trips.tablamigo'`; await GUIDE;
  [{ today }] = await sql`select current_date::text as today`;
});
afterAll(async () => { await sql`delete from users where email like '%@trips.tablamigo'`; await sql`delete from city_guides where slug = 'tripsville'`; await app.close(); await sql.end(); });

describe('trending trips', () => {
  it('returns up to 3 faces, the date range, and leaves snoozed people out', async () => {
    const plan: [string, number, number][] = [['ana', 5, 9], ['ben', 6, 12], ['cai', 10, 14], ['dev', 2, 20], ['eve', 8, 11]];
    const u: Record<string, Awaited<ReturnType<typeof login>>> = {};
    for (const [name, from, to] of plan) {
      u[name] = await login(`${name}@trips.tablamigo`);
      await u[name]('PATCH', '/me', { name, birthdate: '1992-02-02', gender: 'woman', homeCountry: 'ca' });
      expect((await u[name]('POST', '/trips', { ...CITY, startDate: iso(from), endDate: iso(to) })).statusCode).toBe(200);
    }
    await u.dev('POST', '/me/snooze', { duration: '24h' });
    const fay = await login('fay@trips.tablamigo');
    const city = async () => (await fay('GET', '/trips/trending')).json().cities.find((c: any) => c.cityKey === 'tripsville-uy');

    const c = await city();
    expect(c).toMatchObject({ city: 'Tripsville', countryCode: 'UY', travelers: 4, firstDate: iso(5), lastDate: iso(14) });
    expect(c.faces).toHaveLength(3);
    for (const f of c.faces) expect(Object.keys(f).sort()).toEqual(['id', 'name', 'photoUrl']);
    const [devRow] = await sql`select id from users where email = 'dev@trips.tablamigo'`;
    expect(c.faces.map((f: any) => f.id)).not.toContain(devRow.id);

    // an expired snooze counts again, and a trip that already started clamps to today
    await sql`update users set snoozed_until = now() - interval '1 minute' where id = ${devRow.id}`;
    await sql`update trips set start_date = current_date - 2 where user_id = ${devRow.id}`;
    expect(await city()).toMatchObject({ travelers: 5, firstDate: iso(0), lastDate: iso(20) });

    // indefinite snooze and bans both hide people from the stack and the count
    await sql`update users set snoozed_until = 'infinity' where id = ${devRow.id}`;
    await sql`update users set banned_at = now() where email in ('ana@trips.tablamigo', 'ben@trips.tablamigo')`;
    const after = await city();
    expect(after.travelers).toBe(2);
    expect(after.faces.map((f: any) => f.name).sort()).toEqual(['cai', 'eve']);
  });

  it('city chat for where you are: cached city, same chat on repeat, unknown city refused', async () => {
    const fay = await login('fay@trips.tablamigo');
    await sql`insert into geo_cache (cell, city, country) values ('64.15,-21.95', 'Reykjavík', 'IS') on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = now()`;
    const a = (await fay('POST', '/chats/city-here', { lat: 64.1466, lng: -21.9426 })).json();
    const b = (await fay('POST', '/chats/city-here', { lat: 64.1501, lng: -21.9399 })).json();
    expect(a.city).toBe('Reykjavík'); expect(a.chatId).toBeTruthy(); expect(b.chatId).toBe(a.chatId);
    expect((await fay('GET', '/chats')).json().chats.map((c: any) => c.id)).toContain(a.chatId);
    await sql`insert into geo_cache (cell, city, country) values ('0,0', null, null) on conflict (cell) do nothing`;
    expect((await fay('POST', '/chats/city-here', { lat: 0, lng: 0 })).json().error).toBe('city_unknown');
    await sql`delete from geo_cache where cell in ('64.15,-21.95', '0,0')`;
  });
});
