// Razorpay web checkout against a fake Razorpay: fetch is stubbed, nothing leaves the machine.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
process.env.REVIEW_EMAILS = 'dana@rzp.tablamigo,eli@rzp.tablamigo,fay@rzp.tablamigo';
process.env.REVIEW_CODE = '424242';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret';
process.env.RAZORPAY_PLAN_MONTHLY = 'plan_monthly_fake';
process.env.RAZORPAY_PLAN_YEARLY = 'plan_yearly_fake';

// The fake keeps orders, payments and subscriptions by id and answers the handful of calls we make.
const rz = { orders: new Map<string, any>(), payments: new Map<string, any>(), subs: new Map<string, any>(), calls: [] as string[], n: 0 };
const store = (p: string) => p === 'orders' ? rz.orders : p === 'payments' ? rz.payments : rz.subs;
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  expect(init.headers.authorization).toBe('Basic ' + Buffer.from('rzp_test_fake:fake-secret').toString('base64'));
  const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : {};
  const [, , kind, id, action] = u.pathname.split('/');
  rz.calls.push(`${method} /${kind}${id ? '/' + id : ''}${action ? '/' + action : ''}`);
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST' && !id) {
    const o = kind === 'orders' ? { id: `order_${++rz.n}`, entity: 'order', status: 'created', amount: body.amount, currency: body.currency, receipt: body.receipt, notes: body.notes }
      : { id: `sub_${++rz.n}`, entity: 'subscription', status: 'created', plan_id: body.plan_id, total_count: body.total_count, notes: body.notes, current_end: null };
    store(kind).set(o.id, o); return json(o);
  }
  const o = store(kind).get(id);
  if (!o) return json({ error: { description: 'not found' } }, 400);
  if (action === 'capture') o.status = 'captured';
  if (action === 'cancel') o.cancelAtCycleEnd = body.cancel_at_cycle_end;
  return json(o);
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { syncRazorpaySubscription, syncRazorpay } = await import('./lib/razorpay.js');

let app: Awaited<ReturnType<typeof build>>;
const sign = (payload: string) => crypto.createHmac('sha256', 'fake-secret').update(payload).digest('hex');
const DAY = 86400_000;

async function login(email: string) {
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email } });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' } });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
}
const uid = async (email: string) => (await sql`select id from users where email = ${email}`)[0].id as string;
const plusUntil = async (email: string) => (await sql`select plus_until from users where email = ${email}`)[0].plusUntil as Date | null;
const pay = (id: string, orderId: string, amount: number, status = 'authorized', notes?: any) => rz.payments.set(id, { id, entity: 'payment', order_id: orderId, amount, currency: 'INR', status, notes });

beforeAll(async () => { app = await build(); await sql`delete from users where email like '%@rzp.tablamigo'`; });
afterAll(async () => { await sql`delete from users where email like '%@rzp.tablamigo'`; await app.close(); await sql.end(); vi.unstubAllGlobals(); });

describe('razorpay', () => {
  it('lists INR prices and the key id', async () => {
    const dana = await login('dana@rzp.tablamigo');
    const r = (await dana('GET', '/billing/plans')).json();
    expect(r.razorpay).toEqual({ keyId: 'rzp_test_fake', currency: 'INR', prices: { monthly: 49900, yearly: 399900, pass: 29900 }, subscription: null });
    expect(r.products.length).toBe(4);
  });

  it('Trip Pass: order carries our notes, bad signature refused, capture + grant once', async () => {
    const dana = await login('dana@rzp.tablamigo'); const id = await uid('dana@rzp.tablamigo');
    const o = (await dana('POST', '/billing/razorpay/pass-order', {})).json();
    expect(o).toMatchObject({ keyId: 'rzp_test_fake', amount: 29900, currency: 'INR', prefill: { email: 'dana@rzp.tablamigo' } });
    expect(rz.orders.get(o.orderId).notes).toEqual({ service: 'tablamigo', user_id: id, product: 'tablamigo_trip_pass' });
    pay('pay_pass1', o.orderId, 29900);

    const bad = await dana('POST', '/billing/razorpay/pass-verify', { orderId: o.orderId, paymentId: 'pay_pass1', signature: sign(`${o.orderId}|pay_other`) });
    expect(bad.statusCode).toBe(400); expect(bad.json()).toMatchObject({ error: 'verify_failed', reason: 'bad_signature' });
    expect(await plusUntil('dana@rzp.tablamigo')).toBeNull();

    const body = { orderId: o.orderId, paymentId: 'pay_pass1', signature: sign(`${o.orderId}|pay_pass1`) };
    const ok = (await dana('POST', '/billing/razorpay/pass-verify', body)).json();
    expect(ok.active).toBe(true);
    expect(new Date(ok.expiresAt).getTime()).toBeCloseTo(Date.now() + 14 * DAY, -5);
    expect(rz.calls).toContain('POST /payments/pay_pass1/capture');
    expect((await plusUntil('dana@rzp.tablamigo'))!.getTime()).toBe(new Date(ok.expiresAt).getTime());

    const again = (await dana('POST', '/billing/razorpay/pass-verify', body)).json();
    expect(again.expiresAt).toBe(ok.expiresAt);
    expect((await sql`select count(*)::int as n from passes where user_id = ${id}`)[0].n).toBe(1);
    expect((await sql`select purchase_token from passes where user_id = ${id}`)[0].purchaseToken).toBe('rzp:pay_pass1');
  });

  it("refuses another user's order, another service's order and a wrong amount", async () => {
    const eli = await login('eli@rzp.tablamigo'); const dana = await uid('dana@rzp.tablamigo'); const eliId = await uid('eli@rzp.tablamigo');
    rz.orders.set('order_dana', { id: 'order_dana', amount: 29900, currency: 'INR', notes: { service: 'tablamigo', user_id: dana, product: 'tablamigo_trip_pass' } });
    pay('pay_dana', 'order_dana', 29900, 'captured');
    const r1 = await eli('POST', '/billing/razorpay/pass-verify', { orderId: 'order_dana', paymentId: 'pay_dana', signature: sign('order_dana|pay_dana') });
    expect(r1.json()).toMatchObject({ error: 'verify_failed', reason: 'not_our_order' });

    rz.orders.set('order_hook', { id: 'order_hook', amount: 29900, currency: 'INR', notes: { service: 'hookpost', user_id: eliId, product: 'tablamigo_trip_pass' } });
    pay('pay_hook', 'order_hook', 29900, 'captured');
    const r2 = await eli('POST', '/billing/razorpay/pass-verify', { orderId: 'order_hook', paymentId: 'pay_hook', signature: sign('order_hook|pay_hook') });
    expect(r2.json()).toMatchObject({ error: 'verify_failed', reason: 'not_our_order' });

    rz.orders.set('order_eli', { id: 'order_eli', amount: 29900, currency: 'INR', notes: { service: 'tablamigo', user_id: eliId, product: 'tablamigo_trip_pass' } });
    pay('pay_cheap', 'order_eli', 100, 'captured');
    const r3 = await eli('POST', '/billing/razorpay/pass-verify', { orderId: 'order_eli', paymentId: 'pay_cheap', signature: sign('order_eli|pay_cheap') });
    expect(r3.json()).toMatchObject({ error: 'verify_failed', reason: 'amount_mismatch' });
    // a payment made on another order can't be replayed against this one
    const r4 = await eli('POST', '/billing/razorpay/pass-verify', { orderId: 'order_eli', paymentId: 'pay_dana', signature: sign('order_eli|pay_dana') });
    expect(r4.json()).toMatchObject({ error: 'verify_failed', reason: 'order_mismatch' });

    expect((await sql`select count(*)::int as n from passes where user_id = ${eliId}`)[0].n).toBe(0);
    expect(await plusUntil('eli@rzp.tablamigo')).toBeNull();
  });

  it('subscription: create with notes, verify signature, show it, block a second one, cancel now keeping the paid period (SC-06)', async () => {
    const fay = await login('fay@rzp.tablamigo'); const id = await uid('fay@rzp.tablamigo');
    const s = (await fay('POST', '/billing/razorpay/subscribe', { period: 'monthly' })).json();
    const fake = rz.subs.get(s.subscriptionId);
    expect(fake).toMatchObject({ plan_id: 'plan_monthly_fake', total_count: 120, notes: { service: 'tablamigo', user_id: id } });
    const end = Math.floor((Date.now() + 30 * DAY) / 1000);
    Object.assign(fake, { status: 'active', current_end: end });

    const bad = await fay('POST', '/billing/razorpay/subscription-verify', { subscriptionId: s.subscriptionId, paymentId: 'pay_sub1', signature: sign(`${s.subscriptionId}|pay_sub1`) });
    expect(bad.json()).toMatchObject({ error: 'verify_failed', reason: 'bad_signature' });
    const ok = (await fay('POST', '/billing/razorpay/subscription-verify', { subscriptionId: s.subscriptionId, paymentId: 'pay_sub1', signature: sign(`pay_sub1|${s.subscriptionId}`) })).json();
    expect(ok.active).toBe(true);
    expect((await plusUntil('fay@rzp.tablamigo'))!.getTime()).toBe(end * 1000);
    const [row] = await sql`select platform, product_id, status from subscriptions where purchase_token = ${'rzp:' + s.subscriptionId}`;
    expect(row).toEqual({ platform: 'razorpay', productId: 'tablamigo_plus', status: 'SUBSCRIPTION_STATE_ACTIVE' });

    expect((await fay('GET', '/billing/plans')).json().razorpay.subscription).toMatchObject({ id: s.subscriptionId, cancelled: false });
    expect((await fay('POST', '/billing/razorpay/subscribe', { period: 'yearly' })).json().error).toBe('already_subscribed');

    expect((await fay('POST', '/billing/razorpay/cancel', {})).json().ok).toBe(true);
    expect(fake.cancelAtCycleEnd).toBe(0);   // stopped at Razorpay now: no charge can race the end (SC-06)
    expect((await fay('GET', '/billing/plans')).json().razorpay.subscription.cancelled).toBe(true);
    expect((await plusUntil('fay@rzp.tablamigo'))!.getTime()).toBe(end * 1000);
  });

  it('sync maps Razorpay states onto plus_until and refuses foreign subscriptions', async () => {
    const id = await uid('eli@rzp.tablamigo');
    const end = Math.floor((Date.now() + 20 * DAY) / 1000);
    const sub = { id: 'sub_states', status: 'active', current_end: end, notes: { service: 'tablamigo', user_id: id } };
    rz.subs.set(sub.id, sub);
    const at = async (status: string) => { sub.status = status; await syncRazorpaySubscription(id, sub.id); return (await plusUntil('eli@rzp.tablamigo'))?.getTime() ?? null; };
    expect(await at('active')).toBe(end * 1000);
    expect(await at('authenticated')).toBe(end * 1000);
    expect(await at('pending')).toBe(end * 1000);
    expect(await at('cancelled')).toBe(end * 1000); // paid period is kept
    expect(await at('halted')).toBeNull();
    expect(await at('completed')).toBeNull();
    expect(await at('expired')).toBeNull();

    rz.subs.set('sub_hook', { id: 'sub_hook', status: 'active', current_end: end, notes: { service: 'hookpost', user_id: id } });
    await expect(syncRazorpaySubscription(id, 'sub_hook')).rejects.toThrow('not_our_subscription');
    const dana = await uid('dana@rzp.tablamigo');
    await expect(syncRazorpaySubscription(dana, 'sub_states')).rejects.toThrow('not_our_subscription');
  });

  it('periodic sync picks up renewals, halts and refunded passes', async () => {
    const eli = await uid('eli@rzp.tablamigo');
    const sub = rz.subs.get('sub_states');
    await sql`update subscriptions set status = 'SUBSCRIPTION_STATE_ACTIVE', ended_reason = null where purchase_token = 'rzp:sub_states'`;
    const renewed = Math.floor((Date.now() + 50 * DAY) / 1000);
    Object.assign(sub, { status: 'active', current_end: renewed });
    await syncRazorpay();
    expect((await plusUntil('eli@rzp.tablamigo'))!.getTime()).toBe(renewed * 1000);
    sub.status = 'halted';
    await syncRazorpay();
    expect(await plusUntil('eli@rzp.tablamigo')).toBeNull();
    // SC-05: a halted renewal is cancelled at Razorpay at once and its unpaid period never gives Plus.
    expect(sub.cancelAtCycleEnd).toBe(0);
    expect((await sql`select status, ended_reason from subscriptions where purchase_token = 'rzp:sub_states' and user_id = ${eli}`)[0]).toEqual({ status: 'SUBSCRIPTION_STATE_CANCELED', endedReason: 'halted' });

    rz.payments.get('pay_pass1').status = 'refunded';
    await syncRazorpay();
    expect((await sql`select voided_at from passes where purchase_token = 'rzp:pay_pass1'`)[0].voidedAt).not.toBeNull();
    expect(await plusUntil('dana@rzp.tablamigo')).toBeNull();
  });
});
