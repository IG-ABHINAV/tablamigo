import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['disp_user'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@disp.tablamigo`).join(',');
process.env.REVIEW_CODE = '888888';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1800;
async function login(name: string): Promise<Api> {
  const email = `${name}@disp.tablamigo`;
  const remoteAddress = `10.99.8.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '888888' }, remoteAddress });
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
  await sql`delete from users where email like '%@disp.tablamigo'`;
  u.disp_user = await login('disp_user');
});

afterAll(async () => {
  await sql`delete from users where email like '%@disp.tablamigo'`;
  await app.close();
});

describe('Backlog 32: Dark Mode & Display Preferences System', () => {
  it('fetches default display preferences via GET /me/display-preferences', async () => {
    const res = await u.disp_user('GET', '/me/display-preferences');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.theme).toBe('system');
    expect(body.oledDark).toBe(false);
    expect(body.mapTheme).toBe('auto');
    expect(body.highContrast).toBe(false);
    expect(body.locale).toBe('en');
  });

  it('updates theme to dark and enables OLED true black via PATCH /me/display-preferences', async () => {
    const res = await u.disp_user('PATCH', '/me/display-preferences', {
      theme: 'dark',
      oledDark: true,
      mapTheme: 'dark',
      highContrast: true,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.preferences.theme).toBe('dark');
    expect(body.preferences.oledDark).toBe(true);
    expect(body.preferences.mapTheme).toBe('dark');
    expect(body.preferences.highContrast).toBe(true);

    // Verify GET /me includes these display preference flags
    const meRes = await u.disp_user('GET', '/me');
    expect(meRes.statusCode).toBe(200);
    const me = meRes.json();
    expect(me.theme).toBe('dark');
    expect(me.oledDark).toBe(true);
    expect(me.mapTheme).toBe('dark');
    expect(me.highContrast).toBe(true);
  });

  it('allows updating display preferences via standard PATCH /me', async () => {
    const res = await u.disp_user('PATCH', '/me', {
      theme: 'light',
      oledDark: false,
      mapTheme: 'light',
      highContrast: false,
    });
    expect(res.statusCode).toBe(200);

    const getRes = await u.disp_user('GET', '/me/display-preferences');
    expect(getRes.statusCode).toBe(200);
    const prefs = getRes.json();
    expect(prefs.theme).toBe('light');
    expect(prefs.oledDark).toBe(false);
    expect(prefs.mapTheme).toBe('light');
    expect(prefs.highContrast).toBe(false);
  });

  it('rejects invalid options with 400', async () => {
    const bad1 = await u.disp_user('PATCH', '/me/display-preferences', { theme: 'cyberpunk' });
    expect(bad1.statusCode).toBe(400);

    const bad2 = await u.disp_user('PATCH', '/me/display-preferences', { mapTheme: 'satellite' });
    expect(bad2.statusCode).toBe(400);
  });
});
