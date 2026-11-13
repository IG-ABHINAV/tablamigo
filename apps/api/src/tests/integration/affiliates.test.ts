// Creator partners (lib/affiliate-ledger.ts, lib/affiliates.ts, routes/admin-affiliates.ts) end to end: the Fastify app in-process on
// the test PostGIS, a fake Razorpay (fetch stubbed) and a fake Google Play API (orders, subscriptions, voided list), signed webhooks
// and RTDN pushes in through HTTP. Attribution (web link, Play install referrer, typed code, coupon), commissions (Razorpay gross,
// Play net of Google's fee), voids and clawbacks (refund, chargeback, revoke), the admin page and mark-paid, and the break-it cases:
// duplicates and races, forged and foreign events, self-referral, currencies, windows and paused partners.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const D = '@aff.tablamigo';
const NAMES = Array.from({ length: 80 }, (_, i) => `u${i}`).concat(['admin', 'partner', 'partner2', 'plain']);
process.env.REVIEW_EMAILS = NAMES.map(n => n + D).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = `admin${D}`;
const FORWARD = 'forward-secret-aff';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret-aff';
process.env.RAZORPAY_PLAN_MONTHLY = 'plan_monthly_fake';
process.env.RAZORPAY_PLAN_YEARLY = 'plan_yearly_fake';
process.env.TABLAMIGO_FORWARD_SECRET = FORWARD;
process.env.AFFILIATE_PLAY_FEE_PERCENT = '15';
const saFile = path.join(os.tmpdir(), `tablamigo-aff-sa-${process.pid}.json`);
fs.writeFileSync(saFile, '{}');
process.env.PLAY_SERVICE_ACCOUNT_JSON = saFile;

// ---- the fake Google Play -----------------------------------------------------------------------------------------------------
const play = vi.hoisted(() => {
  const subs = new Map<string, any>(), products = new Map<string, any>(), orders = new Map<string, any>(), voided = new Map<string, any>();
  const state = { ordersDown: false };
  const request = async (o: { url: string; method?: string }) => {
    const u = o.url.replace(/^.*\/applications\/[^/]+\//, '');
    if (/:(acknowledge|consume|cancel)$/.test(u)) return { data: {} };
    if (/^purchases\/voidedpurchases\?/.test(u)) return { data: { voidedPurchases: [...voided.values()] } };
    let m = u.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
    if (m) { const s = subs.get(decodeURIComponent(m[1])); if (!s) throw Object.assign(new Error('not found'), { response: { status: 404 } }); return { data: structuredClone(s) }; }
    m = u.match(/^purchases\/products\/[^/]+\/tokens\/(.+)$/);
    if (m) { const p = products.get(decodeURIComponent(m[1])); if (!p) throw Object.assign(new Error('not found'), { response: { status: 404 } }); return { data: structuredClone(p) }; }
    m = u.match(/^orders\/(.+)$/);
    if (m) {
      const ord = orders.get(decodeURIComponent(m[1]));
      if (state.ordersDown || !ord) throw Object.assign(new Error('not found'), { response: { status: state.ordersDown ? 503 : 404 } });
      return { data: structuredClone(ord) };
    }
    throw new Error(`play: unexpected ${o.method ?? 'GET'} ${o.url}`);
  };
  return { subs, products, orders, voided, state, request };
});
vi.mock('google-auth-library', async importOriginal => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  GoogleAuth: class { async getClient() { return { request: play.request }; } },
}));

// ---- the fake Razorpay --------------------------------------------------------------------------------------------------------
const rz = new Map<string, any>();
let created = 0;
const nowS = () => Math.floor(Date.now() / 1000);
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.host === 'nominatim.openstreetmap.org') return json({});
  if (u.host === 'photon.komoot.io') return json({ type: 'FeatureCollection', features: [] });
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : {};
  const p = u.pathname.replace(/^\/v1/, '');
  if (method === 'POST' && p === '/subscriptions') {
    const s = { id: `sub_new${++created}${R}`, entity: 'subscription', status: 'created', plan_id: body.plan_id, offer_id: body.offer_id ?? null, paid_count: 0,
      current_start: null, current_end: null, charge_at: null, ended_at: null, notes: body.notes, created_at: nowS() };
    rz.set(`/subscriptions/${s.id}`, s);
    return json(s);
  }
  const m = p.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && m) { const s = rz.get(`/subscriptions/${m[1]}`); if (!s) return json({ error: { description: 'nf' } }, 400); Object.assign(s, { status: 'cancelled', ended_at: nowS() }); return json(s); }
  if (method !== 'GET') throw new Error(`unexpected ${method} ${url}`);
  if (p === '/invoices') return json({ items: [...rz.values()].filter(o => o.entity === 'invoice' && o.subscription_id === u.searchParams.get('subscription_id')) });
  const r = p.match(/^\/payments\/([^/]+)\/refunds$/);
  if (r) return json({ items: [...rz.values()].filter(o => o.entity === 'refund' && o.payment_id === r[1]) });
  const o = rz.get(p);
  return o ? json(o) : json({ error: { description: 'not found' } }, 400);
}));

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { setMailTransport } = await import('../../lib/mail.js');
const { accrueCommission, voidCommission } = await import('../../lib/affiliate-ledger.js');

let app: Awaited<ReturnType<typeof build>>;
const R = crypto.randomBytes(3).toString('hex');
const DAY = 86400;
const hmac = (s: string, k: string) => crypto.createHmac('sha256', k).update(s).digest('hex');
type P = { id: string; email: string; token?: string; call: (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response> };
let ip = 0;
const used = new Set<string>();
/** A new account (once per name), with what the app sends at sign-up (ref_code, install_referrer). */
async function signUp(name: string, extra: Record<string, unknown> = {}): Promise<P> {
  if (used.has(name)) throw new Error(`${name} already signed up`);
  used.add(name);
  const email = name + D, remoteAddress = `10.77.${Math.floor(++ip / 250)}.${(ip % 250) + 1}`;
  const st = await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  expect(st.statusCode, `start ${email}: ${st.body}`).toBe(200);
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242', ...extra }, remoteAddress });
  expect(r.statusCode, `verify ${email}: ${r.body}`).toBe(200);
  const token = r.json().accessToken;
  const id = (await sql`select id from users where email = ${email}`)[0].id as string;
  return { id, email, token, call: (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress }) };
}
let next = 0;
const fresh = () => `u${next++}`;
let admin: P;

const post = (event: any, secret = FORWARD) => {
  const raw = JSON.stringify(event);
  return app.inject({ method: 'POST', url: '/billing/razorpay/webhook', payload: raw, headers: { 'content-type': 'application/json', 'x-tablamigo-signature': hmac(raw, secret) } });
};
const rtdn = (data: any, messageId = String(Date.now() + Math.random())) =>
  app.inject({ method: 'POST', url: '/billing/google/rtdn', payload: { message: { data: Buffer.from(JSON.stringify({ packageName: 'com.tablamigo.app', ...data })).toString('base64'), messageId } } });

async function partner(code: string, over: Record<string, unknown> = {}) {
  const r = await admin.call('POST', '/admin/affiliates', { code, name: `Partner ${code}`, ...over });
  expect(r.statusCode, r.body).toBe(200);
  return r.json().affiliate as { id: string; code: string };
}
const commissions = async (affId: string) => sql`select event_key, kind, status, commission_minor::int, net_minor::int, fee_minor::int, gross_minor::int, currency, amount_source, void_reason
  from affiliate_commissions where affiliate_id = ${affId} order by created_at, kind`;
const referral = async (userId: string) => (await sql`select r.source, a.code from affiliate_referrals r join affiliates a on a.id = r.affiliate_id where r.user_id = ${userId}`)[0] ?? null;

/** A web subscription charge of `amount` paise for `p` (first charge notes as Checkout sets them, or none for a renewal). */
function rzCharge(p: P, tag: string, { amount = 49900, currency = 'INR', renewal = false, subNotes = {} as Record<string, unknown>, sub = null as any, fee = 0 as number | null } = {}) {
  const subId = sub?.id ?? `sub_${tag}${R}`, payId = `pay_${tag}${R}`, inv = `inv_${tag}${R}`;
  const notes = { service: 'tablamigo', user_id: p.id, product: 'tablamigo_plus_monthly', ...subNotes };
  const s = sub ?? { id: subId, entity: 'subscription', plan_id: 'plan_monthly_fake', status: 'active', paid_count: 1, notes,
    current_start: nowS() - DAY, current_end: nowS() + 29 * DAY, charge_at: nowS() + 29 * DAY, ended_at: null, created_at: nowS() - 60 };
  if (sub) s.paid_count += 1;
  rz.set(`/subscriptions/${subId}`, s);
  rz.set(`/invoices/${inv}`, { id: inv, entity: 'invoice', status: 'paid', subscription_id: subId, payment_id: payId, billing_start: nowS() - DAY, billing_end: nowS() + 29 * DAY, paid_at: nowS() });
  rz.set(`/payments/${payId}`, { id: payId, entity: 'payment', amount, currency, status: 'captured', amount_refunded: 0, invoice_id: inv, notes: renewal ? [] : notes, created_at: nowS(), ...(fee == null ? {} : { fee }) });
  return { sub: s, payId, event: { entity: 'event', event: 'subscription.charged', payload: { subscription: { entity: s }, payment: { entity: { id: payId } } } } };
}
function rzRefund(payId: string) {
  const pay = rz.get(`/payments/${payId}`);
  const rf = { id: `rfnd_${payId.slice(4)}${++created}`, entity: 'refund', amount: pay.amount, currency: pay.currency, payment_id: payId, status: 'processed', created_at: nowS(), notes: {} };
  rz.set(`/refunds/${rf.id}`, rf); pay.amount_refunded = pay.amount; pay.status = 'refunded';
  return { entity: 'event', event: 'refund.processed', payload: { refund: { entity: rf } } };
}
const money = (amount: number, currencyCode: string) => ({ currencyCode, units: String(Math.floor(amount / 100)), nanos: (amount % 100) * 10_000_000 });
/** A Google Play subscription for `p`, verified through the app's own call (POST /billing/google/verify). */
async function playSub(p: P, token: string, orderId: string, { price = 49900, currency = 'INR', order = {} as any, test = false, offerId = null as string | null } = {}) {
  const s = {
    subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED', latestOrderId: orderId, startTime: new Date().toISOString(),
    ...(test ? { testPurchase: {} } : {}),
    lineItems: [{ productId: 'tablamigo_plus', expiryTime: new Date(Date.now() + 30 * DAY * 1000).toISOString(), latestSuccessfulOrderId: orderId,
      autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: money(price, currency) }, offerDetails: { basePlanId: 'monthly', ...(offerId ? { offerId } : {}) } }],
  };
  play.subs.set(token, s);
  if (order) play.orders.set(orderId, { orderId, state: 'PROCESSED', total: money(price, currency), ...order });
  const r = await p.call('POST', '/billing/google/verify', { productId: 'tablamigo_plus', purchaseToken: token });
  expect(r.statusCode, r.body).toBe(200);
  return s;
}
const playToken = (tag: string) => `tok-${tag}-${R}-${'x'.repeat(20)}`;
const gpa = (tag: string) => `GPA.${tag}-${R}-0001`;

async function cleanup() {
  // Only the partners this file adds (admin-made T…/X… codes): self sign-ups by other test files can have random T or X codes.
  const affs = sql`select id from affiliates where (code like 'T%' or code like 'X%') and source = 'admin'`;
  await sql`delete from affiliate_commissions where affiliate_id in (${affs})`;
  await sql`delete from affiliate_payouts where affiliate_id in (${affs})`;
  await sql`delete from affiliate_referrals where affiliate_id in (${affs})`;
  await sql`delete from affiliates where id in (${affs})`;
  await sql`delete from users where email like ${'%' + D}`;
}

beforeAll(async () => {
  app = await build();
  await cleanup();
  setMailTransport(async () => ({ id: 're_test' }));
  admin = await signUp('admin');
});
afterAll(async () => { await cleanup(); setMailTransport(null); await app.close(); await sql.end(); vi.unstubAllGlobals(); fs.rmSync(saFile, { force: true }); });
beforeEach(() => { play.state.ordersDown = false; });

describe('attribution', () => {
  it('a ?ref= web sign-up, a Play install referrer and a typed code each make the account a referral, with their source', async () => {
    const a = await partner('TWEB1');
    const web = await signUp(fresh(), { ref_code: 'tweb1', utm_source: 'affiliate' });
    expect(await referral(web.id)).toEqual({ source: 'web_link', code: 'TWEB1' });
    const android = await signUp(fresh(), { install_referrer: 'utm_source=affiliate&utm_medium=partner&utm_campaign=TWEB1&ref=TWEB1' });
    expect(await referral(android.id)).toEqual({ source: 'play_install_referrer', code: 'TWEB1' });
    // utm_campaign alone (a Play link someone built by hand) is enough when utm_source says affiliate.
    const utmOnly = await signUp(fresh(), { install_referrer: 'utm_source=affiliate&utm_campaign=TWEB1' });
    expect(await referral(utmOnly.id)).toEqual({ source: 'play_install_referrer', code: 'TWEB1' });
    const typed = await signUp(fresh());
    const r = await typed.call('POST', '/me/referral/redeem', { code: 'tweb1' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, partner: true, rewardDays: 0 });
    expect(await referral(typed.id)).toEqual({ source: 'signup_code', code: 'TWEB1' });
    const detail = (await admin.call('GET', `/admin/affiliates/${a.id}`)).json();
    expect(detail.affiliate.referrals).toBe(4);
  });

  it('first touch wins: a second code, typed or from another partner, never moves a referral', async () => {
    await partner('TFIRST'); await partner('TSECOND');
    const p = await signUp(fresh(), { ref_code: 'TFIRST' });
    const r = await p.call('POST', '/me/referral/redeem', { code: 'TSECOND' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error ?? r.json().code).toBe('already_referred');
    expect((await referral(p.id))!.code).toBe('TFIRST');
  });

  it('a typed code only works on a new account; an unknown code falls through to friend invites', async () => {
    await partner('TLATE');
    const p = await signUp(fresh());
    await sql`update users set created_at = now() - interval '20 days' where id = ${p.id}`;
    const r = await p.call('POST', '/me/referral/redeem', { code: 'TLATE' });
    expect(r.statusCode).toBe(400);
    expect(await referral(p.id)).toBeNull();
    const unknown = await p.call('POST', '/me/referral/redeem', { code: 'TNOSUCH1' });
    expect(unknown.statusCode).toBe(404);   // redeemReferral's invalid_code, as before
  });

  it('self-referral: a partner can never become their own referral (account or email), by any path', async () => {
    const me = await signUp('partner');
    const a = await partner('TSELF', { userEmail: me.email });
    const typed = await me.call('POST', '/me/referral/redeem', { code: 'TSELF' });
    expect(typed.statusCode).toBe(400);
    const coupon = await me.call('POST', '/billing/razorpay/subscribe', { period: 'monthly', coupon: 'TSELF' });
    expect(coupon.statusCode).toBe(400);
    expect(coupon.json().error ?? coupon.json().code).toBe('invalid_coupon');
    expect(await referral(me.id)).toBeNull();
    // Same email, no linked account: a sign-up with the partner's own email is refused too.
    await partner('TSELF2', { email: `partner2${D}` });
    const twin = await signUp('partner2', { ref_code: 'TSELF2' });
    expect(await referral(twin.id)).toBeNull();
    // And even a referral row forced in by hand earns nothing.
    await sql`insert into affiliate_referrals (user_id, affiliate_id, source) values (${me.id}, ${a.id}, 'signup_code')`;
    const { event } = rzCharge(me, 'self1');
    expect((await post(event)).statusCode).toBe(200);
    expect(await commissions(a.id)).toHaveLength(0);
  });

  it('a paused or ended partner attributes nobody; bad codes attribute nobody and never break a sign-up', async () => {
    const a = await partner('TPAUSE');
    await admin.call('PATCH', `/admin/affiliates/${a.id}`, { status: 'paused' });
    const p = await signUp(fresh(), { ref_code: 'TPAUSE' });
    expect(await referral(p.id)).toBeNull();
    for (const ref of ['<script>', 'TPAUSE%00', 'A', 'TOO-LONG-CODE-123456789', '../../etc']) {
      const q = await signUp(fresh(), { ref_code: ref, install_referrer: `ref=${ref}` });
      expect(await referral(q.id)).toBeNull();
    }
  });

  it('coupon: a partner code at web checkout goes on the subscription (with their Razorpay offer) and attributes at the first charge', async () => {
    const a = await partner('TCOUP', { razorpayOfferId: 'offer_Abc123XYZ' });
    const p = await signUp(fresh());
    const bad = await p.call('POST', '/billing/razorpay/subscribe', { period: 'monthly', coupon: 'TNOPE99' });
    expect(bad.statusCode).toBe(400);
    const r = await p.call('POST', '/billing/razorpay/subscribe', { period: 'monthly', coupon: 'tcoup' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().coupon).toEqual({ code: 'TCOUP', discounted: true });
    const s = rz.get(`/subscriptions/${r.json().subscriptionId}`);
    expect(s.offer_id).toBe('offer_Abc123XYZ');
    expect(s.notes.affiliate_code).toBe('TCOUP');
    Object.assign(s, { status: 'active', paid_count: 1, current_start: nowS(), current_end: nowS() + 30 * DAY, charge_at: nowS() + 30 * DAY });
    const { event } = rzCharge(p, 'coup1', { sub: s, amount: 44900 });
    expect((await post(event)).statusCode).toBe(200);
    expect(await referral(p.id)).toEqual({ source: 'coupon', code: 'TCOUP' });
    expect((await commissions(a.id)).map(c => c.commissionMinor)).toEqual([13470]);   // 30% of ₹449
  });
});

describe('Razorpay commissions', () => {
  it('subscription.charged records 30% of the charge, once, however often it is delivered (sequential and 5 at once)', async () => {
    const a = await partner('TRZP');
    const p = await signUp(fresh(), { ref_code: 'TRZP' });
    const { event } = rzCharge(p, 'rz1');
    for (let i = 0; i < 3; i++) expect((await post(event)).statusCode).toBe(200);
    await Promise.all(Array.from({ length: 5 }, () => post(event)));
    const rows = await commissions(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventKey: `rzp:pay:pay_rz1${R}`, status: 'pending', grossMinor: 49900, netMinor: 49900, commissionMinor: 14970, currency: 'INR', amountSource: 'razorpay_payment' });
  });

  it('a renewal (payment without notes) is placed through its invoice and earns again; the checkout verify path is idempotent with it', async () => {
    const a = await partner('TRENEW');
    const p = await signUp(fresh(), { ref_code: 'TRENEW' });
    const first = rzCharge(p, 'rn1');
    await post(first.event);
    const renewal = rzCharge(p, 'rn2', { sub: first.sub, renewal: true });
    await post(renewal.event);
    // The forwarded payment.captured for the same renewal changes nothing.
    await post({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id: renewal.payId } } } });
    expect((await commissions(a.id)).map(c => c.eventKey)).toEqual([`rzp:pay:pay_rn1${R}`, `rzp:pay:pay_rn2${R}`]);
  });

  it('forged or foreign events record nothing: bad signature, payment not captured, another product, an event ticket, a made-up payment id', async () => {
    const a = await partner('TFORGE');
    const p = await signUp(fresh(), { ref_code: 'TFORGE' });
    const { event, payId } = rzCharge(p, 'fg1');
    expect((await post(event, 'not-the-secret')).statusCode).toBe(401);
    expect(await commissions(a.id)).toHaveLength(0);
    rz.get(`/payments/${payId}`).status = 'authorized';
    await post(event);
    expect(await commissions(a.id)).toHaveLength(0);
    // Hookpost's payment on the shared account, claiming our user.
    const foreign = rzCharge(p, 'fg2', { subNotes: { service: 'hookpost' } });
    await post(foreign.event);
    // An event ticket is the host's money: no commission.
    rz.set(`/orders/order_tkt${R}`, { id: `order_tkt${R}`, entity: 'order', notes: { service: 'tablamigo', user_id: p.id, product: 'activity_ticket' } });
    rz.set(`/payments/pay_tkt${R}`, { id: `pay_tkt${R}`, entity: 'payment', amount: 99900, currency: 'INR', status: 'captured', order_id: `order_tkt${R}`, notes: { service: 'tablamigo', user_id: p.id, product: 'activity_ticket' }, created_at: nowS() });
    await post({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id: `pay_tkt${R}` } } } });
    // A payment id Razorpay doesn't know, wrapped in a valid-looking event.
    await post({ entity: 'event', event: 'subscription.charged', payload: { subscription: { entity: event.payload.subscription.entity }, payment: { entity: { id: `pay_ghost${R}` } } } });
    expect(await commissions(a.id)).toHaveLength(0);
  });

  it('a web Trip Pass earns too (payment.captured, keyed on the payment like the verify call)', async () => {
    const a = await partner('TPASSW');
    const p = await signUp(fresh(), { ref_code: 'TPASSW' });
    const notes = { service: 'tablamigo', user_id: p.id, product: 'tablamigo_trip_pass' };
    rz.set(`/orders/order_ps${R}`, { id: `order_ps${R}`, entity: 'order', amount: 29900, notes });
    rz.set(`/payments/pay_ps${R}`, { id: `pay_ps${R}`, entity: 'payment', amount: 29900, currency: 'INR', status: 'captured', order_id: `order_ps${R}`, notes, created_at: nowS(), fee: 0 });
    await post({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id: `pay_ps${R}` } } } });
    await post({ entity: 'event', event: 'order.paid', payload: { payment: { entity: { id: `pay_ps${R}` } } } });
    expect((await commissions(a.id)).map(c => c.commissionMinor)).toEqual([8970]);
  });

  it('a refund voids an unpaid commission; a refund before the charge event means the late event records nothing', async () => {
    const a = await partner('TREFUND');
    const p = await signUp(fresh(), { ref_code: 'TREFUND' });
    const one = rzCharge(p, 'rf1');
    await post(one.event);
    expect((await post(rzRefund(one.payId))).statusCode).toBe(200);
    expect((await commissions(a.id))[0]).toMatchObject({ status: 'void', voidReason: 'refund' });

    const q = await signUp(fresh(), { ref_code: 'TREFUND' });
    const two = rzCharge(q, 'rf2');
    await post(rzRefund(two.payId));
    await post(two.event);   // arrives late
    expect((await commissions(a.id)).filter(c => c.eventKey.includes('rf2'))).toHaveLength(0);
  });

  it('a chargeback voids the commission', async () => {
    const a = await partner('TDISP');
    const p = await signUp(fresh(), { ref_code: 'TDISP' });
    const c = rzCharge(p, 'dp1');
    await post(c.event);
    rz.set(`/disputes/disp_dp1${R}`, { id: `disp_dp1${R}`, entity: 'dispute', payment_id: c.payId, amount: 49900, currency: 'INR', status: 'open', created_at: nowS() });
    expect((await post({ entity: 'event', event: 'payment.dispute.created', payload: { dispute: { entity: { id: `disp_dp1${R}` } } } })).statusCode).toBe(200);
    expect((await commissions(a.id))[0]).toMatchObject({ status: 'void', voidReason: 'chargeback' });
  });

  it('commission_months closes the window; a paused partner earns nothing new; a new % applies to new charges only', async () => {
    const a = await partner('TWIN', { months: 1, percent: 40 });
    const p = await signUp(fresh(), { ref_code: 'TWIN' });
    await post(rzCharge(p, 'wn1').event);
    expect((await commissions(a.id)).map(c => c.commissionMinor)).toEqual([19960]);   // 40%
    await admin.call('PATCH', `/admin/affiliates/${a.id}`, { percent: 35.5 });
    await post(rzCharge(p, 'wn2').event);
    expect((await commissions(a.id)).map(c => c.commissionMinor)).toEqual([19960, 17714]);   // floor(49900 × 35.5%)
    await sql`update affiliate_referrals set created_at = now() - interval '32 days' where user_id = ${p.id}`;
    await post(rzCharge(p, 'wn3').event);
    expect(await commissions(a.id)).toHaveLength(2);
    await admin.call('PATCH', `/admin/affiliates/${a.id}`, { months: null, status: 'paused' });
    await post(rzCharge(p, 'wn4').event);
    expect(await commissions(a.id)).toHaveLength(2);
    await admin.call('PATCH', `/admin/affiliates/${a.id}`, { status: 'active' });
    await post(rzCharge(p, 'wn5').event);
    expect(await commissions(a.id)).toHaveLength(3);
  });

  it('a customer nobody referred earns nobody anything', async () => {
    const p = await signUp('plain');
    await post(rzCharge(p, 'pl1').event);
    expect((await sql`select 1 from affiliate_commissions where user_id = ${p.id}`).length).toBe(0);
  });
});

describe('Google Play commissions', () => {
  it('a purchase earns on our revenue: Google developer revenue when stated, else total less tax less 15%', async () => {
    const a = await partner('TPLAY');
    const p = await signUp(fresh(), { install_referrer: 'ref=TPLAY' });
    await playSub(p, playToken('pl1'), gpa('PL1'), { price: 49900, order: { tax: money(7612, 'INR'), developerRevenueInBuyerCurrency: money(35941, 'INR') } });
    const q = await signUp(fresh(), { install_referrer: 'ref=TPLAY' });
    await playSub(q, playToken('pl2'), gpa('PL2'), { price: 49900, order: { tax: money(7612, 'INR') } });
    const rows = await commissions(a.id);
    expect(rows[0]).toMatchObject({ grossMinor: 49900, netMinor: 35941, feeMinor: 13959, commissionMinor: 10782, amountSource: 'play_developer_revenue' });
    // (49900 - 7612) = 42288; fee ceil(15%) = 6344; net 35944; 30% = 10783.
    expect(rows[1]).toMatchObject({ grossMinor: 49900, netMinor: 35944, commissionMinor: 10783, amountSource: 'play_order_total' });
  });

  it('renewals by RTDN earn once per order; replays and the app re-verifying record nothing more', async () => {
    const a = await partner('TPREN');
    const p = await signUp(fresh(), { ref_code: 'TPREN' });
    const token = playToken('rn'), first = gpa('RN');
    const s = await playSub(p, token, first, { price: 999, currency: 'USD' });
    const renewal = `${first}..0`;
    s.latestOrderId = renewal; s.lineItems[0].latestSuccessfulOrderId = renewal;
    play.orders.set(renewal, { orderId: renewal, state: 'PROCESSED', total: money(999, 'USD') });
    for (let i = 0; i < 3; i++) expect((await rtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: token } }, 'same-msg')).statusCode).toBe(200);
    await p.call('POST', '/billing/google/verify', { productId: 'tablamigo_plus', purchaseToken: token });
    const rows = await commissions(a.id);
    expect(rows.map(r => r.eventKey)).toEqual([`play:order:${first}`, `play:order:${renewal}`]);
    // $9.99 less 15% = 849 cents; 30% = 254.
    expect(rows.map(r => [r.currency, r.netMinor, r.commissionMinor])).toEqual([['USD', 849, 254], ['USD', 849, 254]]);
  });

  it('test purchases and an intro offer with an unreadable order earn nothing; a plain plan falls back to its list price, marked as an estimate', async () => {
    const a = await partner('TPEST');
    const t = await signUp(fresh(), { ref_code: 'TPEST' });
    await playSub(t, playToken('ts'), gpa('TS'), { test: true });
    play.state.ordersDown = true;
    const o = await signUp(fresh(), { ref_code: 'TPEST' });
    await playSub(o, playToken('of'), gpa('OF'), { offerId: 'monthly-intro-50' });
    const l = await signUp(fresh(), { ref_code: 'TPEST' });
    await playSub(l, playToken('lp'), gpa('LP'));
    const rows = await commissions(a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventKey: `play:order:${gpa('LP')}`, amountSource: 'play_list_price', netMinor: 42415 });
    expect((await admin.call('GET', '/admin/affiliates')).json().affiliates.find((x: any) => x.code === 'TPEST').estimated).toBe(1);
  });

  it('a refunded order, a voided-purchase RTDN Google confirms, and a revoke void the commission; an unconfirmed void does not', async () => {
    const a = await partner('TPVOID');
    const p = await signUp(fresh(), { ref_code: 'TPVOID' });
    const token = playToken('pv'), order = gpa('PV');
    await playSub(p, token, order);
    // A forged voided push: Google doesn't list it, so nothing changes.
    await rtdn({ voidedPurchaseNotification: { purchaseToken: token, orderId: order, productType: 1, refundType: 1 } });
    expect((await commissions(a.id))[0].status).toBe('pending');
    play.voided.set(token, { purchaseToken: token, orderId: order, voidedReason: 0, voidedTimeMillis: String(Date.now()) });
    await rtdn({ voidedPurchaseNotification: { purchaseToken: token, orderId: order, productType: 1, refundType: 1 } });
    expect((await commissions(a.id))[0]).toMatchObject({ status: 'void', voidReason: 'refund' });

    const q = await signUp(fresh(), { ref_code: 'TPVOID' });
    const t2 = playToken('rv'), o2 = gpa('RV');
    const s = await playSub(q, t2, o2);
    s.subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
    await rtdn({ subscriptionNotification: { notificationType: 12, purchaseToken: t2 } });
    expect((await commissions(a.id)).find(c => c.eventKey.includes('RV'))).toMatchObject({ status: 'void', voidReason: 'revoked' });

    // Google already reports the order refunded when we first see it: nothing is recorded.
    const r = await signUp(fresh(), { ref_code: 'TPVOID' });
    await playSub(r, playToken('rf'), gpa('RF'), { order: { state: 'REFUNDED' } });
    expect((await commissions(a.id)).find(c => c.eventKey.includes('RF'))).toBeUndefined();
  });

  it('an RTDN for a token we never stored, or for another product, records nothing', async () => {
    const before = (await sql`select count(*)::int as n from affiliate_commissions`)[0].n;
    await rtdn({ subscriptionNotification: { notificationType: 4, purchaseToken: playToken('ghost') } });
    await rtdn({ oneTimeProductNotification: { purchaseToken: playToken('ghost2'), sku: 'tablamigo_trip_pass' } });
    expect((await sql`select count(*)::int as n from affiliate_commissions`)[0].n).toBe(before);
  });
});

describe('admin: owed, clawbacks and mark paid', () => {
  it('only admins see or change anything', async () => {
    const p = await signUp(fresh());
    for (const [m, u, b] of [['GET', '/admin/affiliates'], ['POST', '/admin/affiliates', { code: 'XNOPE', name: 'x' }], ['POST', `/admin/affiliates/${crypto.randomUUID()}/payouts`, { currency: 'INR', utr: 'UTR123456789012' }]] as const)
      expect((await p.call(m, u, b)).statusCode).toBe(403);
  });

  it('refuses bad partner settings: duplicate code, a member\'s invite code, % above 50, three decimals, months 0', async () => {
    await partner('TDUP');
    expect((await admin.call('POST', '/admin/affiliates', { code: 'tdup', name: 'again' })).statusCode).toBe(409);
    const member = await signUp(fresh());
    await sql`update users set referral_code = 'TMEMBER1' where id = ${member.id}`;
    expect((await admin.call('POST', '/admin/affiliates', { code: 'TMEMBER1', name: 'clash' })).statusCode).toBe(409);
    for (const bad of [{ percent: 51 }, { percent: 0 }, { percent: 30.123 }, { months: 0 }, { code: 'ab' }, { code: 'has space' }])
      expect((await admin.call('POST', '/admin/affiliates', { code: 'TBADSET', name: 'x', ...bad })).statusCode, JSON.stringify(bad)).toBe(400);
  });

  it('owed is per currency with its own minimum; mark paid needs a valid UTR, the amount the admin saw, and the minimum', async () => {
    const a = await partner('TPAY');
    const p = await signUp(fresh(), { ref_code: 'TPAY' });
    for (let i = 0; i < 6; i++) await post(rzCharge(p, `py${i}`).event);   // 6 × ₹149.70 = ₹898.20
    await playSub(p, playToken('pyu'), gpa('PYU'), { price: 4900, currency: 'USD' });  // $49 less 15% = 4165; 30% = 1249 cents
    await playSub(p, playToken('pyz'), gpa('PYZ'), { price: 18999, currency: 'ZAR' });
    let ov = (await admin.call('GET', '/admin/affiliates')).json().affiliates.find((x: any) => x.code === 'TPAY');
    expect(ov.owed.map((o: any) => [o.currency, o.amountMinor, o.due, o.convert])).toEqual([['INR', 89820, false, false], ['USD', 1249, true, false], ['ZAR', 4844, false, true]]);
    const pay = (b: any) => admin.call('POST', `/admin/affiliates/${a.id}/payouts`, b);
    expect((await pay({ currency: 'INR', utr: 'UTR12345678901', amountMinor: 89820 })).json().error).toBe('below_minimum');
    expect((await pay({ currency: 'ZAR', utr: 'UTR12345678901' })).json().error).toBe('fx_rate_required');
    expect((await pay({ currency: 'ZAR', utr: 'UTR12345678901', inrPerUnit: 4.8 })).json().error).toBe('below_minimum');   // 48.44 ZAR = ₹232.51
    for (const utr of ['', 'short', 'UTR-12345678901-<x>', '1234567890123456789012345'])
      expect((await pay({ currency: 'USD', utr, amountMinor: 1249 })).json().error, utr).toBe('invalid_utr');
    expect((await pay({ currency: 'USD', utr: 'AXIS 1234 5678 90', amountMinor: 1000 })).statusCode).toBe(409);   // amount_changed
    const ok = await pay({ currency: 'USD', utr: 'axis 1234-5678 90', amountMinor: 1249 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ amountMinor: 1249, currency: 'USD', already: false });
    // A double click or a retry with the same UTR returns the same payout; it is never paid twice.
    expect((await pay({ currency: 'USD', utr: 'AXIS1234567890', amountMinor: 0 })).json()).toMatchObject({ payoutId: ok.json().payoutId, already: true });
    ov = (await admin.call('GET', '/admin/affiliates')).json().affiliates.find((x: any) => x.code === 'TPAY');
    expect(ov.owed.map((o: any) => o.currency)).toEqual(['INR', 'ZAR']);
    expect(ov.paid).toEqual([{ currency: 'USD', amountMinor: 1249, count: 1 }]);
    // The same UTR for another partner is refused.
    const b = await partner('TPAY2');
    const q = await signUp(fresh(), { ref_code: 'TPAY2' });
    await playSub(q, playToken('py2'), gpa('PY2'), { price: 4900, currency: 'USD' });
    expect((await admin.call('POST', `/admin/affiliates/${b.id}/payouts`, { currency: 'USD', utr: 'AXIS1234567890' })).json().error).toBe('utr_already_used');
  });

  it('two mark-paids at once pay once; a refund after payout becomes a clawback that comes off the next payout', async () => {
    const a = await partner('TCLAW');
    const p = await signUp(fresh(), { ref_code: 'TCLAW' });
    const charges: ReturnType<typeof rzCharge>[] = [];
    for (let i = 0; i < 7; i++) { const c = rzCharge(p, `cl${i}`); charges.push(c); await post(c.event); }   // 7 × 14970 = 104790
    const pay = (utr: string, amountMinor?: number) => admin.call('POST', `/admin/affiliates/${a.id}/payouts`, { currency: 'INR', utr, amountMinor });
    const both = await Promise.all([pay('HDFC00000000001', 104790), pay('HDFC00000000002', 104790)]);
    expect(both.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await sql`select count(*)::int as n from affiliate_payouts where affiliate_id = ${a.id}`)[0].n).toBe(1);

    await post(rzRefund(charges[0].payId));
    await post(rzRefund(charges[0].payId));   // refund.processed twice: one clawback
    const rows = await commissions(a.id);
    expect(rows.filter(r => r.kind === 'clawback')).toEqual([expect.objectContaining({ commissionMinor: -14970, status: 'pending', voidReason: 'refund' })]);
    expect(rows.find(r => r.eventKey === `rzp:pay:${charges[0].payId}`)).toMatchObject({ status: 'paid', voidReason: 'refund' });
    for (let i = 7; i < 15; i++) await post(rzCharge(p, `cl${i}`).event);   // 8 × 14970 = 119760, less the clawback
    const ov = (await admin.call('GET', '/admin/affiliates')).json().affiliates.find((x: any) => x.code === 'TCLAW');
    expect(ov.owed).toEqual([expect.objectContaining({ currency: 'INR', amountMinor: 119760 - 14970, due: true })]);
    const second = await pay('HDFC00000000003', 104790);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().amountMinor).toBe(104790);
  });
});

describe('ledger guards (direct)', () => {
  it('refuses amounts that are not whole minor units, a net above the gross, bad currencies and keys', async () => {
    const p = await signUp(fresh());
    const base = { provider: 'razorpay' as const, eventKey: `rzp:pay:pay_direct${R}`, userId: p.id, product: 'tablamigo_plus_monthly', grossMinor: 1000, feeMinor: 0, netMinor: 1000, currency: 'INR', amountSource: 'test', occurredAt: new Date() };
    for (const bad of [{ grossMinor: 10.5 }, { netMinor: NaN }, { netMinor: 2000 }, { currency: 'inr' }, { currency: 'RUPEES' }, { eventKey: 'pay_x' }, { feeMinor: -1 }, { occurredAt: new Date('x') }])
      expect(await accrueCommission({ ...base, ...bad } as any), JSON.stringify(bad)).toBe('invalid');
    expect(await accrueCommission({ ...base, netMinor: 0 })).toBe('zero');
    expect(await accrueCommission({ ...base, grossMinor: -5, netMinor: -5 })).toBe('zero');
    expect(await accrueCommission(base)).toBe('no_referral');
    expect(await voidCommission(`rzp:pay:pay_never${R}`, 'refund')).toBe('none');
    expect(await voidCommission(`rzp:pay:pay_never${R}`, 'refund')).toBe('none');
  });
});

describe('owner decisions, 3 Nov 2026', () => {
  // Mark paid is rate-limited per address (20 a minute), and the tests above used most of the admin's: these come from another one.
  const adminFrom = (remoteAddress: string) => (method: string, url: string, payload?: unknown) =>
    app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${admin.token}` }, remoteAddress });
  it('web commissions are net of Razorpay\'s fee: the payment\'s own fee, else an estimate (2% + GST) marked as one', async () => {
    const a = await partner('TFEE');
    const p = await signUp(fresh(), { ref_code: 'TFEE' });
    await post(rzCharge(p, 'fe1', { fee: 1178 }).event);
    await post(rzCharge(p, 'fe2', { fee: null }).event);
    await post(rzCharge(p, 'fe3', { fee: 999999 }).event);   // a fee above the amount is not believed
    const rows = await commissions(a.id);
    expect(rows.map(r => [r.grossMinor, r.feeMinor, r.netMinor, r.commissionMinor, r.amountSource])).toEqual([
      [49900, 1178, 48722, 14616, 'razorpay_payment'],
      [49900, 1178, 48722, 14616, 'razorpay_fee_estimated'],
      [49900, 1178, 48722, 14616, 'razorpay_fee_estimated'],
    ]);
    expect((await admin.call('GET', '/admin/affiliates')).json().affiliates.find((x: any) => x.code === 'TFEE').estimated).toBe(2);
  });

  it('other currencies are paid in INR at the payout day\'s rate once worth ₹1,000; the payout keeps the original amount and rate', async () => {
    const a = await partner('TFXR');
    for (let i = 0; i < 5; i++) {
      const p = await signUp(fresh(), { ref_code: 'TFXR' });
      await playSub(p, playToken(`fx${i}`), gpa(`FX${i}`), { price: 18999, currency: 'ZAR' });   // 48.44 ZAR each
    }
    const pay = (b: any) => adminFrom('10.98.0.1')('POST', `/admin/affiliates/${a.id}/payouts`, b);
    for (const inrPerUnit of [0, -1, 1e9]) expect((await pay({ currency: 'ZAR', utr: 'SBIN00000000FX1', inrPerUnit, amountMinor: 24220 })).statusCode, String(inrPerUnit)).toBe(400);
    expect((await pay({ currency: 'ZAR', utr: 'SBIN00000000FX1', inrPerUnit: 4.1, amountMinor: 24220 })).json().error).toBe('below_minimum');   // ₹993.02
    const ok = await pay({ currency: 'ZAR', utr: 'SBIN00000000FX1', inrPerUnit: 4.8, amountMinor: 24220 });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ amountMinor: 116256, currency: 'INR', sourceCurrency: 'ZAR', sourceAmountMinor: 24220, inrPerUnit: 4.8, already: false });
    expect((await pay({ currency: 'ZAR', utr: 'SBIN00000000FX1', inrPerUnit: 4.8 })).json().already).toBe(true);
    const d = (await admin.call('GET', `/admin/affiliates/${a.id}`)).json();
    expect(d.affiliate.owed).toEqual([]);
    expect(d.affiliate.paid).toEqual([{ currency: 'INR', amountMinor: 116256, count: 1 }]);
    expect(d.payouts[0]).toMatchObject({ currency: 'INR', amountMinor: 116256, sourceCurrency: 'ZAR', sourceAmountMinor: 24220, fxRate: 4.8 });
    expect(d.commissions.every((c: any) => c.status === 'paid')).toBe(true);
  });

  it('a monthly statement (CSV and text) lists that month\'s commissions, payouts and what is owed, without customer names or emails', async () => {
    const a = await partner('TSTMT', { name: 'Raj Test' });
    const p = await signUp(fresh(), { ref_code: 'TSTMT' });
    for (let i = 0; i < 8; i++) await post(rzCharge(p, `st${i}`).event);
    await post(rzRefund(`pay_st0${R}`));
    expect((await adminFrom('10.98.0.2')('POST', `/admin/affiliates/${a.id}/payouts`, { currency: 'INR', utr: 'ICIC00000000ST1' })).statusCode).toBe(200);
    // One commission from last month, which this month's statement leaves out.
    await sql`update affiliate_commissions set occurred_at = date_trunc('month', now()) - interval '1 day' where event_key = ${`rzp:pay:pay_st7${R}`}`;
    const month = new Date().toISOString().slice(0, 7);
    const csv = await admin.call('GET', `/admin/affiliates/${a.id}/statement?month=${month}&format=csv`);
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.headers['content-type']).toMatch(/^text\/csv/);
    expect(csv.headers['content-disposition']).toBe(`attachment; filename="tablamigo-TSTMT-${month}.csv"`);
    const lines = csv.body.trim().split('\r\n');
    expect(lines[0]).toBe('date,customer,charge,net,currency,percent,commission,status,estimate');
    expect(lines.filter(l => /,149\.70,/.test(l))).toHaveLength(7);   // 7 charges this month (one void)
    expect(lines.some(l => /void \(refund\)/.test(l)), csv.body).toBe(true);
    expect(lines.some(l => /^.*Payout UTR ICIC00000000ST1.*,-1047\.90,payout,$/.test(l)), csv.body).toBe(true);   // 7 unvoided × 149.70
    expect(csv.body).not.toContain(p.email);
    expect(lines.filter(l => /,-149\.70,clawback/.test(l))).toHaveLength(0);   // refunded before payout: a void, not a clawback
    expect(csv.body).toContain('C-' + p.id.replace(/-/g, '').slice(0, 8).toUpperCase());
    const text = await admin.call('GET', `/admin/affiliates/${a.id}/statement?month=${month}&format=text`);
    expect(text.headers['content-type']).toMatch(/^text\/plain/);
    expect(text.body).toContain('Raj Test (TSTMT)');
    expect(text.body).toContain('Earned this month: 898.20 INR');
    expect(text.body).toContain('Paid this month: 1047.90 INR');
    expect(text.body).toContain('Owed to you now: nothing');
    expect(text.body).not.toContain(p.email);
    const last = new Date(); last.setUTCDate(1); last.setUTCMonth(last.getUTCMonth() - 1);
    const prev = await admin.call('GET', `/admin/affiliates/${a.id}/statement?month=${last.toISOString().slice(0, 7)}&format=text`);
    expect(prev.body).toContain('Commissions this month (1)');
    for (const m of ['2026-13', '2026-1', 'nov', '2026-11-01']) expect((await admin.call('GET', `/admin/affiliates/${a.id}/statement?month=${m}`)).statusCode, m).toBe(400);
    expect((await p.call('GET', `/admin/affiliates/${a.id}/statement?month=${month}`)).statusCode).toBe(403);
  });
});
