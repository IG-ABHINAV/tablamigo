import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['up_user'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@up.tablamigo`).join(',');
process.env.REVIEW_CODE = '999999';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown, headers?: Record<string, string>) => Promise<import('light-my-request').Response>;

let ip = 1700;
async function login(name: string): Promise<Api> {
  const email = `${name}@up.tablamigo`;
  const remoteAddress = `10.99.7.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '999999' }, remoteAddress });
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
  await sql`delete from users where email like '%@up.tablamigo'`;
  u.up_user = await login('up_user');
});

afterAll(async () => {
  await sql`delete from users where email like '%@up.tablamigo'`;
  await app.close();
});

describe('Feature 32: User Preferences (Dark Mode & UI Locale)', () => {
  it('defaults to system theme and en locale, and allows updating to dark theme and Hindi locale', async () => {
    // 1. Initial defaults
    const meRes1 = await u.up_user('GET', '/me');
    expect(meRes1.statusCode).toBe(200);
    const me1 = meRes1.json();
    expect(me1.theme).toBe('system');
    expect(me1.locale).toBe('en');

    // 2. Update to dark theme and Hindi
    const patchRes1 = await u.up_user('PATCH', '/me', {
      theme: 'dark',
      locale: 'hi',
    });
    expect(patchRes1.statusCode).toBe(200);

    // 3. Verify changes persisted in GET /me
    const meRes2 = await u.up_user('GET', '/me');
    expect(meRes2.statusCode).toBe(200);
    const me2 = meRes2.json();
    expect(me2.theme).toBe('dark');
    expect(me2.locale).toBe('hi');

    // 4. Update to Spanish and light theme
    const patchRes2 = await u.up_user('PATCH', '/me', {
      theme: 'light',
      locale: 'es',
    });
    expect(patchRes2.statusCode).toBe(200);

    const meRes3 = await u.up_user('GET', '/me');
    expect(meRes3.statusCode).toBe(200);
    const me3 = meRes3.json();
    expect(me3.theme).toBe('light');
    expect(me3.locale).toBe('es');
  });

  it('rejects invalid theme or locale options with 400', async () => {
    const badTheme = await u.up_user('PATCH', '/me', { theme: 'neon' });
    expect(badTheme.statusCode).toBe(400);

    const badLocale = await u.up_user('PATCH', '/me', { locale: 'xx' });
    expect(badLocale.statusCode).toBe(400);
  });
});
