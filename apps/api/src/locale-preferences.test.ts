import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['loc_user'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@loc.tablamigo`).join(',');
process.env.REVIEW_CODE = '777777';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1900;
async function login(name: string): Promise<Api> {
  const email = `${name}@loc.tablamigo`;
  const remoteAddress = `10.99.9.${++ip}`;
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
  await call('PATCH', '/me', { name, birthdate: '1995-05-05', gender: 'man', homeCountry: 'IN' });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@loc.tablamigo'`;
  u.loc_user = await login('loc_user');
});

afterAll(async () => {
  await sql`delete from users where email like '%@loc.tablamigo'`;
  await app.close();
});

describe('Backlog 32: Language & Regional Locale Preferences', () => {
  it('fetches default locale preferences via GET /me/locale-preferences', async () => {
    const res = await u.loc_user('GET', '/me/locale-preferences');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.locale).toBe('en');
    expect(body.timeFormat).toBe('12h');
    expect(body.currency).toBe('INR');
  });

  it('updates locale to Hindi, 24h time format, and USD via PATCH /me/locale-preferences', async () => {
    const res = await u.loc_user('PATCH', '/me/locale-preferences', {
      locale: 'hi',
      timeFormat: '24h',
      currency: 'USD',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.preferences.locale).toBe('hi');
    expect(body.preferences.timeFormat).toBe('24h');
    expect(body.preferences.currency).toBe('USD');

    // Verify GET /me reflects updated locale preferences
    const meRes = await u.loc_user('GET', '/me');
    expect(meRes.statusCode).toBe(200);
    const me = meRes.json();
    expect(me.locale).toBe('hi');
    expect(me.timeFormat).toBe('24h');
    expect(me.currency).toBe('USD');
  });

  it('allows updating locale preferences via standard PATCH /me', async () => {
    const res = await u.loc_user('PATCH', '/me', {
      locale: 'es',
      timeFormat: '12h',
      currency: 'EUR',
    });
    expect(res.statusCode).toBe(200);

    const getRes = await u.loc_user('GET', '/me/locale-preferences');
    expect(getRes.statusCode).toBe(200);
    const prefs = getRes.json();
    expect(prefs.locale).toBe('es');
    expect(prefs.timeFormat).toBe('12h');
    expect(prefs.currency).toBe('EUR');
  });

  it('rejects invalid locale options with 400', async () => {
    const bad1 = await u.loc_user('PATCH', '/me/locale-preferences', { locale: 'fr' });
    expect(bad1.statusCode).toBe(400);

    const bad2 = await u.loc_user('PATCH', '/me/locale-preferences', { timeFormat: '48h' });
    expect(bad2.statusCode).toBe(400);

    const bad3 = await u.loc_user('PATCH', '/me/locale-preferences', { currency: 'GBP' });
    expect(bad3.statusCode).toBe(400);
  });
});
