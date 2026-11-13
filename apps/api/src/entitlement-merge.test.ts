// "Bought on the website, works in the Play app" (and the other way round): one account can hold a Razorpay subscription
// (website / installed web app), a Google Play subscription and a Google Play Trip Pass at the same time, and its Plus is
// the latest of them. Everything goes through the real endpoints and billing code with Razorpay and Google Play replaced by
// fakes: Razorpay's API is a stubbed fetch (keys are set, so Razorpay is ON as in production), and Google's Play Developer
// API is a fake client behind google-auth-library. Nothing leaves the machine.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAIL_DOMAIN = '@merge.tablamigo';
const NAMES = ['alice', 'bob', 'cleo', 'dev', ...Array.from({ length: 6 }, (_, i) => `perm${i + 1}`)];
process.env.REVIEW_EMAILS = NAMES.map(n => n + MAIL_DOMAIN).join(',');
process.env.REVIEW_CODE = '424242';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret';
process.env.RAZORPAY_PLAN_MONTHLY = 'plan_monthly_fake';
process.env.RAZORPAY_PLAN_YEARLY = 'plan_yearly_fake';
process.env.TABLAMIGO_FORWARD_SECRET = 'forward-secret-for-tests';
// Google Play is "configured" with a service-account file that google-auth-library (mocked below) never reads.
const saFile = path.join(os.tmpdir(), `tablamigo-merge-test-sa-${process.pid}.json`);
fs.writeFileSync(saFile, '{}');
process.env.PLAY_SERVICE_ACCOUNT_JSON = saFile;

// ---- Google Play Developer API (fake) ------------------------------------------------------------------------------------
const play = vi.hoisted(() => {
  const subs = new Map<string, { subscriptionState: string; expiryTime: string; productId: string }>();
  const passes = new Map<string, { purchaseState: number; consumptionState: number; orderId: string }>();
  const calls: string[] = [];
  const request = async (o: { url: string; method?: string }) => {
    const method = o.method ?? 'GET';
    const u = o.url.replace(/^.*\/applications\/[^/]+\//, '');
    calls.push(`${method} ${u}`);
    let m = u.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
    if (m) {
      const s = subs.get(decodeURIComponent(m[1]));
      if (!s) throw new Error(`play: unknown subscription token ${m[1]}`);
      return { data: { subscriptionState: s.subscriptionState, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', lineItems: [{ productId: s.productId, expiryTime: s.expiryTime }] } };
    }
    m = u.match(/^purchases\/products\/tablamigo_trip_pass\/tokens\/([^:]+)(:consume)?$/);
    if (m) {
      const p = passes.get(decodeURIComponent(m[1]));
      if (!p) throw new Error(`play: unknown pass token ${m[1]}`);
      if (m[2]) { p.consumptionState = 1; return { data: {} }; }
      return { data: { ...p } };
    }
    throw new Error(`play: unexpected ${method} ${o.url}`);
  };
  return { subs, passes, calls, request };
});
vi.mock('google-auth-library', async importOriginal => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  GoogleAuth: class { async getClient() { return { request: play.request }; } },
}));

// ---- Razorpay API (fake) ---------------------------------------------------------------------------------------------------
const rz = new Map<string, any>();   // by path, e.g. /subscriptions/sub_1
let rzN = 0;
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : {};
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const p = u.pathname.replace(/^\/v1/, '');
  if (method === 'POST' && p === '/subscriptions') {
    const s = { id: `sub_merge_${++rzN}`, entity: 'subscription', status: 'created', plan_id: body.plan_id, notes: body.notes, current_end: null };
    rz.set(`/subscriptions/${s.id}`, s); return json(s);
  }
  if (method !== 'GET') throw new Error(`unexpected Razorpay write: ${method} ${p}`);
  if (p === '/invoices') return json({ items: [...rz.values()].filter(o => o.entity === 'invoice' && o.subscription_id === u.searchParams.get('subscription_id')) });
  const refunds = p.match(/^\/payments\/([^/]+)\/refunds$/);
  if (refunds) return json({ items: [...rz.values()].filter(o => o.entity === 'refund' && o.payment_id === refunds[1]) });
  const o = rz.get(p);
  return o ? json(o) : json({ error: { description: 'not found' } }, 400);
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const { PASS_DAYS } = await import('./lib/play.js');
const { syncRazorpay } = await import('./lib/razorpay.js');

let app: Awaited<ReturnType<typeof build>>;
const DAY = 86400_000;
const sign = (payload: string, secret = 'fake-secret') => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const mails: unknown[] = [];

type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;
const api: Record<string, Api> = {};
const id: Record<string, string> = {};
let ip = 0;
async function login(name: string) {
  const email = name + MAIL_DOMAIN, remoteAddress = `10.77.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  api[name] = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  id[name] = (await sql`select id from users where email = ${email}`)[0].id as string;
}
const plusUntil = async (who: string) => ((await sql`select plus_until from users where id = ${id[who]}`)[0].plusUntil as Date | null)?.getTime() ?? null;
const sec = (ms: number) => Math.floor(ms / 1000) * 1000;   // Razorpay times are whole seconds

/** The website: Razorpay Checkout for a monthly plan, then the app's verify call. Returns when Razorpay says the paid period ends. */
async function buyOnWebsite(who: string, endsAt: number) {
  const s = (await api[who]('POST', '/billing/razorpay/subscribe', { period: 'monthly' })).json();
  expect(s.subscriptionId, 'subscribe').toBeTruthy();
  Object.assign(rz.get(`/subscriptions/${s.subscriptionId}`), { status: 'active', current_end: Math.floor(endsAt / 1000) });
  const paymentId = `pay_${s.subscriptionId}`;
  const r = await api[who]('POST', '/billing/razorpay/subscription-verify', { subscriptionId: s.subscriptionId, paymentId, signature: sign(`${paymentId}|${s.subscriptionId}`) });
  expect(r.json().active, 'subscription-verify').toBe(true);
  return { subId: s.subscriptionId as string, paymentId };
}
/** The Android app: Play Billing hands the app a purchase token, the app sends it to us, we ask Google. */
async function buyOnPlay(who: string, expiresAt: number) {
  const token = `play-sub-${who}`;
  play.subs.set(token, { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', expiryTime: new Date(expiresAt).toISOString(), productId: 'tablamigo_plus' });
  const r = await api[who]('POST', '/billing/google/verify', { productId: 'tablamigo_plus', purchaseToken: token });
  expect(r.json().active, 'google/verify (subscription)').toBe(true);
  return token;
}
async function buyPassOnPlay(who: string) {
  const token = `play-pass-${who}`;
  play.passes.set(token, { purchaseState: 0, consumptionState: 0, orderId: `GPA.${who}-1` });
  const r = await api[who]('POST', '/billing/google/verify', { productId: 'tablamigo_trip_pass', purchaseToken: token });
  expect(r.statusCode, 'google/verify (pass)').toBe(200);
  return { token, expiresAt: new Date(r.json().expiresAt).getTime() };
}

// Ways an entitlement ends, as the stores report them.
const rtdn = (data: unknown) => app.inject({ method: 'POST', url: '/billing/google/rtdn', payload: { message: { data: Buffer.from(JSON.stringify(data)).toString('base64') } } });
const refundPlayPass = async (token: string) => {
  play.passes.get(token)!.purchaseState = 1;                         // Google: no longer in the purchased state
  expect((await rtdn({ voidedPurchaseNotification: { purchaseToken: token, productType: 2 } })).statusCode).toBe(200);
};
const revokePlaySubscription = async (token: string) => {
  Object.assign(play.subs.get(token)!, { subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', expiryTime: new Date(Date.now() - 60_000).toISOString() });
  expect((await rtdn({ subscriptionNotification: { purchaseToken: token, notificationType: 13 } })).statusCode).toBe(200);
};
const refundWebsiteSubscription = async (who: string, subId: string, paymentId: string) => {
  // The customer cancels and is refunded the period: Razorpay (through Hookpost's webhook) tells us about the refund.
  const sub = rz.get(`/subscriptions/${subId}`);
  sub.status = 'cancelled';
  const notes = sub.notes;
  rz.set(`/invoices/inv_${subId}`, { id: `inv_${subId}`, entity: 'invoice', subscription_id: subId, payment_id: paymentId, billing_end: sub.current_end });
  rz.set(`/payments/${paymentId}`, { id: paymentId, entity: 'payment', amount: 49900, currency: 'INR', amount_refunded: 49900, status: 'refunded', invoice_id: `inv_${subId}`, notes });
  const refund = { id: `rfnd_${subId}`, entity: 'refund', amount: 49900, currency: 'INR', payment_id: paymentId, status: 'processed', created_at: Math.floor(Date.now() / 1000) };
  rz.set(`/refunds/${refund.id}`, refund);
  const raw = JSON.stringify({ entity: 'event', event: 'refund.processed', payload: { refund: { entity: refund } } });
  const r = await app.inject({ method: 'POST', url: '/billing/razorpay/webhook', payload: raw, headers: { 'content-type': 'application/json', 'x-tablamigo-signature': sign(raw, 'forward-secret-for-tests') } });
  expect(r.statusCode, `webhook for ${who}`).toBe(200);
};

const subRows = async (who: string) => await sql`select platform, status, expires_at from subscriptions where user_id = ${id[who]} order by platform`;
const passRows = async (who: string) => await sql`select purchase_token, expires_at, voided_at from passes where user_id = ${id[who]} order by created_at`;

beforeAll(async () => {
  app = await build();
  setMailTransport(async m => { mails.push(m); return { id: `re_${mails.length}` }; });
  await sql`delete from users where email like ${'%' + MAIL_DOMAIN}`;
  for (const n of NAMES) await login(n);
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + MAIL_DOMAIN}`;
  setMailTransport(null);
  fs.rmSync(saFile, { force: true });
  await app.close(); await sql.end(); vi.unstubAllGlobals();
});

describe('one account, three ways of paying', () => {
  it('a Razorpay subscription, a Play subscription and a Play Trip Pass held together: plus_until is the latest, the pass stacks after existing access', async () => {
    const t0 = Date.now();
    const razorpayEnds = sec(t0 + 10 * DAY), playEnds = t0 + 30 * DAY;
    expect((await api.alice('GET', '/me')).json().plus).toBe(false);

    // 1. Website: Razorpay. The same /me the Android app reads says Plus, so a website purchase works in the Play app.
    await buyOnWebsite('alice', razorpayEnds);
    expect(await plusUntil('alice')).toBe(razorpayEnds);
    expect((await api.alice('GET', '/me')).json().plus).toBe(true);

    // 2. Android: a Play subscription on the same account, ending later. Both rows exist, one per platform.
    const playToken = await buyOnPlay('alice', playEnds);
    expect((await subRows('alice')).map(r => [r.platform, r.status])).toEqual([['google', 'SUBSCRIPTION_STATE_ACTIVE'], ['razorpay', 'SUBSCRIPTION_STATE_ACTIVE']]);
    expect(await plusUntil('alice')).toBe(playEnds);                       // the latest of the two

    // 3. A Play Trip Pass on top: 14 days that start when the existing access ends, not today.
    const pass = await buyPassOnPlay('alice');
    expect(pass.expiresAt).toBe(playEnds + PASS_DAYS * DAY);
    expect((await passRows('alice')).map(r => r.purchaseToken)).toEqual([pass.token]);
    expect(await plusUntil('alice')).toBe(playEnds + PASS_DAYS * DAY);
    await (await import('./lib/play-ack.js')).playAcksSettled();           // the consume runs after the answer
    expect(play.calls).toContain(`POST purchases/products/tablamigo_trip_pass/tokens/${pass.token}:consume`);   // consumed, so it can be bought again next trip
    // A retry of the same purchase grants nothing twice.
    expect((await api.alice('POST', '/billing/google/verify', { productId: 'tablamigo_trip_pass', purchaseToken: pass.token })).json().expiresAt).toBe(new Date(pass.expiresAt).toISOString());
    expect(await passRows('alice')).toHaveLength(1);

    // 4. A renewal on one platform never shortens another: Razorpay renews for a further month.
    const renewed = sec(t0 + 60 * DAY);
    const subId = (await sql`select purchase_token from subscriptions where user_id = ${id.alice} and platform = 'razorpay'`)[0].purchaseToken.slice(4);
    rz.get(`/subscriptions/${subId}`).current_end = renewed / 1000;
    // The pull that GET /billing/plans runs skips subscriptions it checked in the last 5 minutes, so age the row first.
    await sql`update subscriptions set updated_at = now() - interval '1 hour' where user_id = ${id.alice}`;
    await syncRazorpay(id.alice);
    expect(await plusUntil('alice')).toBe(renewed);
    // The Play side is untouched by it.
    expect(play.subs.get(playToken)!.expiryTime).toBe(new Date(playEnds).toISOString());
    expect((await passRows('alice'))[0].voidedAt).toBeNull();
  });

  it('a Play pass bought on top of website Plus starts when the website Plus ends; with no access it starts now', async () => {
    const t0 = Date.now(), razorpayEnds = sec(t0 + 10 * DAY);
    await buyOnWebsite('bob', razorpayEnds);
    const pass = await buyPassOnPlay('bob');
    expect(pass.expiresAt).toBe(razorpayEnds + PASS_DAYS * DAY);
    expect(await plusUntil('bob')).toBe(razorpayEnds + PASS_DAYS * DAY);

    const fresh = await buyPassOnPlay('cleo');            // nothing to stack after
    expect(Math.abs(fresh.expiresAt - (Date.now() + PASS_DAYS * DAY))).toBeLessThan(10_000);
    expect(await plusUntil('cleo')).toBe(fresh.expiresAt);
  });

  it('bought in the Play app, works on the website: a Play-only account is Plus on /billing/plans, which the web app reads', async () => {
    await buyOnPlay('dev', sec(Date.now() + 20 * DAY));
    const plans = (await api.dev('GET', '/billing/plans')).json();
    expect(plans.plus).toBe(true);
    expect(new Date(plans.plusUntil).getTime()).toBe(await plusUntil('dev'));
    expect(plans.razorpay.subscription).toBeNull();      // nothing on Razorpay, yet Plus shows: it is the account that has Plus
    expect((await api.dev('GET', '/me')).json().plus).toBe(true);
  });

  const REMOVALS = ['razorpay', 'google', 'pass'] as const;
  type Removal = typeof REMOVALS[number];
  const orders: Removal[][] = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]].map(o => o.map(i => REMOVALS[i]));

  it.each(orders.map((o, i) => [i + 1, o]))('exploit: voiding or refunding one never erases the others (order %i: %j)', async (n, order) => {
    const who = `perm${n}`;
    const t0 = Date.now();
    const razorpayEnds = sec(t0 + 10 * DAY), playEnds = sec(t0 + 30 * DAY);
    const web = await buyOnWebsite(who, razorpayEnds);
    const playToken = await buyOnPlay(who, playEnds);
    const pass = await buyPassOnPlay(who);
    const expiry: Record<Removal, number> = { razorpay: razorpayEnds, google: playEnds, pass: pass.expiresAt };
    expect(await plusUntil(who)).toBe(Math.max(...Object.values(expiry)));

    const remaining = new Set<Removal>(REMOVALS);
    for (const gone of order as Removal[]) {
      if (gone === 'razorpay') await refundWebsiteSubscription(who, web.subId, web.paymentId);
      if (gone === 'google') await revokePlaySubscription(playToken);
      if (gone === 'pass') await refundPlayPass(pass.token);
      remaining.delete(gone);
      const left = [...remaining].map(k => expiry[k]);
      expect(await plusUntil(who), `${who}: after ${gone} is gone, ${[...remaining].join(' + ') || 'nothing'} remains`).toBe(left.length ? Math.max(...left) : null);
      // The rows of what is left are untouched.
      const rows = await subRows(who);
      expect(rows.find(r => r.platform === 'razorpay')!.status === 'SUBSCRIPTION_STATE_ACTIVE', 'razorpay row active').toBe(remaining.has('razorpay'));
      expect(rows.find(r => r.platform === 'google')!.status === 'SUBSCRIPTION_STATE_ACTIVE', 'google row active').toBe(remaining.has('google'));
      expect((await passRows(who))[0].voidedAt === null, 'pass not voided').toBe(remaining.has('pass'));
    }
    expect(await plusUntil(who)).toBeNull();
  });
});
