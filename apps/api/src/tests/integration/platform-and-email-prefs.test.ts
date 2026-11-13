// The platform edges every client relies on (/health, /meta, error shapes, body limits, CORS) and the email preferences
// screen (GET/PUT /me/email-prefs), which had no test, together with the unsubscribe links that write the same field.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@prefs.tablamigo';
process.env.REVIEW_EMAILS = ['pia', 'raj'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { unsubscribeToken } = await import('../../lib/emails/send.js');
const { signIn, onboard } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let pia: Person, raj: Person;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  pia = await onboard(await signIn(app, 'pia' + D, '424242', 72), { name: 'Pia', gender: 'woman' });
  raj = await onboard(await signIn(app, 'raj' + D, '424242', 72), { name: 'Raj', gender: 'man' });
});
afterAll(async () => { await sql`delete from users where email like ${'%' + D}`; await app.close(); await sql.end(); });

describe('health and meta', () => {
  it('/health answers 200 with the database up (the uptime monitor and deploy.sh read it)', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, db: 'ok' });
  });

  it('/meta: the onboarding lists and the everything-free switch, no sign-in needed', async () => {
    const m = (await app.inject({ method: 'GET', url: '/meta' })).json();
    expect(Object.keys(m).sort()).toEqual(['allFree', 'interests', 'prompts', 'travelStyles']);
    expect(m.allFree).toBe(false);
    expect(m.interests.length).toBeGreaterThan(5);
    expect(new Set(m.interests.map((i: any) => (typeof i === 'string' ? i : i.id))).size).toBe(m.interests.length);
  });
});

describe('error shapes', () => {
  it('unknown route: 404 JSON', async () => {
    const r = await app.inject({ method: 'GET', url: '/no-such-route' });
    expect(r.statusCode).toBe(404);
    expect(r.headers['content-type']).toMatch(/json/);
  });

  it('broken JSON body: 400 invalid_input, not a 500', async () => {
    const r = await app.inject({ method: 'PATCH', url: '/me', payload: '{"name": ', headers: { authorization: `Bearer ${pia.token}`, 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_input');
  });

  it('a body over 1 MB: 413 too_large', async () => {
    const r = await pia.call('PATCH', '/me', { bio: 'x'.repeat(1_100_000) });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe('too_large');
  });

  it('zod failures name the field', async () => {
    const r = await pia.call('PATCH', '/me', { birthdate: 'yesterday' });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ error: 'invalid_input', issues: [expect.objectContaining({ path: 'birthdate' })] });
  });

  it('outside production any origin may call (the local web app); OPTIONS preflight answers 204', async () => {
    const r = await app.inject({ method: 'OPTIONS', url: '/meta', headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'GET' } });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:8081');
  });
});

describe('email preferences', () => {
  const prefs = async (p: Person) => (await p.call('GET', '/me/email-prefs')).json().prefs;

  it('everything is on for a new account', async () => {
    expect(await prefs(pia)).toEqual({ reminders: true, activity: true, digest: true, all: true });
  });

  it('PUT changes only the fields sent, and only for the caller', async () => {
    expect((await pia.call('PUT', '/me/email-prefs', { digest: false })).json()).toEqual({ ok: true });
    expect(await prefs(pia)).toEqual({ reminders: true, activity: true, digest: false, all: true });
    expect((await pia.call('PUT', '/me/email-prefs', { activity: false, reminders: false })).statusCode).toBe(200);
    expect(await prefs(pia)).toEqual({ reminders: false, activity: false, digest: false, all: true });
    expect(await prefs(raj)).toEqual({ reminders: true, activity: true, digest: true, all: true });
    expect((await pia.call('PUT', '/me/email-prefs', { digest: true })).statusCode).toBe(200);
    expect((await prefs(pia)).digest).toBe(true);
  });

  it('refuses non-boolean values and unknown-only bodies change nothing', async () => {
    expect((await raj.call('PUT', '/me/email-prefs', { digest: 'no' })).statusCode).toBe(400);
    expect((await raj.call('PUT', '/me/email-prefs', { marketing: false })).statusCode).toBe(200);
    expect(await prefs(raj)).toEqual({ reminders: true, activity: true, digest: true, all: true });
    const [{ emailPrefs }] = await sql`select email_prefs from users where id = ${raj.id}`;
    expect(emailPrefs).not.toHaveProperty('marketing');
  });

  it('needs a signed-in user', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/email-prefs' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PUT', url: '/me/email-prefs', payload: { digest: false } })).statusCode).toBe(401);
  });

  it('an unsubscribe link and its undo show up on the preferences screen', async () => {
    const t = unsubscribeToken(raj.id, 'digest');
    const off = await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(t)}` });
    expect(off.statusCode).toBe(200);
    expect(off.headers['cache-control']).toBe('no-store');
    expect((await prefs(raj)).digest).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(t)}&undo=1` })).statusCode).toBe(200);
    expect((await prefs(raj)).digest).toBe(true);
  });

  it('"all" off from a link, then all on again, turns every kind back on', async () => {
    const all = unsubscribeToken(raj.id, 'all');
    await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(all)}` });
    expect((await prefs(raj)).all).toBe(false);
    await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(all)}&undo=1` });
    expect(await prefs(raj)).toEqual({ reminders: true, activity: true, digest: true, all: true });
  });

  it('a made-up or tampered link is a 400 page and changes nothing', async () => {
    const t = unsubscribeToken(raj.id, 'digest');
    for (const bad of ['nonsense', t.slice(0, -2) + (t.endsWith('aa') ? 'bb' : 'aa')]) {
      const r = await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(bad)}` });
      expect(r.statusCode).toBe(400);
      expect(r.body).toContain("This link doesn't work");
    }
    expect((await prefs(raj)).digest).toBe(true);
  });

  it('one-click unsubscribe (RFC 8058 POST) works without a session', async () => {
    const t = unsubscribeToken(raj.id, 'activity');
    const r = await app.inject({ method: 'POST', url: `/email/unsubscribe?t=${encodeURIComponent(t)}`, payload: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.json()).toEqual({ ok: true });
    expect((await prefs(raj)).activity).toBe(false);
  });
});
