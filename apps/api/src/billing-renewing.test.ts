// GET /billing/me says whether the account has a subscription that will charge again (`renewing`), so the Play app's paywall
// never sells a second subscription to someone already paying on Google Play or on the website. Rows are written directly:
// this checks the classification, not the providers (entitlement-merge.test.ts covers those).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const MAIL = '@renewing.tablamigo';
process.env.REVIEW_EMAILS = ['rena', 'reno'].map(n => n + MAIL).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { recomputePlus } = await import('./lib/play.js');

let app: Awaited<ReturnType<typeof build>>;
let tok = ''; let uid = '';
const me = async () => (await app.inject({ method: 'GET', url: '/billing/me', headers: { authorization: `Bearer ${tok}` }, remoteAddress: '10.77.0.1' })).json();
const sub = async (token: string, platform: string, status: string, days: number, cancelRequested = false) => {
  await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, cancel_requested_at)
    values (${token}, ${uid}, ${platform}, 'tablamigo_plus', ${status}, now() + make_interval(days => ${days}), ${cancelRequested ? sql`now()` : null})`;
  await recomputePlus(uid);
};
const clear = async () => { await sql`delete from subscriptions where user_id = ${uid}`; await sql`update users set comp_until = null where id = ${uid}`; await recomputePlus(uid); };

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + MAIL}`;
  const email = 'rena' + MAIL;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress: '10.77.0.1' });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress: '10.77.0.1' });
  tok = r.json().accessToken; uid = (await sql`select id from users where email = ${email}`)[0].id;
});
afterAll(async () => { await sql`delete from users where email like ${'%' + MAIL}`; await app.close(); await sql.end(); });

describe('GET /billing/me renewing', () => {
  it('is null for a free account', async () => {
    await clear();
    expect(await me()).toMatchObject({ plus: false, renewing: null });
  });
  it('is google for an active Play subscription, and for one in its grace period', async () => {
    await clear(); await sub('play-tok-active', 'google', 'SUBSCRIPTION_STATE_ACTIVE', 20);
    expect(await me()).toMatchObject({ plus: true, renewing: 'google' });
    await clear(); await sub('play-tok-grace', 'google', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 3);
    expect(await me()).toMatchObject({ plus: true, renewing: 'google' });
  });
  it('is razorpay for a live website subscription', async () => {
    await clear(); await sub('rzp:sub_live', 'razorpay', 'SUBSCRIPTION_STATE_ACTIVE', 25);
    expect(await me()).toMatchObject({ plus: true, renewing: 'razorpay' });
  });
  it('is null once the subscription is cancelled: Plus runs to the end of the paid period, nothing renews', async () => {
    await clear(); await sub('play-tok-cancelled', 'google', 'SUBSCRIPTION_STATE_CANCELED', 10);
    expect(await me()).toMatchObject({ plus: true, renewing: null });
    await clear(); await sub('rzp:sub_cancel_at_end', 'razorpay', 'SUBSCRIPTION_STATE_ACTIVE', 10, true);
    expect(await me()).toMatchObject({ plus: true, renewing: null });
  });
  it('is null for an expired, on-hold or pending subscription, and for granted days', async () => {
    await clear(); await sub('play-tok-expired', 'google', 'SUBSCRIPTION_STATE_ACTIVE', -1);
    expect(await me()).toMatchObject({ plus: false, renewing: null });
    await clear(); await sub('play-tok-hold', 'google', 'SUBSCRIPTION_STATE_ON_HOLD', 5);
    expect((await me()).renewing).toBeNull();
    await clear(); await sub('play-tok-pending', 'google', 'SUBSCRIPTION_STATE_PENDING', 5);
    expect((await me()).renewing).toBeNull();
    await clear(); await sql`update users set comp_until = now() + interval '30 days' where id = ${uid}`; await recomputePlus(uid);
    expect(await me()).toMatchObject({ plus: true, renewing: null });
  });
  it("never reports another account's subscription", async () => {
    await clear();
    const email = 'reno' + MAIL;
    await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress: '10.77.0.2' });
    await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress: '10.77.0.2' });
    const other = (await sql`select id from users where email = ${email}`)[0].id;
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at)
      values ('play-tok-other', ${other}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', now() + interval '20 days')`;
    expect(await me()).toMatchObject({ plus: false, renewing: null });
  });
});
