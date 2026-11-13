// Hookpost's billing scenarios (docs/billing/SCENARIOS.md, SC-01 to SC-24) on Tablamigo's Plus, as mapped in
// docs/billing-scenarios.md: the Fastify app in-process, a fake Razorpay (fetch stubbed, every write recorded) and a fake Google
// Play API, signed webhooks and RTDN pushes in through HTTP, mail to a recorder. Each test is named after its scenario, and the
// break-it cases (forged and replayed events, another user's payment, double submits, a store that is down) sit beside them.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const D = '@bsc.tablamigo';
const NAMES = ['ana', 'bo', 'cy', 'di', 'ed', 'flo', 'gil', 'hal', 'ira', 'jo', 'kit', 'lu', 'mo', 'admin'] as const;
type Name = typeof NAMES[number];
process.env.REVIEW_EMAILS = NAMES.map(n => n + D).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = `admin${D}`;
const KEY_SECRET = 'fake-secret-bsc', FORWARD = 'forward-secret-bsc';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_PLAN_MONTHLY = 'plan_monthly_fake';
process.env.RAZORPAY_PLAN_YEARLY = 'plan_yearly_fake';
process.env.TABLAMIGO_FORWARD_SECRET = FORWARD;
const saFile = path.join(os.tmpdir(), `tablamigo-bsc-sa-${process.pid}.json`);
fs.writeFileSync(saFile, '{}');
process.env.PLAY_SERVICE_ACCOUNT_JSON = saFile;

const play = vi.hoisted(() => {
  const subs = new Map<string, any>(), voided = new Map<string, any>(), cancels: string[] = [];
  const state = { down: false, cancelDown: false };
  const request = async (o: { url: string; method?: string }) => {
    if (state.down) throw Object.assign(new Error('google 503'), { response: { status: 503 } });
    const u = o.url.replace(/^.*\/applications\/[^/]+\//, '');
    if (/:acknowledge$/.test(u)) return { data: {} };
    let m = u.match(/^purchases\/subscriptions\/[^/]+\/tokens\/([^/]+):cancel$/);
    if (m && state.cancelDown) throw Object.assign(new Error('google 503'), { response: { status: 503 } });
    if (m) { cancels.push(decodeURIComponent(m[1])); return { data: {} }; }
    if (/^purchases\/voidedpurchases\?/.test(u)) return { data: { voidedPurchases: [...voided.values()] } };
    m = u.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
    if (m) { const s = subs.get(decodeURIComponent(m[1])); if (!s) throw Object.assign(new Error('not found'), { response: { status: 404 } }); return { data: structuredClone(s) }; }
    if (/^orders\//.test(u)) throw Object.assign(new Error('not found'), { response: { status: 404 } });
    throw new Error(`play: unexpected ${o.method ?? 'GET'} ${o.url}`);
  };
  return { subs, voided, cancels, state, request };
});
vi.mock('google-auth-library', async importOriginal => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  GoogleAuth: class { async getClient() { return { request: play.request }; } },
}));

// ---- the fake Razorpay -----------------------------------------------------------------------------------------------------
const rz = new Map<string, any>();
/** Every write the code made to Razorpay: 'cancel sub_x', 'create sub_y', 'refund pay_z'. */
const writes: string[] = [];
/** Paths whose GETs answer 503 until removed (a Razorpay outage). */
const down = new Set<string>();
/** Subscriptions whose cancel Razorpay refuses (a cancel that doesn't stick). */
const refuseCancel = new Set<string>();
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
    const s = { id: `sub_new${++created}${R}`, entity: 'subscription', status: 'created', plan_id: body.plan_id, total_count: body.total_count, remaining_count: body.total_count,
      paid_count: 0, start_at: body.start_at ?? null, current_start: null, current_end: null, charge_at: body.start_at ?? null, ended_at: null, notes: body.notes, created_at: nowS() };
    rz.set(`/subscriptions/${s.id}`, s); writes.push(`create ${s.id}${body.start_at ? ` start_at=${body.start_at}` : ''}`);
    return json(s);
  }
  if (method === 'POST' && p === '/orders') {
    const o = { id: `order_${++created}${R}`, entity: 'order', amount: body.amount, currency: body.currency, notes: body.notes, status: 'created' };
    rz.set(`/orders/${o.id}`, o); return json(o);
  }
  let m = p.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && m) {
    const s = rz.get(`/subscriptions/${m[1]}`);
    if (!s || refuseCancel.has(m[1]) || ['cancelled', 'completed', 'expired'].includes(s.status)) return json({ error: { description: 'cannot cancel' } }, 400);
    expect(body.cancel_at_cycle_end).toBe(0);   // never at the cycle end (SC-06)
    Object.assign(s, { status: 'cancelled', ended_at: nowS() });
    writes.push(`cancel ${m[1]}`);
    return json(s);
  }
  m = p.match(/^\/payments\/([^/]+)\/refund$/);
  if (method === 'POST' && m) {
    const pay = rz.get(`/payments/${m[1]}`);
    const rf = refundOf(m[1], body.amount ?? pay.amount, body.notes);
    writes.push(`refund ${m[1]}`);
    return json(rf);
  }
  if (method !== 'GET') throw new Error(`unexpected ${method} ${url}`);
  if (down.has(p) || down.has('*')) return json({ error: { description: 'Service unavailable' } }, 503);
  if (p === '/invoices') return json({ items: [...rz.values()].filter(o => o.entity === 'invoice' && o.subscription_id === u.searchParams.get('subscription_id')) });
  if (p === '/refunds') return json({ items: [...rz.values()].filter(o => o.entity === 'refund' && o.created_at >= Number(u.searchParams.get('from'))) });
  if (p === '/disputes') return json({ items: [...rz.values()].filter(o => o.entity === 'dispute' && o.created_at >= Number(u.searchParams.get('from'))) });
  m = p.match(/^\/payments\/([^/]+)\/refunds$/);
  if (m) { const id = m[1]; return json({ items: [...rz.values()].filter(o => o.entity === 'refund' && o.payment_id === id) }); }
  const o = rz.get(p);
  return o ? json(o) : json({ error: { description: 'not found' } }, 400);
}));

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { setMailTransport } = await import('../../lib/mail.js');
const { limitsFor, LIMITS } = await import('../../lib/plus.js');
const { reconcileBilling } = await import('../../lib/billing-reconcile.js');
type Person = import('../helpers.js').Person;
const { signIn } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
const people = {} as Record<Name, Person>;
const R = crypto.randomBytes(3).toString('hex');
const DAY = 86400;
const hmac = (s: string, k: string) => crypto.createHmac('sha256', k).update(s).digest('hex');
const mails: { to: string; subject: string; text: string }[] = [];
const mailsTo = (n: Name) => mails.filter(m => m.to === n + D).map(m => m.subject);
const plusUntil = async (n: Name) => { const v = (await sql`select plus_until from users where id = ${people[n].id}`)[0].plusUntil; return v ? new Date(v).getTime() : null; };
const row = async (subId: string) => (await sql`select status, expires_at, ended_reason, cancel_requested_at from subscriptions where purchase_token = ${'rzp:' + subId}`)[0];

const post = (event: any, secret = FORWARD) => {
  const raw = JSON.stringify(event);
  return app.inject({ method: 'POST', url: '/billing/razorpay/webhook', payload: raw, headers: { 'content-type': 'application/json', 'x-tablamigo-signature': hmac(raw, secret) } });
};
/** A monthly subscription in its first paid cycle, with its invoice and captured charge (notes on the first charge, as Checkout sets). */
function rzSub(n: Name, tag: string, extra: any = {}) {
  const id = `sub_${tag}${R}`, payId = `pay_${tag}${R}`, inv = `inv_${tag}${R}`;
  const notes = { service: 'tablamigo', user_id: people[n].id, product: 'tablamigo_plus_monthly' };
  const s = { id, entity: 'subscription', plan_id: 'plan_monthly_fake', status: 'active', total_count: 120, remaining_count: 119, paid_count: 1,
    notes, current_start: nowS() - DAY, current_end: nowS() + 29 * DAY, charge_at: nowS() + 29 * DAY, ended_at: null, created_at: nowS() - 60, ...extra };
  rz.set(`/subscriptions/${id}`, s);
  rz.set(`/invoices/${inv}`, { id: inv, entity: 'invoice', status: 'paid', subscription_id: id, payment_id: payId, billing_start: nowS() - DAY, billing_end: nowS() + 29 * DAY, paid_at: nowS() - DAY });
  rz.set(`/payments/${payId}`, { id: payId, entity: 'payment', amount: 49900, currency: 'INR', status: 'captured', amount_refunded: 0, invoice_id: inv, notes, created_at: nowS() - DAY });
  return { s, payId };
}
function refundOf(payId: string, amount: number, notes: any = {}) {
  const rf = { id: `rfnd_${payId.slice(4)}_${++created}`, entity: 'refund', amount, currency: 'INR', payment_id: payId, status: 'processed', created_at: nowS(), notes };
  rz.set(`/refunds/${rf.id}`, rf);
  Object.assign(rz.get(`/payments/${payId}`), { amount_refunded: amount, status: amount >= rz.get(`/payments/${payId}`).amount ? 'refunded' : 'captured' });
  return rf;
}
function dispute(payId: string, status = 'open', extra: any = {}) {
  const d = { id: `disp_${payId.slice(4)}`, entity: 'dispute', payment_id: payId, amount: 49900, currency: 'INR', reason_code: 'fraud', status, phase: 'chargeback',
    respond_by: nowS() + 3 * DAY, created_at: nowS(), ...extra };
  rz.set(`/disputes/${d.id}`, d);
  return d;
}
const verify = (n: Name, s: any, payId: string) => people[n].call('POST', '/billing/razorpay/subscription-verify', { subscriptionId: s.id, paymentId: payId, signature: hmac(`${payId}|${s.id}`, KEY_SECRET) });
const subEvent = (type: string, s: any) => ({ entity: 'event', event: type, payload: { subscription: { entity: { ...s } } } });
const refundEvent = (rf: any) => ({ entity: 'event', event: 'refund.processed', payload: { refund: { entity: rf } } });
const disputeEvent = (type: string, d: any) => ({ entity: 'event', event: type, payload: { dispute: { entity: d }, payment: { entity: { id: d.payment_id, notes: [] } } } });
const rtdn = (data: any) => app.inject({ method: 'POST', url: '/billing/google/rtdn',
  payload: { message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.tablamigo.app', ...data })).toString('base64'), messageId: String(Date.now()) } } });

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  setMailTransport(async m => { mails.push(m as any); return { id: `re_${mails.length}` }; });
  let block = 170;
  for (const n of NAMES) people[n] = await signIn(app, n + D, '424242', block++);
  await sql`update users set name = initcap(split_part(email, '@', 1)) where email like ${'%' + D}`;
});
afterAll(async () => { await sql`delete from users where email like ${'%' + D}`; setMailTransport(null); await app.close(); await sql.end(); vi.unstubAllGlobals(); fs.rmSync(saFile, { force: true }); });
beforeEach(() => { mails.length = 0; writes.length = 0; down.clear(); play.state.down = false; });

describe('Razorpay (web) Plus', () => {
  it('SC-06 Cancel stops Razorpay now, keeps the paid period, one email; pressed twice at once it is one cancel', async () => {
    const { s, payId } = rzSub('ana', 'ana');
    expect((await verify('ana', s, payId)).statusCode).toBe(200);
    const [a, b] = await Promise.all([people.ana.call('POST', '/billing/razorpay/cancel'), people.ana.call('POST', '/billing/razorpay/cancel')]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(writes.filter(w => w.startsWith('cancel'))).toEqual([`cancel ${s.id}`]);
    expect(await plusUntil('ana')).toBe(s.current_end * 1000);
    expect((await row(s.id)).status).toBe('SUBSCRIPTION_STATE_CANCELED');
    expect(mailsTo('ana')).toEqual(['Your Plus subscription is cancelled']);
    // Razorpay's own subscription.cancelled for it, delivered twice: nothing more.
    expect((await post(subEvent('subscription.cancelled', s))).json().result).toBe('cancelled:duplicate');
    expect((await post(subEvent('subscription.cancelled', s))).json().result).toBe('cancelled:duplicate');
    expect(mailsTo('ana')).toHaveLength(1);
    expect((await people.ana.call('GET', '/billing/me')).json()).toMatchObject({ plus: true, renewing: null, razorpay: { subscription: { id: s.id, cancelled: true } } });
  });

  it('SC-09 Reactivate: the new subscription first charges at the paid end; it renews; a second is refused; cancelling it keeps the paid period', async () => {
    const paidEnd = rz.get(`/subscriptions/sub_ana${R}`).current_end;
    const r = await people.ana.call('POST', '/billing/razorpay/subscribe', { period: 'monthly' });
    expect(r.statusCode).toBe(200);
    expect(r.json().firstChargeAt).toBe(new Date(paidEnd * 1000).toISOString());
    const fresh = rz.get(`/subscriptions/${r.json().subscriptionId}`);
    expect(writes).toEqual([`create ${fresh.id} start_at=${paidEnd}`]);
    expect(fresh.notes).toMatchObject({ service: 'tablamigo', user_id: people.ana.id, replaces: `sub_ana${R}` });
    // Approved in Checkout: authenticated, nothing charged; Razorpay takes and refunds a small mandate check.
    Object.assign(fresh, { status: 'authenticated' });
    const check = `pay_check${R}`;
    rz.set(`/payments/${check}`, { id: check, entity: 'payment', amount: 500, currency: 'INR', status: 'refunded', amount_refunded: 500, notes: fresh.notes });
    expect((await verify('ana', fresh, check)).statusCode).toBe(200);
    expect(await plusUntil('ana')).toBe(paidEnd * 1000);
    expect((await post(refundEvent(refundOf(check, 500)))).json().result).toBe('mandate_check');
    expect(await plusUntil('ana')).toBe(paidEnd * 1000);
    const me = (await people.ana.call('GET', '/billing/me')).json();
    expect(me).toMatchObject({ renewing: 'razorpay', razorpay: { subscription: { id: fresh.id, cancelled: false } } });
    expect((await people.ana.call('POST', '/billing/razorpay/subscribe', { period: 'yearly' })).json().error).toBe('already_subscribed');
    // Cancelled before it ever charged: Plus still runs to the old paid end, and the email says so.
    mails.length = 0;
    expect((await people.ana.call('POST', '/billing/razorpay/cancel')).json()).toMatchObject({ ok: true, expiresAt: new Date(paidEnd * 1000).toISOString() });
    expect(writes.at(-1)).toBe(`cancel ${fresh.id}`);
    expect(await plusUntil('ana')).toBe(paidEnd * 1000);
    expect(mails[0].text).toContain('Plus until:');
  });

  it('SC-05 a halted renewal is cancelled at Razorpay; the unpaid period gives no Plus; one email, however often it arrives', async () => {
    const { s, payId } = rzSub('bo', 'bo');
    expect((await verify('bo', s, payId)).statusCode).toBe(200);
    // The renewal fails: Razorpay moves to the new cycle (booked, unpaid) and retries.
    Object.assign(s, { status: 'pending', remaining_count: 118, current_start: nowS() - 60, current_end: nowS() + 30 * DAY });
    expect((await post(subEvent('subscription.pending', s))).json().result).toBe('synced');
    expect(await plusUntil('bo')).toBe(s.current_end * 1000);              // SC-04: Plus stays while it is retried
    Object.assign(s, { status: 'halted' });
    expect((await post(subEvent('subscription.halted', s))).json().result).toBe('synced');
    expect((await post(subEvent('subscription.halted', s))).json().result).toBe('synced');
    expect(writes).toEqual([`cancel ${s.id}`]);
    expect(await plusUntil('bo')).toBeNull();
    expect(await row(s.id)).toMatchObject({ status: 'SUBSCRIPTION_STATE_CANCELED', endedReason: 'halted' });
    expect(mailsTo('bo')).toEqual(["Your Plus renewal didn't go through"]);
    // Razorpay's subscription.cancelled for our cancel, and a later sync, bring nothing back and send nothing.
    expect((await post(subEvent('subscription.cancelled', rz.get(`/subscriptions/${s.id}`)))).json().result).toBe('cancelled:halted');
    await reconcileBilling();
    expect(await plusUntil('bo')).toBeNull();
    expect(mailsTo('bo')).toHaveLength(1);
  });

  it('SC-16 a mandate paused at the bank is cancelled; the paid period is kept; one email that names the pause', async () => {
    const { s, payId } = rzSub('cy', 'cy');
    expect((await verify('cy', s, payId)).statusCode).toBe(200);
    Object.assign(s, { status: 'paused' });
    expect((await post(subEvent('subscription.paused', s))).json().result).toBe('synced');
    expect((await post(subEvent('subscription.paused', s))).json().result).toBe('synced');
    expect(writes).toEqual([`cancel ${s.id}`]);
    expect(await plusUntil('cy')).toBe(s.current_end * 1000);
    expect((await row(s.id)).status).toBe('SUBSCRIPTION_STATE_CANCELED');
    expect(mailsTo('cy')).toEqual(['Your Plus subscription is cancelled']);
    expect(mails[0].text).toContain('was paused at your bank or UPI app');
  });

  it('SC-04 dunning: everything stays Plus except AI ideas, which drop to the free allowance until the renewal is paid', async () => {
    const { s, payId } = rzSub('di', 'di');
    expect((await verify('di', s, payId)).statusCode).toBe(200);
    expect((await limitsFor(people.di.id)).aiSuggestionsPerDay).toBe(LIMITS.plus.aiSuggestionsPerDay);
    Object.assign(s, { status: 'pending', remaining_count: 118 });
    await post(subEvent('subscription.pending', s));
    const dunning = await limitsFor(people.di.id);
    expect(dunning).toEqual({ ...LIMITS.plus, aiSuggestionsPerDay: LIMITS.free.aiSuggestionsPerDay });
    // A comp alongside is paid-for Plus: no dunning limit.
    await sql`update users set comp_until = now() + interval '3 days' where id = ${people.di.id}`;
    expect((await limitsFor(people.di.id)).aiSuggestionsPerDay).toBe(LIMITS.plus.aiSuggestionsPerDay);
    await sql`update users set comp_until = null where id = ${people.di.id}`;
    // The retry is paid: everything back.
    Object.assign(s, { status: 'active', paid_count: 2 });
    await post(subEvent('subscription.charged', s));
    expect(await limitsFor(people.di.id)).toEqual(LIMITS.plus);
  });

  it('SC-11 Cancel after a refund whose webhook never arrived ends Plus now, not at the paid end', async () => {
    const { s, payId } = rzSub('ed', 'ed');
    expect((await verify('ed', s, payId)).statusCode).toBe(200);
    refundOf(payId, 10000);   // refunded in the dashboard; the forward was lost
    expect((await people.ed.call('POST', '/billing/razorpay/cancel')).statusCode).toBe(200);
    expect(await plusUntil('ed')).toBeNull();
    expect((await row(s.id)).endedReason).toBe('refund');
    expect(mailsTo('ed')).toEqual(['Your Plus subscription is cancelled']);
    expect(mails[0].text).toContain('Ended:');
    // The refund sweep then finds it: the refund email, once, and Plus stays off.
    await reconcileBilling();
    await reconcileBilling();
    expect(mailsTo('ed').sort()).toEqual(['Your Plus subscription is cancelled', 'Your refund of ₹100 is on its way']);
    expect(await plusUntil('ed')).toBeNull();
  });

  it('break-it: two checkouts finished at once: exactly one is cancelled and refunded in full; replaying a verify refunds nothing', async () => {
    const one = rzSub('flo', 'flo1'), two = rzSub('flo', 'flo2');
    for (const x of [one, two]) rz.get(`/payments/${x.payId}`).created_at = nowS();   // both paid in Checkout just now
    const res = await Promise.all([verify('flo', one.s, one.payId), verify('flo', two.s, two.payId)]);
    expect(res.map(r => r.statusCode)).toEqual([200, 200]);
    const cancelled = writes.filter(w => w.startsWith('cancel'));
    expect(cancelled).toHaveLength(1);
    const [loser, winner] = cancelled[0] === `cancel ${one.s.id}` ? [one, two] : [two, one];
    expect(writes).toEqual([`cancel ${loser.s.id}`, `refund ${loser.payId}`]);
    expect((await row(loser.s.id)).endedReason).toBe('refund');
    expect((await row(winner.s.id)).status).toBe('SUBSCRIPTION_STATE_ACTIVE');
    expect(await plusUntil('flo')).toBe(winner.s.current_end * 1000);
    // The loser's refund webhook: one refund email; the winner keeps renewing.
    const rf = [...rz.values()].find(o => o.entity === 'refund' && o.payment_id === loser.payId);
    expect((await post(refundEvent(rf))).json().result).toBe('subscription:sent');
    expect((await row(winner.s.id)).status).toBe('SUBSCRIPTION_STATE_ACTIVE');
    // Replaying either verify with its saved signature changes nothing and refunds nothing.
    writes.length = 0;
    expect((await verify('flo', winner.s, winner.payId)).statusCode).toBe(200);
    expect((await verify('flo', loser.s, loser.payId)).statusCode).toBe(200);
    // Nor does an old subscription's checkout, verified for the first time weeks later while another renews.
    const old = rzSub('flo', 'flo0', { created_at: nowS() - 40 * DAY });
    rz.get(`/payments/${old.payId}`).created_at = nowS() - 40 * DAY;
    expect((await verify('flo', old.s, old.payId)).statusCode).toBe(200);
    expect(writes).toEqual([]);
    expect(await plusUntil('flo')).toBeGreaterThanOrEqual(winner.s.current_end * 1000);
  });
});

describe('chargebacks (SC-13 to SC-15)', () => {
  it('SC-13 a chargeback locks web purchases, ends the subscription and comp Plus, one neutral email; replays change nothing', async () => {
    const { s, payId } = rzSub('gil', 'gil');
    expect((await verify('gil', s, payId)).statusCode).toBe(200);
    await sql`update users set comp_until = now() + interval '90 days' where id = ${people.gil.id}`;
    const d = dispute(payId);
    expect((await post(disputeEvent('payment.dispute.created', d))).json().result).toBe('disputed:1');
    expect((await post(disputeEvent('payment.dispute.created', d))).json().result).toBe('dispute_open');
    expect(writes).toEqual([`cancel ${s.id}`]);
    expect(await plusUntil('gil')).toBeNull();
    expect((await row(s.id)).endedReason).toBe('dispute');
    expect(mailsTo('gil')).toEqual(['A payment to Tablamigo was disputed']);
    expect(mails[0].text).not.toMatch(/fee|penalt|fine/i);
    // Checkout is refused while locked, for a subscription and a Trip Pass alike.
    for (const [url, body] of [['/billing/razorpay/subscribe', { period: 'monthly' }], ['/billing/razorpay/pass-order', {}]] as const) {
      const r = await people.gil.call('POST', url, body);
      expect(r.statusCode).toBe(409);
      expect(r.json().error).toBe('billing_disputed');
    }
    // The hourly sweep sees the same dispute: nothing new.
    await reconcileBilling();
    expect(mailsTo('gil')).toHaveLength(1);
  });

  it('SC-14/15 won never restores by itself; an admin clear brings comp Plus back and lets them buy; the sweep never re-locks', async () => {
    const d = rz.get(`/disputes/disp_gil${R}`);
    Object.assign(d, { status: 'won' });
    expect((await post(disputeEvent('payment.dispute.won', d))).json().result).toBe('dispute_won');
    expect(await plusUntil('gil')).toBeNull();
    // A non-admin can't clear it.
    expect((await people.gil.call('POST', `/admin/users/${people.gil.id}/billing-dispute/clear`, {})).statusCode).toBe(403);
    const r = await people.admin.call('POST', `/admin/users/${people.gil.id}/billing-dispute/clear`, {});
    expect(r.statusCode).toBe(200);
    expect(r.json().billingDisputedAt).toBeNull();
    expect(await plusUntil('gil')).toBeGreaterThan(Date.now() + 80 * DAY * 1000);   // the comp is back
    expect((await row(`sub_gil${R}`)).endedReason).toBe('dispute');                   // the subscription stays ended
    await reconcileBilling();
    expect((await sql`select billing_disputed_at from users where id = ${people.gil.id}`)[0].billingDisputedAt).toBeNull();
    expect((await people.gil.call('POST', '/billing/razorpay/subscribe', { period: 'monthly' })).statusCode).toBe(200);
  });

  it("break-it: another product's payment, a payment tagged for one user but invoiced to another's subscription, a forged event: nothing changes; Razorpay down: 500", async () => {
    const { s, payId } = rzSub('hal', 'hal');
    expect((await verify('hal', s, payId)).statusCode).toBe(200);
    const before = await plusUntil('hal');
    // Hookpost's payment on the shared account.
    rz.set(`/payments/pay_hp${R}`, { id: `pay_hp${R}`, entity: 'payment', amount: 59900, currency: 'INR', notes: { service: 'hookpost', orgId: 'o1' } });
    expect((await post(disputeEvent('payment.dispute.created', dispute(`pay_hp${R}`)))).json().result).toBe('not_ours');
    // Ira's tagged payment whose invoice points at Hal's subscription.
    rz.set(`/payments/pay_cross${R}`, { id: `pay_cross${R}`, entity: 'payment', amount: 49900, currency: 'INR', invoice_id: `inv_hal${R}`, notes: { service: 'tablamigo', user_id: people.ira.id } });
    expect((await post(disputeEvent('payment.dispute.created', dispute(`pay_cross${R}`)))).json().result).toBe('not_ours');
    // A forged event (wrong signature) for Hal's real payment.
    const forged = dispute(payId);
    expect((await post(disputeEvent('payment.dispute.created', forged), 'not-the-secret')).statusCode).toBe(401);
    // Razorpay down while reading the dispute: 500, so the forward is retried; nothing written.
    down.add(`/disputes/${forged.id}`);
    expect((await post(disputeEvent('payment.dispute.created', forged))).statusCode).toBe(500);
    expect(writes).toEqual([]);
    expect(await plusUntil('hal')).toBe(before);
    expect((await sql`select billing_disputed_at from users where id = any(${[people.hal.id, people.ira.id]}::uuid[])`).every(u => !u.billingDisputedAt)).toBe(true);
    expect(mails).toHaveLength(0);
    rz.delete(`/disputes/${forged.id}`);
  });
});

describe('SC-13 a chargeback whose first handling fails half way', () => {
  it('Razorpay refuses the cancel: 500, then the redelivery finishes the work, with one email', async () => {
    const { s, payId } = rzSub('mo', 'mo');
    expect((await verify('mo', s, payId)).statusCode).toBe(200);
    const d = dispute(payId);
    refuseCancel.add(s.id);
    expect((await post(disputeEvent('payment.dispute.created', d))).statusCode).toBe(500);
    refuseCancel.delete(s.id);
    expect((await post(disputeEvent('payment.dispute.created', d))).json().result).toBe('disputed:1');
    expect((await post(disputeEvent('payment.dispute.created', d))).json().result).toBe('dispute_open');
    expect(writes).toEqual([`cancel ${s.id}`]);
    expect(await plusUntil('mo')).toBeNull();
    expect(mailsTo('mo')).toEqual(['A payment to Tablamigo was disputed']);
  });
});

describe('SC-21 the hourly reconcile', () => {
  it('a missed refund, a missed dispute and a cancel that did not stick are each caught once; a dry run writes nothing', async () => {
    const ira = rzSub('ira', 'ira'), jo = rzSub('jo', 'jo'), kit = rzSub('kit', 'kit');
    for (const [n, x] of [['ira', ira], ['jo', jo], ['kit', kit]] as const) expect((await verify(n, x.s, x.payId)).statusCode).toBe(200);
    writes.length = 0;
    refundOf(ira.payId, 49900);                 // refund.processed never forwarded
    dispute(jo.payId);                          // Hookpost doesn't forward disputes at all
    refuseCancel.add(kit.s.id);                 // Kit cancels; Razorpay refuses, so it would still charge
    expect((await people.kit.call('POST', '/billing/razorpay/cancel')).statusCode).toBe(400);
    await sql`update subscriptions set cancel_requested_at = now() where purchase_token = ${'rzp:' + kit.s.id}`;
    refuseCancel.delete(kit.s.id);
    mails.length = 0;

    const dry = await reconcileBilling({ dryRun: true });
    expect(dry.chargeStopped).toEqual([{ subscriptionId: kit.s.id, result: 'would cancel' }]);
    expect(dry.refunds.some(r => r.id.startsWith(`rfnd_ira${R}`))).toBe(true);
    expect(dry.disputes.some(r => r.id === `disp_jo${R}`)).toBe(true);
    expect(writes).toEqual([]);
    expect(mails).toHaveLength(0);
    expect(await plusUntil('ira')).not.toBeNull();

    const report = await reconcileBilling();
    // Other files' rows share the test database; their subscriptions aren't in this file's fake Razorpay.
    expect(report.errors.filter(e => e.includes(R))).toEqual([]);
    expect(writes.sort()).toEqual([`cancel ${ira.s.id}`, `cancel ${jo.s.id}`, `cancel ${kit.s.id}`].sort());
    expect(await plusUntil('ira')).toBeNull();
    expect(await plusUntil('jo')).toBeNull();
    expect(await plusUntil('kit')).toBe(kit.s.current_end * 1000);   // charge roka keeps the access already paid for
    expect(mailsTo('ira')).toEqual(['Your refund of ₹499 is on its way']);
    expect(mailsTo('jo')).toEqual(['A payment to Tablamigo was disputed']);
    // A second run (or another process) does the work once.
    writes.length = 0; mails.length = 0;
    await reconcileBilling();
    expect(writes).toEqual([]);
    expect(mails).toHaveLength(0);
  });

  it('Razorpay down: the run reports errors and changes nothing; the next run catches up', async () => {
    const { s, payId } = rzSub('lu', 'lu');
    expect((await verify('lu', s, payId)).statusCode).toBe(200);
    refundOf(payId, 49900);
    down.add('*');
    const r = await reconcileBilling();
    expect(r.errors.length).toBeGreaterThan(0);
    expect(await plusUntil('lu')).toBe(s.current_end * 1000);
    down.clear();
    await reconcileBilling();
    expect(await plusUntil('lu')).toBeNull();
  });
});

describe('Google Play voided purchases (SC-10, SC-13)', () => {
  const token = `playtok${R}abcdefghij.AO-J1Oz${'x'.repeat(80)}`;
  it('a voided subscription ends its Plus once Google lists it; a push Google does not list changes nothing; Google down is retried', async () => {
    play.subs.set(token, { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: `GPA.1-2-3-${R}`, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      lineItems: [{ productId: 'tablamigo_plus', expiryTime: new Date(Date.now() + 30 * DAY * 1000).toISOString(), offerDetails: { basePlanId: 'monthly' } }] });
    expect((await people.jo.call('POST', '/billing/google/verify', { productId: 'tablamigo_plus', purchaseToken: token })).statusCode).toBe(200);
    // A Play purchase still counts while Jo is locked by a web chargeback: Google holds that money.
    expect(await plusUntil('jo')).toBeGreaterThan(Date.now());
    const note = { voidedPurchaseNotification: { purchaseToken: token, orderId: `GPA.1-2-3-${R}`, productType: 1, refundType: 1 } };
    // Not on Google's list: a forged or early push changes nothing.
    expect((await rtdn(note)).statusCode).toBe(200);
    expect(await plusUntil('jo')).toBeGreaterThan(Date.now());
    // Google down: 500, so Pub/Sub delivers it again.
    play.voided.set(token, { purchaseToken: token, orderId: `GPA.1-2-3-${R}`, voidedReason: 7, voidedSource: 2 });
    play.state.down = true;
    expect((await rtdn(note)).statusCode).toBe(500);
    play.state.down = false;
    expect(await plusUntil('jo')).toBeGreaterThan(Date.now());
    // Google's cancel fails: 500 and nothing marked, so the renewal can't keep charging unnoticed.
    play.state.cancelDown = true;
    expect((await rtdn(note)).statusCode).toBe(500);
    play.state.cancelDown = false;
    expect((await sql`select ended_reason from subscriptions where purchase_token = ${token}`)[0].endedReason).toBeNull();
    // Listed as a chargeback: Plus from it ends now and its renewal is cancelled at Google, once.
    expect((await rtdn(note)).statusCode).toBe(200);
    expect((await rtdn(note)).statusCode).toBe(200);
    expect(await plusUntil('jo')).toBeNull();
    expect((await sql`select ended_reason from subscriptions where purchase_token = ${token}`)[0].endedReason).toBe('dispute');
    expect(play.cancels.filter(t => t === token)).toHaveLength(1);
    // Google's later notifications about it never bring Plus back.
    await rtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: token, subscriptionId: 'tablamigo_plus' } });
    expect(await plusUntil('jo')).toBeNull();
  });
});
