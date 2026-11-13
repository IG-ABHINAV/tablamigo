// Invite links that work (1 Nov 2026). GET /me/referral used to hand out https://tablamigo.hookstep.in/r/<code>, which the website
// never served (404), and a friend who did install had to find "Profile > Invite friends" and type the code. Now the link is the
// website's /invite?code=… page, which puts the code in the Play install referrer (`ref`) or the web app's ?ref=, and the sign-in
// that creates the account redeems it (lib/referral.ts autoRedeemAtSignup). The manual redeem keeps working, through the same service.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const D = '@invite.tablamigo';
process.env.REVIEW_EMAILS = [`ref1${D}`, `new1${D}`, `new2${D}`, `new3${D}`, `new4${D}`, `old1${D}`, `new5${D}`, `cap${D}`].join(',');
process.env.REVIEW_CODE = '246810';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { REFERRAL } = await import('../../lib/plus.js');
const { inviteLink } = await import('../../lib/referral.js');
const { signIn } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let n = 0;
const ip = () => `10.91.${Math.floor(++n / 250) % 250}.${(n % 250) + 1}`;

/** Sign up through POST /auth/email/verify the way the apps do, with whatever the app adds to the body. */
async function signUp(email: string, extra: Record<string, unknown> = {}) {
  const remoteAddress = ip();
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '246810', ...extra }, remoteAddress });
  expect(r.statusCode, r.body).toBe(200);
  const [u] = await sql`select id, referred_by, comp_until, plus_until, attribution from users where email = ${email}`;
  return u;
}
const plusDaysLeft = (d: Date | null) => d ? Math.round((new Date(d).getTime() - Date.now()) / 86_400_000) : 0;

let referrer: { id: string; code: string };

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  const p = await signIn(app, `ref1${D}`, '246810', 91);
  const r = await p.call('GET', '/me/referral');
  referrer = { id: p.id, code: r.json().referralCode };
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await app.close();
});

describe('the invite link', () => {
  it('is the website invite page with the code, not the old /r/ path', async () => {
    const [u] = await sql`select referral_code from users where id = ${referrer.id}`;
    expect(referrer.code).toBe(u.referralCode);
    expect(inviteLink(referrer.code)).toBe(`https://tablamigo.hookstep.in/invite?code=${referrer.code}`);
    const p = await signIn(app, `ref1${D}`, '246810', 91);
    const body = (await p.call('GET', '/me/referral')).json();
    expect(body.referralLink).toBe(inviteLink(referrer.code));
    expect(body.referralLink).not.toContain('/r/');
  });
});

describe('sign-up with an invite code redeems it', () => {
  it('Android: the code in the Play install referrer gives both people the invite days', async () => {
    const before = (await sql`select comp_until from users where id = ${referrer.id}`)[0].compUntil;
    const u = await signUp(`new1${D}`, { install_referrer: `utm_source=invite&utm_medium=referral&ref=${referrer.code.toLowerCase()}` });
    expect(u.referredBy).toBe(referrer.id);
    expect(plusDaysLeft(u.plusUntil)).toBe(REFERRAL.rewardDays);
    expect(u.attribution.source).toBe('invite');
    const after = (await sql`select comp_until, plus_until from users where id = ${referrer.id}`)[0];
    expect(new Date(after.compUntil).getTime()).toBeGreaterThan(before ? new Date(before).getTime() : 0);
    expect(plusDaysLeft(after.plusUntil)).toBeGreaterThanOrEqual(REFERRAL.rewardDays);
    const [ev] = await sql`select properties from analytics_events where user_id = ${u.id} and event_name = 'referral_auto_redeemed'`;
    expect(ev.properties.code).toBe(referrer.code);
    // Both get the in-app notice, as with a typed code.
    const notes = await sql`select user_id from notifications where user_id in (${u.id}, ${referrer.id}) and kind = 'plus'`;
    expect(new Set(notes.map(x => x.userId))).toEqual(new Set([u.id, referrer.id]));
  });

  it('web app: ref_code in the sign-in body', async () => {
    const u = await signUp(`new2${D}`, { ref_code: referrer.code, utm_source: 'invite', landing: `/app/?ref=${referrer.code}` });
    expect(u.referredBy).toBe(referrer.id);
    expect(u.attribution.landing).toBe(`/app/?ref=${referrer.code}`);
  });

  it('a bad or unknown code never blocks the sign-up', async () => {
    for (const [email, extra] of [[`new3${D}`, { ref_code: 'NOSUCH99' }], [`new4${D}`, { install_referrer: 'ref=<script>&utm_source=invite' }]] as const) {
      const u = await signUp(email, extra);
      expect(u.id).toBeTruthy();
      expect(u.referredBy).toBeNull();
      expect(u.compUntil).toBeNull();
    }
  });

  it('an existing account signing in again with a code is not referred (invites are for new accounts)', async () => {
    const first = await signUp(`old1${D}`);
    expect(first.referredBy).toBeNull();
    const again = await signUp(`old1${D}`, { ref_code: referrer.code });
    expect(again.referredBy).toBeNull();
  });

  it('your own code at sign-up does nothing (and the manual redeem still refuses it)', async () => {
    const p = await signIn(app, `ref1${D}`, '246810', 91);
    const r = await p.call('POST', '/me/referral/redeem', { code: referrer.code });
    expect(r.statusCode).toBe(400);
    expect(r.json().error ?? r.json().code).toBe('cannot_refer_self');
  });

  it('the manual redeem still works through the same service, once', async () => {
    const u = await signUp(`new5${D}`);
    const p = await signIn(app, `new5${D}`, '246810', 91);
    expect(u.referredBy).toBeNull();
    const r = await p.call('POST', '/me/referral/redeem', { code: referrer.code });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, rewardDays: REFERRAL.rewardDays });
    expect((await p.call('POST', '/me/referral/redeem', { code: referrer.code })).statusCode).toBe(400);
  });

  it('the referrer stops earning after maxRewards sign-ups, the new person still gets their days', async () => {
    await sql`update users set referred_by = ${referrer.id} where email like ${'filler%' + D}`;
    const fillers = REFERRAL.maxRewards - 3;   // 3 referred above (new1, new2, new5)
    for (let i = 0; i < fillers; i++) await sql`insert into users (email, referred_by) values (${`filler${i}${D}`}, ${referrer.id})`;
    const before = (await sql`select comp_until from users where id = ${referrer.id}`)[0].compUntil;
    const u = await signUp(`cap${D}`, { ref_code: referrer.code });
    expect(u.referredBy).toBe(referrer.id);
    expect(plusDaysLeft(u.plusUntil)).toBe(REFERRAL.rewardDays);
    const after = (await sql`select comp_until from users where id = ${referrer.id}`)[0].compUntil;
    expect(new Date(after).getTime()).toBe(new Date(before).getTime());
  });
});
