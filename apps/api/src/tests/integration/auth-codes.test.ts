// Email-code sign-in end to end inside the API (lib/auth.ts, routes/auth.ts): the parts the older suites never reached because
// they all sign in with the fixed review code. Wrong-code lockout, expiry, single use, the hourly send cap, a failing email
// provider, the review-code rules, refresh-token rotation, logout, and the Tablamigo Host team account.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const D = '@authcodes.tablamigo';
process.env.REVIEW_EMAILS = `rev${D},REV2${D}`;
process.env.REVIEW_CODE = '246810';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { setMailTransport } = await import('../../lib/mail.js');
const { config } = await import('../../lib/config.js');
const { issueTokens } = await import('../../lib/auth.js');

let app: Awaited<ReturnType<typeof build>>;
type Mail = { to: string; subject: string; text: string; html: string };
let mails: Mail[] = [];
let failMail = false;
let unsent: Mail[] = [];   // emails the failing provider refused: what an attacker would be guessing at
let ipN = 0;
const ip = () => `10.61.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;   // /auth/email/start allows 5 per 10 minutes per IP

const start = (email: string, remoteAddress = ip()) => app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
const verify = (email: string, code: string, remoteAddress = ip()) => app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code }, remoteAddress });
const refresh = (refreshToken: string) => app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken }, remoteAddress: ip() });
const codeFor = (email: string) => {
  const m = [...mails].reverse().find(x => x.to === email.toLowerCase());
  const code = m?.subject.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no code emailed to ${email}`);
  return code;
};
// Sends within 30 s of the last one send nothing new (lib/auth.ts RESEND_COOLDOWN_SEC): "wait 30 seconds" without waiting.
const pastCooldown = (email: string) => sql`update otp_codes set last_sent_at = now() - interval '31 seconds' where email = ${email}`;
const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');

beforeAll(async () => {
  app = await build();
  setMailTransport(async m => { if (failMail) { unsent.push(m as Mail); throw new Error('resend 500: provider down'); } mails.push(m as Mail); return { id: 'test' }; });
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from otp_codes where email like ${'%' + D}`;
});
afterAll(async () => {
  setMailTransport(null);
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from otp_codes where email like ${'%' + D}`;
  await app.close();
  await sql.end();
});
beforeEach(() => { mails = []; unsent = []; failMail = false; });

describe('email code', () => {
  it('is emailed, signs in once, and is used up (a second verify with it is refused)', async () => {
    const e = `ann${D}`;
    expect((await start(e)).json()).toEqual({ ok: true, resent: true, resendIn: 30 });
    const code = codeFor(e);
    expect(mails[0].text).toContain(code);
    const ok = await verify(e, code);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ isNew: true, expiresIn: 1800 });
    expect(ok.json().accessToken).toEqual(expect.any(String));
    expect((await verify(e, code)).json().error).toBe('code_expired');
  });

  it('address case does not matter: one account', async () => {
    await start(`Bea${D}`);
    const r = await verify(`BEA${D}`, codeFor(`bea${D}`));
    expect(r.statusCode).toBe(200);
    expect((await sql`select count(*)::int as n from users where email = ${'bea' + D}`)[0].n).toBe(1);
  });

  it('5 wrong codes lock the code: the right one is then refused too, until a new code is sent', async () => {
    const e = `cat${D}`;
    await start(e);
    const code = codeFor(e);
    for (let i = 0; i < 5; i++) expect((await verify(e, wrongOf(code))).json().error, `try ${i + 1}`).toBe('wrong_code');
    expect((await verify(e, code)).json().error).toBe('too_many_attempts');
    expect((await sql`select attempts from otp_codes where email = ${e}`)[0].attempts).toBe(5);
    // Asked again at once: the cooldown answers with the seconds left and sends nothing; after it, a new code works.
    expect((await start(e)).json()).toMatchObject({ resent: false, resendIn: expect.any(Number) });
    await pastCooldown(e);
    await start(e);
    expect((await verify(e, codeFor(e))).statusCode).toBe(200);
  });

  it('expires after 10 minutes', async () => {
    const e = `dan${D}`;
    await start(e);
    const [row] = await sql`select expires_at - now() as left from otp_codes where email = ${e}`;
    expect(row.left).toMatch(/^00:(09|10):/);
    await sql`update otp_codes set expires_at = now() - interval '1 second' where email = ${e}`;
    expect((await verify(e, codeFor(e))).json().error).toBe('code_expired');
  });

  it('a verify with no code ever sent is code_expired, not a hint that the address exists', async () => {
    expect((await verify(`nobody${D}`, '123456')).json().error).toBe('code_expired');
  });

  it('at most 5 codes an hour per address, whatever the IP; the window then resets', async () => {
    const e = `eve${D}`;
    for (let i = 0; i < 5; i++) { expect((await start(e)).statusCode, `send ${i + 1}`).toBe(200); await pastCooldown(e); }
    const sixth = await start(e);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('too_many_codes');
    expect(mails.filter(m => m.to === e)).toHaveLength(5);
    await sql`update otp_codes set window_start = now() - interval '61 minutes' where email = ${e}`;
    expect((await start(e)).statusCode).toBe(200);
    expect((await sql`select sent_count from otp_codes where email = ${e}`)[0].sentCount).toBe(1);
  });

  it('5 code requests per IP per 10 minutes', async () => {
    const addr = '10.62.0.1';
    for (let i = 0; i < 5; i++) expect((await start(`ip${i}${D}`, addr)).statusCode).toBe(200);
    expect((await start(`ip5${D}`, addr)).json().error).toBe('rate_limited');
  });

  it('when the email provider fails: an error, no code in the response, and a retry at once sends a code (no cooldown)', async () => {
    const e = `fay${D}`;
    failMail = true;
    const r = await start(e);
    expect(r.statusCode).toBe(500);
    expect(r.json()).toEqual({ error: 'server_error' });
    const lost = unsent.find(m => m.to === e)?.subject.match(/\b(\d{6})\b/)?.[1];
    expect(lost).toMatch(/^\d{6}$/);
    // The code that never went out signs nobody in: it was withdrawn, so there is nothing to guess.
    expect((await verify(e, lost!)).json().error).toBe('code_expired');
    failMail = false;
    // Seconds later: a failed send starts no 30-second cooldown (it used to answer resent: false and send nothing).
    const again = await start(e);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ resent: true });
    expect(mails.filter(m => m.to === e)).toHaveLength(1);
    // The failed send still counts toward the 5 an hour.
    expect((await sql`select sent_count from otp_codes where email = ${e}`)[0].sentCount).toBe(2);
    const code = codeFor(e);
    if (code !== lost) expect((await verify(e, lost!)).json().error).toBe('wrong_code');
    expect((await verify(e, code)).statusCode).toBe(200);
  });

  it('a failed send after a delivered code: the delivered code still works, the unsent one does not', async () => {
    const e = `gus${D}`;
    await start(e);
    const delivered = codeFor(e);
    await pastCooldown(e);
    failMail = true;
    expect((await start(e)).statusCode).toBe(500);
    failMail = false;
    const lost = unsent.find(m => m.to === e)!.subject.match(/\b(\d{6})\b/)![1];
    expect((await sql`select sent_count from otp_codes where email = ${e}`)[0].sentCount).toBe(2);
    if (lost !== delivered) expect((await verify(e, lost)).json().error).toBe('wrong_code');
    expect((await verify(e, delivered)).statusCode).toBe(200);
  });

  it('failing sends count toward the 5 codes an hour, so they never buy more rounds of guesses', async () => {
    const e = `hob${D}`;
    failMail = true;
    for (let i = 0; i < 5; i++) expect((await start(e)).statusCode, `send ${i + 1}`).toBe(500);
    failMail = false;
    const sixth = await start(e);
    expect(sixth.statusCode).toBe(429);
    expect(sixth.json().error).toBe('too_many_codes');
    expect(mails.filter(m => m.to === e)).toHaveLength(0);
  });

  it('rejects malformed input with 400 invalid_input', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email: 'not-an-email' } })).json().error).toBe('invalid_input');
    expect((await verify(`ann${D}`, '12345')).json().error).toBe('invalid_input');
    expect((await verify(`ann${D}`, 'abcdef')).json().error).toBe('invalid_input');
  });
});

describe('review accounts (store reviewers: REVIEW_EMAILS + REVIEW_CODE)', () => {
  it('a listed address signs in with the fixed code and gets no email', async () => {
    const e = `rev${D}`;
    await start(e);
    expect(mails).toHaveLength(0);
    expect((await verify(e, '246810')).statusCode).toBe(200);
  });

  it('the list is case-insensitive', async () => {
    await start(`rev2${D}`);
    expect((await verify(`Rev2${D}`, '246810')).statusCode).toBe(200);
  });

  it('the fixed code does nothing for an address that is not listed', async () => {
    const e = `gus${D}`;
    await start(e);
    expect((await verify(e, '246810')).json().error).toBe('wrong_code');
    expect(mails.filter(m => m.to === e)).toHaveLength(1);   // a real, random code went out instead
  });

  it('with REVIEW_CODE empty a listed address gets a normal emailed code and the old fixed code fails', async () => {
    const saved = config.reviewCode;
    config.reviewCode = '';
    try {
      const e = `rev${D}`;
      await start(e);
      const code = codeFor(e);
      if (code !== '246810') expect((await verify(e, '246810')).json().error).toBe('wrong_code');   // 1-in-a-million collision
      expect((await verify(e, code)).statusCode).toBe(200);
    } finally { config.reviewCode = saved; }
  });
});

describe('sessions', () => {
  const signIn = async (name: string) => {
    const e = `${name}${D}`;
    await start(e);
    return (await verify(e, codeFor(e))).json() as { accessToken: string; refreshToken: string };
  };

  it('refresh rotates: the new pair works, the used refresh token is refused', async () => {
    const t = await signIn('hal');
    const r1 = await refresh(t.refreshToken);
    expect(r1.statusCode).toBe(200);
    const t2 = r1.json();
    expect(t2.refreshToken).not.toBe(t.refreshToken);
    expect((await refresh(t.refreshToken)).json().error).toBe('unauthorized');
    expect((await refresh(t2.refreshToken)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${t2.accessToken}` } })).statusCode).toBe(200);
  });

  it('an expired or made-up refresh token is refused', async () => {
    const t = await signIn('ian');
    await sql`update refresh_tokens set expires_at = now() - interval '1 second' where user_id = (select id from users where email = ${'ian' + D})`;
    expect((await refresh(t.refreshToken)).statusCode).toBe(401);
    expect((await refresh('x'.repeat(64))).statusCode).toBe(401);
  });

  it('logout revokes the refresh token it is given (and only for its own account)', async () => {
    const a = await signIn('jo');
    const b = await signIn('kim');
    const auth = (t: string) => ({ authorization: `Bearer ${t}` });
    // Kim cannot revoke Jo's session.
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: auth(b.accessToken), payload: { refreshToken: a.refreshToken } })).json()).toEqual({ ok: true });
    expect((await refresh(a.refreshToken)).statusCode).toBe(200);
    const a2 = await signIn('jo');
    expect((await app.inject({ method: 'POST', url: '/auth/logout', headers: auth(a2.accessToken), payload: { refreshToken: a2.refreshToken } })).json()).toEqual({ ok: true });
    expect((await refresh(a2.refreshToken)).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/auth/logout', payload: {} })).statusCode).toBe(401);
  });

  it('a bad or missing bearer token is 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/me', headers: { authorization: 'Basic abc' } })).statusCode).toBe(401);
  });
});

describe('the Tablamigo Host team account', () => {
  it('gets no code, cannot verify, and its tokens are refused for refresh and every call', async () => {
    const [host] = await sql`select id, email from users where account_kind = 'team'`;
    expect(host, 'migration 059 creates the Host').toBeTruthy();
    expect((await start(host.email)).json()).toEqual({ ok: true, resent: true, resendIn: 30 });   // the same answer as anyone gets
    expect(mails).toHaveLength(0);
    expect((await sql`select 1 from otp_codes where email = ${host.email}`)).toHaveLength(0);
    expect((await verify(host.email, '000000')).json().error).toBe('code_expired');
    const t = await issueTokens(host.id);
    expect((await refresh(t.refreshToken)).statusCode).toBe(401);
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${t.accessToken}` } });
    expect(me.statusCode).toBe(403);
    expect(me.json().error).toBe('team_account');
    await sql`delete from refresh_tokens where user_id = ${host.id}`;
  });
});
