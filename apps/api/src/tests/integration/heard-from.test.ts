// POST /me/heard-from (onboarding's "How did you hear about us?"): each answer is stored on the user with a time and an
// analytics event, Skip is stored as 'skipped', the latest answer wins, anything else is refused, and it needs a sign-in.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@heard.tablamigo';
process.env.REVIEW_EMAILS = ['ivy', 'jon'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '616161';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { HEARD_FROM } = await import('../../lib/heard-from.js');
const { signIn, onboard } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let ivy: Person, jon: Person;
const row = async (id: string) => (await sql`select heard_from, heard_from_at from users where id = ${id}`)[0];

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  ivy = await onboard(await signIn(app, 'ivy' + D, '616161', 91), { name: 'Ivy', gender: 'woman' });
  jon = await signIn(app, 'jon' + D, '616161', 91);
});
afterAll(async () => { await sql`delete from users where email like ${'%' + D}`; await app.close(); await sql.end(); });

describe('POST /me/heard-from', () => {
  it('a new account has not been asked', async () => {
    expect((await row(jon.id)).heardFrom).toBeNull();
  });

  it('stores the answer with a time and one heard_from event', async () => {
    const r = await jon.call('POST', '/me/heard-from', { source: 'tiktok' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ok: true, heardFrom: 'tiktok' });
    const u = await row(jon.id);
    expect(u.heardFrom).toBe('tiktok');
    expect(Date.now() - new Date(u.heardFromAt).getTime()).toBeLessThan(60_000);
    const ev = await sql`select properties from analytics_events where user_id = ${jon.id} and event_name = 'heard_from'`;
    expect(ev.map(e => e.properties)).toEqual([{ source: 'tiktok' }]);
  });

  it('accepts every listed answer and Skip; the latest wins', async () => {
    for (const source of [...HEARD_FROM, 'skipped']) {
      expect((await ivy.call('POST', '/me/heard-from', { source })).statusCode).toBe(200);
      expect((await row(ivy.id)).heardFrom).toBe(source);
    }
  });

  it('refuses an answer that is not on the list, or none, and changes nothing', async () => {
    for (const body of [{ source: 'facebook' }, { source: '' }, {}, { source: 'INSTAGRAM' }]) {
      expect((await jon.call('POST', '/me/heard-from', body)).statusCode).toBe(400);
    }
    expect((await row(jon.id)).heardFrom).toBe('tiktok');
  });

  it('needs a sign-in', async () => {
    const r = await app.inject({ method: 'POST', url: '/me/heard-from', payload: { source: 'google' } });
    expect(r.statusCode).toBe(401);
  });

  it('the database refuses a value outside the list even without the route', async () => {
    await expect(sql`update users set heard_from = 'myspace' where id = ${jon.id}`).rejects.toThrow(/check/i);
  });
});
