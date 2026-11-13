// Admin panel sign-in: codes go only to admins, the answer never reveals who is one, and the admin
// routes never create an account for anyone else. The mailer is a recorder: nothing is sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
process.env.ADMIN_EMAILS = 'chief@adminauth.tablamigo';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const { config } = await import('./lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
const D = '@adminauth.tablamigo';
let sent: { to: string; subject: string }[] = [];
let ip = 0;
const post = (url: string, payload: unknown, remoteAddress = `10.66.0.${++ip}`) => app.inject({ method: 'POST', url, payload: payload as any, remoteAddress });
const codeFor = (to: string) => sent.filter(m => m.to === to).map(m => m.subject.match(/^(\d{6}) /)?.[1]).filter(Boolean).at(-1) as string | undefined;
const clean = async () => { await sql`delete from users where email like ${'%' + D}`; await sql`delete from otp_codes where email like ${'%' + D}`; };

beforeAll(async () => { app = await build(); await clean(); setMailTransport(async m => { sent.push(m); return { id: 'test' }; }); });
// Each test asks for fresh codes: let the 30 s resend cooldown (lib/auth.ts) pass between them.
beforeEach(async () => { sent = []; await sql`update otp_codes set last_sent_at = now() - interval '1 minute' where email like ${'%' + D}`; });
afterAll(async () => { setMailTransport(null); await clean(); await app.close(); await sql.end(); });

describe('admin sign-in', () => {
  it('has no admin by email when ADMIN_EMAILS is unset (no default addresses in code)', async () => {
    const saved = process.env.ADMIN_EMAILS;
    delete process.env.ADMIN_EMAILS;
    vi.resetModules();
    const fresh = (await import('./lib/config.js')).config;
    process.env.ADMIN_EMAILS = saved;
    expect(fresh.adminEmails).toEqual([]);
    expect(config.adminEmails).toEqual(['chief@adminauth.tablamigo']);
  });

  it('a non-admin gets no code, an admin does, and the two answers are identical', async () => {
    const outsider = await post('/admin/auth/start', { email: `nobody${D}` });
    const admin = await post('/admin/auth/start', { email: `Chief${D}` });
    await vi.waitFor(() => expect(codeFor(`chief${D}`)).toMatch(/^\d{6}$/));
    expect(sent.map(m => m.to)).toEqual([`chief${D}`]);
    for (const r of [outsider, admin]) expect({ status: r.statusCode, body: r.body, type: r.headers['content-type'] }).toEqual({ status: 200, body: '{"ok":true}', type: 'application/json; charset=utf-8' });
    // No code was stored for the outsider either, so nothing could be verified with one.
    expect(await sql`select 1 from otp_codes where email = ${'nobody' + D}`).toHaveLength(0);
  });

  it('a role = admin account gets a code; a banned admin does not', async () => {
    await sql`insert into users (email, role) values (${'ops' + D}, 'admin'), (${'gone' + D}, 'admin')`;
    await sql`update users set banned_at = now() where email = ${'gone' + D}`;
    await post('/admin/auth/start', { email: `ops${D}` });
    await post('/admin/auth/start', { email: `gone${D}` });
    await vi.waitFor(() => expect(codeFor(`ops${D}`)).toBeTruthy());
    await new Promise(r => setTimeout(r, 50));
    expect(sent.map(m => m.to)).toEqual([`ops${D}`]);
  });

  it('verify: an admin signs in; a non-admin with a valid app code is refused and no account is made', async () => {
    await post('/admin/auth/start', { email: `chief${D}` });
    await vi.waitFor(() => expect(codeFor(`chief${D}`)).toBeTruthy());
    expect((await post('/admin/auth/verify', { email: `chief${D}`, code: '000000' })).json().error).toBe('wrong_code');
    const ok = await post('/admin/auth/verify', { email: `chief${D}`, code: codeFor(`chief${D}`) });
    expect(ok.statusCode).toBe(200);
    const me = await app.inject({ method: 'GET', url: '/admin/me', headers: { authorization: `Bearer ${ok.json().accessToken}` } });
    expect(me.json().email).toBe(`chief${D}`);   // an ADMIN_EMAILS address gets its account on first sign-in

    // The app's own sign-in hands the outsider a real code...
    await post('/auth/email/start', { email: `outsider${D}` });
    const code = codeFor(`outsider${D}`)!;
    expect(code).toMatch(/^\d{6}$/);
    // ...which the admin route treats as wrong, without creating a user or using the code up.
    const r = await post('/admin/auth/verify', { email: `outsider${D}`, code });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: 'wrong_code' });
    expect(await sql`select 1 from users where email = ${'outsider' + D}`).toHaveLength(0);
    // An address with no code at all reads the same as any expired code.
    expect((await post('/admin/auth/verify', { email: `nobody${D}`, code: '123456' })).json().error).toBe('code_expired');
    // The code still works in the app, where it belongs (and that account is not an admin).
    const app2 = await post('/auth/email/verify', { email: `outsider${D}`, code });
    expect(app2.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/admin/me', headers: { authorization: `Bearer ${app2.json().accessToken}` } })).statusCode).toBe(403);
  });

  it('the account an ADMIN_EMAILS address gets on its first sign-in gets the launch offer too (every way of making an account does)', async () => {
    await sql`delete from users where email = ${'chief' + D}`;
    const end = config.launchPlusUntil = new Date(Math.floor((Date.now() + 20 * 60_000) / 1000) * 1000);
    try {
      await post('/admin/auth/start', { email: `chief${D}` });
      await vi.waitFor(() => expect(codeFor(`chief${D}`)).toBeTruthy());
      expect((await post('/admin/auth/verify', { email: `chief${D}`, code: codeFor(`chief${D}`) })).statusCode).toBe(200);
      expect((await sql`select plus_until, comp_until from users where email = ${'chief' + D}`)[0]).toEqual({ plusUntil: end, compUntil: end });
    } finally { config.launchPlusUntil = null; }
  });

  it('an admin listed only in ADMIN_EMAILS cannot be banned', async () => {
    const [ops] = await sql`select id from users where email = ${'ops' + D}`;
    const [chief] = await sql`select id from users where email = ${'chief' + D}`;
    await sql`update users set role = 'user' where id = ${chief.id}`;
    const tok = (await (async () => {
      await post('/admin/auth/start', { email: `ops${D}` });
      await vi.waitFor(() => expect(codeFor(`ops${D}`)).toBeTruthy());
      return (await post('/admin/auth/verify', { email: `ops${D}`, code: codeFor(`ops${D}`) })).json().accessToken;
    })());
    const r = await app.inject({ method: 'POST', url: `/admin/users/${chief.id}/ban`, headers: { authorization: `Bearer ${tok}` } });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('cannot_ban_admin');
    expect((await sql`select banned_at from users where id = ${chief.id}`)[0].bannedAt).toBeNull();
    expect(ops.id).toBeTruthy();
  });
});
