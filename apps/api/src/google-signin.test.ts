// POST /auth/google against the local docker Postgres. Google's verifier is mocked: a "token" here is base64 JSON of the
// claims, and the mock enforces the audience the way google-auth-library does.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
process.env.REVIEW_EMAILS = 'coder@gsi.tablamigo';
process.env.REVIEW_CODE = '424242';

const verifyIdToken = vi.fn(async ({ idToken, audience }: { idToken: string; audience: string }) => {
  const claims = JSON.parse(Buffer.from(idToken, 'base64url').toString());
  if (claims.aud !== audience) throw new Error(`Wrong recipient, payload audience != requiredAudience`);
  return { getPayload: () => claims };
});
vi.mock('google-auth-library', async orig => ({ ...(await orig<any>()), OAuth2Client: class { verifyIdToken = verifyIdToken; } }));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config } = await import('./lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
const WEB = '316890004786-11d9pklbq4phqa7vk3a99vfiol2qsc1s.apps.googleusercontent.com';
const token = (c: Record<string, unknown>) =>
  Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: WEB, sub: String(Math.random()), email_verified: true, ...c })).toString('base64url');
let ip = 10;
const google = (claims: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/auth/google', payload: { idToken: token(claims) }, remoteAddress: `10.9.0.${ip++}` });
const me = (accessToken: string) => app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${accessToken}` } });

beforeAll(async () => { app = await build(); await sql`delete from users where email like '%@gsi.tablamigo'`; });
afterAll(async () => { await sql`delete from users where email like '%@gsi.tablamigo'`; await app.close(); await sql.end(); });

describe('POST /auth/google', () => {
  it('uses the web client id as the audience by default', () => {
    expect(config.googleWebClientId).toBe(WEB);
  });

  it('creates a new account, prefills the name and sends it to onboarding', async () => {
    const r = await google({ email: 'New.Person@GSI.tablamigo', name: 'New Person', given_name: 'New' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body).toMatchObject({ isNew: true, expiresIn: expect.any(Number) });
    expect(body.accessToken).toBeTruthy(); expect(body.refreshToken).toBeTruthy();
    expect(verifyIdToken).toHaveBeenLastCalledWith(expect.objectContaining({ audience: WEB }));
    const profile = (await me(body.accessToken)).json();
    expect(profile.email).toBe('new.person@gsi.tablamigo');
    expect(profile.name).toBe('New');   // first name, like onboarding asks for
    // The refresh token works like one from an email code.
    const ref = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: body.refreshToken } });
    expect(ref.statusCode).toBe(200);
  });

  it('signs an email-code user into the same account', async () => {
    await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email: 'coder@gsi.tablamigo' }, remoteAddress: '10.9.1.1' });
    const byCode = (await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email: 'coder@gsi.tablamigo', code: '424242' }, remoteAddress: '10.9.1.1' })).json();
    const codeId = (await me(byCode.accessToken)).json().id;
    await app.inject({ method: 'PATCH', url: '/me', headers: { authorization: `Bearer ${byCode.accessToken}` }, payload: { name: 'Coder', birthdate: '1990-01-01', gender: 'woman', homeCountry: 'in' } });

    const r = await google({ email: 'CODER@gsi.tablamigo', name: 'Some Other Name' });
    expect(r.statusCode).toBe(200);
    expect(r.json().isNew).toBe(false);   // onboarded already: straight to the app
    const profile = (await me(r.json().accessToken)).json();
    expect(profile.id).toBe(codeId);
    expect(profile.name).toBe('Coder');   // Google never overwrites a profile
  });

  it('refuses an unverified email', async () => {
    const r = await google({ email: 'unverified@gsi.tablamigo', email_verified: false });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('google_email_unverified');
    expect((await sql`select 1 from users where email = 'unverified@gsi.tablamigo'`).length).toBe(0);
  });

  it('refuses a token minted for another client', async () => {
    const r = await google({ email: 'elsewhere@gsi.tablamigo', aud: '999-other.apps.googleusercontent.com' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('google_token_invalid');
    expect((await sql`select 1 from users where email = 'elsewhere@gsi.tablamigo'`).length).toBe(0);
  });

  it('refuses a banned user', async () => {
    await sql`insert into users (email, banned_at) values ('banned@gsi.tablamigo', now())`;
    const r = await google({ email: 'banned@gsi.tablamigo' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('banned');
  });

  it('never signs in as the Tablamigo Host team account, and keeps no team-like name from Google', async () => {
    const host = await google({ email: 'host@team.tablamigo', name: 'Tablamigo Host' });
    expect(host.statusCode).toBe(403);
    expect(host.json().error).toBe('team_account');
    const r = await google({ email: 'lookalike@gsi.tablamigo', name: 'Tablamigo Host (Team)', given_name: 'Tablamigo' });
    expect(r.statusCode).toBe(200);
    expect((await me(r.json().accessToken)).json().name).toBeNull();   // onboarding asks for a name, which PATCH /me checks
  });

  it('starts a deleted account fresh', async () => {
    const [old] = await sql`insert into users (email, name, onboarded, deleted_at) values ('gone@gsi.tablamigo', 'Old', true, now()) returning id`;
    const r = await google({ email: 'gone@gsi.tablamigo' });
    expect(r.statusCode).toBe(200);
    expect(r.json().isNew).toBe(true);
    expect((await me(r.json().accessToken)).json().id).not.toBe(old.id);
  });

  it('rejects a missing token and rate-limits like /auth/email/start', async () => {
    expect((await app.inject({ method: 'POST', url: '/auth/google', payload: {}, remoteAddress: '10.9.2.1' })).statusCode).toBe(400);
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      codes.push((await app.inject({ method: 'POST', url: '/auth/google', payload: { idToken: token({ email: 'burst@gsi.tablamigo' }) }, remoteAddress: '10.9.3.1' })).statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
  });
});
