// The owner's sale alerts (lib/owner-alerts.ts) through the real routes: the web app's Razorpay verify calls, Hookpost's
// forwarded Razorpay webhook, the periodic Razorpay pull, the Play app's verify call and Google Play's RTDN push. Razorpay is a
// stubbed fetch, the Play Developer API a fake client behind google-auth-library, and mail goes to a recorder; nothing leaves
// the machine.
// What is proven: exactly one alert per money event however often (or however concurrently) it arrives and whichever path sees
// it first; nothing for a forged, foreign or unverifiable event; the webhook answers and Plus is applied when the email provider
// is down or slow, and the alert follows later (redelivery, retry job, stale claims); a provider lookup that fails for a moment
// is retried; test mode only for test money (an internal account on a live key is live); no token, card, UPI, phone or IP in any alert; unsent copies don't
// outlive the retry window or the account; alerts only to the owner and customer emails only to the customer.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const D = '@osa.tablamigo';
const NAMES = ['asha', 'ben', 'cara', 'dev', 'esi', 'fay', 'gus', 'hana', 'ivo', 'jai', 'kai', 'lea', 'max', 'noa', 'oli', 'pia', 'quin'] as const;
type Name = typeof NAMES[number];
process.env.REVIEW_EMAILS = NAMES.map(n => n + D).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = `hana${D}`;
const KEY_SECRET = 'fake-secret-osa', FORWARD = 'forward-secret-osa';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = KEY_SECRET;
process.env.RAZORPAY_PLAN_MONTHLY = 'plan_monthly_fake';
process.env.RAZORPAY_PLAN_YEARLY = 'plan_yearly_fake';
process.env.TABLAMIGO_FORWARD_SECRET = FORWARD;
const OWNER = 'owner-alerts@owner.example';
process.env.OWNER_SALES_ALERT_EMAIL = `${OWNER}, not-an-email, ${OWNER.toUpperCase()}`;
const saFile = path.join(os.tmpdir(), `tablamigo-osa-sa-${process.pid}.json`);
fs.writeFileSync(saFile, '{}');
process.env.PLAY_SERVICE_ACCOUNT_JSON = saFile;

// ---- Google Play Developer API (fake) ------------------------------------------------------------------------------------
const play = vi.hoisted(() => {
  const subs = new Map<string, any>(), passes = new Map<string, any>(), orders = new Map<string, any>(), voided = new Map<string, any>();
  const notFound = (what: string) => Object.assign(new Error(`play: ${what} not found`), { response: { status: 404 } });
  const request = async (o: { url: string; method?: string }) => {
    const u = o.url.replace(/^.*\/applications\/[^/]+\//, '');
    if (/:acknowledge$/.test(u) || /^purchases\/subscriptions\/[^/]+\/tokens\/[^/]+:cancel$/.test(u)) return { data: {} };
    // Google's voided purchases list (refunds and chargebacks): what the test put in `voided`.
    if (/^purchases\/voidedpurchases\?/.test(u)) return { data: { voidedPurchases: [...voided.values()] } };
    let m = u.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
    if (m) { const s = subs.get(decodeURIComponent(m[1])); if (!s) throw notFound('subscription'); return { data: structuredClone(s) }; }
    m = u.match(/^purchases\/products\/tablamigo_trip_pass\/tokens\/([^:]+)(:consume)?$/);
    if (m) {
      const p = passes.get(decodeURIComponent(m[1])); if (!p) throw notFound('pass');
      if (m[2]) { p.consumptionState = 1; return { data: {} }; }
      return { data: { ...p } };
    }
    m = u.match(/^orders\/(.+)$/);
    if (m) { const x = orders.get(decodeURIComponent(m[1])); if (!x) throw notFound('order'); return { data: structuredClone(x) }; }
    throw new Error(`play: unexpected ${o.method ?? 'GET'} ${o.url}`);
  };
  return { subs, passes, orders, voided, request };
});
vi.mock('google-auth-library', async importOriginal => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  GoogleAuth: class { async getClient() { return { request: play.request }; } },
}));

// ---- Razorpay API (fake) ---------------------------------------------------------------------------------------------------
/** Put a purchase on Google's voided list (a refund or chargeback Google reports). */
const voidOnPlay = (token: string, v: any) => play.voided.set(token, v);
const rz = new Map<string, any>();
/** path -> how many more GETs answer 503 (a Razorpay outage). */
const rzDown = new Map<string, number>();
let orderN = 0;
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  // Plan creation reverse-geocodes: answer like Nominatim and Photon with nothing.
  if (u.host === 'nominatim.openstreetmap.org') return json({});
  if (u.host === 'photon.komoot.io') return json({ type: 'FeatureCollection', features: [] });
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  const method = init.method ?? 'GET';
  const p = u.pathname.replace(/^\/v1/, '');
  if (method === 'POST' && p === '/orders') {
    const b = JSON.parse(init.body);
    const o = { id: `order_tkt${++orderN}x${crypto.randomBytes(3).toString('hex')}`, entity: 'order', status: 'created', amount: b.amount, currency: b.currency, notes: b.notes };
    rz.set(`/orders/${o.id}`, o);
    return json(o);
  }
  let m = p.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && m) {
    const s = rz.get(`/subscriptions/${m[1]}`);
    return s ? json(Object.assign(s, { has_scheduled_changes: true })) : json({ error: { description: 'not found' } }, 400);
  }
  if (method !== 'GET') throw new Error(`unexpected ${method} ${url}`);
  const down = rzDown.get(p) ?? 0;
  if (down > 0) { rzDown.set(p, down - 1); return json({ error: { description: 'Service unavailable' } }, 503); }
  if (p === '/invoices') return json({ items: [...rz.values()].filter(o => o.entity === 'invoice' && o.subscription_id === u.searchParams.get('subscription_id')) });
  m = p.match(/^\/payments\/([^/]+)\/refunds$/);
  if (m) { const id = m[1]; return json({ items: [...rz.values()].filter(o => o.entity === 'refund' && o.payment_id === id) }); }
  const o = rz.get(p);
  return o ? json(o) : json({ error: { description: 'not found' } }, 400);
}));

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { setMailTransport } = await import('../../lib/mail.js');
const { syncRazorpay } = await import('../../lib/razorpay.js');
const { ownerAlertsSettled, retryFailedOwnerAlerts, ownerAlertsStartupLine, MAX_ATTEMPTS, BUILD_RETRY_MS } = await import('../../lib/owner-alerts.js');
type Person = import('../helpers.js').Person;
const { signIn, onboard, createPlan } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
const people = {} as Record<Name, Person>;
const R = crypto.randomBytes(3).toString('hex');
const R5 = String(parseInt(R, 16) % 100000).padStart(5, '0');
const DAY = 86400, now = () => Math.floor(Date.now() / 1000);
const hmac = (s: string, k: string) => crypto.createHmac('sha256', k).update(s).digest('hex');
type Mail = { to: string; subject: string; text: string; html: string; idempotencyKey?: string };
const mails: Mail[] = [];
let mailDown = false;
let hold: Promise<void> | null = null;
const toOwner = () => mails.filter(m => m.to === OWNER);
const ownerAbout = (n: Name) => toOwner().filter(m => m.subject.endsWith(`(${n}${D})`)).map(m => m.subject);
const settle = () => ownerAlertsSettled();
const alertRow = async (key: string) => (await sql`select status, attempts, error, subject, body_text, test from owner_sale_alerts where event_key = ${key}`)[0];
const cap = (n: string) => n[0].toUpperCase() + n.slice(1);
const who = (n: Name) => `${cap(n)} Test (${n}${D})`;
const tokens: string[] = [];

// ---- Razorpay fixtures ---------------------------------------------------------------------------------------------------
const post = (event: any, secret = FORWARD) => {
  const raw = JSON.stringify(event);
  return app.inject({ method: 'POST', url: '/billing/razorpay/webhook', payload: raw, headers: { 'content-type': 'application/json', 'x-tablamigo-signature': hmac(raw, secret) } });
};
function rzSub(p: Person, tag: string, extra: any = {}) {
  const id = `sub_${tag}${R}`;
  const s = { id, entity: 'subscription', plan_id: 'plan_monthly_fake', quantity: 1, status: 'active', paid_count: 1,
    notes: { service: 'tablamigo', user_id: p.id, product: 'tablamigo_plus_monthly' },
    current_start: now() - DAY, current_end: now() + 29 * DAY, charge_at: now() + 29 * DAY, ended_at: null, created_at: now() - 60, ...extra };
  rz.set(`/subscriptions/${id}`, s);
  return s;
}
/** A captured, invoiced charge on `s`, with the card, UPI and contact details Razorpay really returns (none may reach an alert). */
function rzCharge(s: any, n: number, extra: any = {}, invoiced = true) {
  const tag = `${s.id.slice(4)}c${n}`, pid = `pay_${tag}`, inv = `inv_${tag}`;
  if (invoiced) rz.set(`/invoices/${inv}`, { id: inv, entity: 'invoice', status: 'paid', paid_at: now() + n, subscription_id: s.id, payment_id: pid, billing_start: now() - DAY, billing_end: now() + 29 * DAY });
  rz.set(`/payments/${pid}`, { id: pid, entity: 'payment', amount: 49900, currency: 'INR', status: 'captured', amount_refunded: 0, ...(invoiced ? { invoice_id: inv } : {}),
    method: 'card', card_id: 'card_SECRET7319', card: { last4: '7319', network: 'Visa', name: 'CARDHOLDER NAME' }, vpa: null, contact: '+919876543210',
    token_id: 'token_ABCSECRET', notes: s.notes, created_at: now(), ...extra });
  return pid;
}
const subEvent = (type: string, s: any, payId?: string) => ({
  entity: 'event', event: type, contains: payId ? ['subscription', 'payment'] : ['subscription'],
  payload: { subscription: { entity: { ...s } }, ...(payId ? { payment: { entity: { ...rz.get(`/payments/${payId}`) } } } : {}) }, created_at: now(),
});
const subVerify = (p: Person, s: any, payId: string) => p.call('POST', '/billing/razorpay/subscription-verify', { subscriptionId: s.id, paymentId: payId, signature: hmac(`${payId}|${s.id}`, KEY_SECRET) });
const refundEvent = (type: string, rf: any) => ({ entity: 'event', event: type, payload: { refund: { entity: rf } } });
function rzRefund(tag: string, payId: string, amount: number) {
  const rf = { id: `rfnd_${tag}${R}`, entity: 'refund', amount, currency: 'INR', payment_id: payId, status: 'processed', created_at: now(), notes: {} };
  rz.set(`/refunds/${rf.id}`, rf);
  Object.assign(rz.get(`/payments/${payId}`), { amount_refunded: amount, status: 'refunded' });
  return rf;
}
/** The periodic pull (GET /billing/plans or the 6-hourly sync) for one person, as if their row were last synced 10 minutes ago. */
async function pull(p: Person) {
  await sql`update subscriptions set updated_at = now() - interval '10 minutes' where user_id = ${p.id} and platform = 'razorpay'`;
  await syncRazorpay(p.id);
}

// ---- Google Play fixtures ------------------------------------------------------------------------------------------------
let msgN = Number(R5) * 1000;
const rtdn = (data: any, o: { messageId?: string; query?: string } = {}) => app.inject({
  method: 'POST', url: `/billing/google/rtdn${o.query ?? ''}`,
  payload: { message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.tablamigo.app', eventTimeMillis: String(Date.now()), ...data })).toString('base64'), messageId: o.messageId ?? String(++msgN) }, subscription: 'projects/x/subscriptions/y' },
});
const subNote = (token: string, notificationType: number) => ({ subscriptionNotification: { version: '1.0', notificationType, purchaseToken: token, subscriptionId: 'tablamigo_plus' } });
/** A purchase token as Google makes them: 100+ characters. Collected so the last test can check no alert ever shows one. */
const playToken = (tag: string) => { const t = `${tag}${R}abcdefghij.AO-J1Oz${crypto.randomBytes(72).toString('base64url')}`; tokens.push(t); return t; };
const order = (n: string) => `GPA.${n}-5678-9012-${R5}`;
function playSub(token: string, o: { order: string; paid?: string | null; state?: string; basePlan?: string; offer?: string; price?: string; test?: boolean; days?: number; cancel?: any; autoRenew?: boolean }) {
  const s = {
    kind: 'androidpublisher#subscriptionPurchaseV2', regionCode: 'IN', startTime: new Date().toISOString(),
    subscriptionState: o.state ?? 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: o.order, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    ...(o.test ? { testPurchase: {} } : {}), ...(o.cancel ? { canceledStateContext: o.cancel } : {}),
    externalAccountIdentifiers: { obfuscatedExternalAccountId: 'obf-account-SECRET' },
    lineItems: [{ productId: 'tablamigo_plus', expiryTime: new Date(Date.now() + (o.days ?? 30) * DAY * 1000).toISOString(),
      ...(o.paid === null ? {} : { latestSuccessfulOrderId: o.paid ?? o.order }),
      autoRenewingPlan: { autoRenewEnabled: o.autoRenew ?? true, recurringPrice: { currencyCode: 'INR', units: o.price ?? '499' } },
      offerDetails: { basePlanId: o.basePlan ?? 'monthly', ...(o.offer ? { offerId: o.offer, offerTags: ['intro'] } : {}) } }],
  };
  play.subs.set(token, s);
  return s;
}
/** An order in Play's Orders API, with the buyer details it really carries (none may reach an alert). */
const playOrder = (id: string, units: string, extra: any = {}) => play.orders.set(id, {
  orderId: id, state: 'PROCESSED', total: { currencyCode: 'INR', units }, tax: { currencyCode: 'INR', units: '45' },
  buyerAddress: { buyerState: 'Maharashtra', buyerCountry: 'IN', buyerPostcode: '400077' }, ...extra,
});
const googleVerify = (p: Person, productId: string, purchaseToken: string) => p.call('POST', '/billing/google/verify', { productId, purchaseToken });

beforeAll(async () => {
  BUILD_RETRY_MS.splice(0, BUILD_RETRY_MS.length, 20, 20, 20);
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  // Only this file writes owner alerts (every other file runs with OWNER_SALES_ALERT_EMAIL unset, test-setup.ts).
  await sql`delete from owner_sale_alerts`;
  setMailTransport(async m => {
    if (hold) await hold;
    if (mailDown) throw new Error('resend 503: service unavailable');
    mails.push(m as Mail);
    return { id: `re_${mails.length}` };
  });
  let block = 140;
  for (const n of NAMES) people[n] = await onboard(await signIn(app, n + D, '424242', block++), { name: `${cap(n)} Test`, gender: 'woman' });
  // Signed in with the review code; from here they read like real customers (hana stays internal through ADMIN_EMAILS).
  config.reviewEmails.splice(0);
  await sql`update users set attribution = ${sql.json({ source: 'Google Search', medium: 'organic', country: 'IN', device: 'Android', ip: '203.0.113.9', referrer: 'https://www.google.com/search?q=secret-query' })},
    emergency_contact_phone = '+919811122233' where id = ${people.esi.id}`;
  mails.length = 0;
});
afterAll(async () => {
  await settle();
  setMailTransport(null);
  await sql`delete from owner_sale_alerts`;
  await sql`delete from users where email like ${'%' + D}`;
  await app.close(); await sql.end(); vi.unstubAllGlobals(); fs.rmSync(saFile, { force: true });
});

describe('owner sale alerts: setup', () => {
  it('OWNER_SALES_ALERT_EMAIL: the one valid address once (case and duplicate folded), the invalid entry counted and logged', () => {
    expect(config.ownerSalesAlerts).toEqual({ valid: [OWNER], invalid: 1 });
    expect(ownerAlertsStartupLine()).toBe('owner sale alerts: on, 1 recipient; 1 invalid address in OWNER_SALES_ALERT_EMAIL ignored');
  });
});

describe('owner sale alerts: Razorpay (web)', () => {
  it('Trip Pass: one alert whichever confirms it first (the forwarded payment.captured, the app twice, order.paid)', async () => {
    const a = people.asha, orderId = `order_pass${R}`, payId = `pay_pass${R}`;
    const notes = { service: 'tablamigo', user_id: a.id, product: 'tablamigo_trip_pass' };
    rz.set(`/orders/${orderId}`, { id: orderId, entity: 'order', amount: 29900, currency: 'INR', status: 'paid', notes });
    rz.set(`/payments/${payId}`, { id: payId, entity: 'payment', order_id: orderId, amount: 29900, currency: 'INR', status: 'captured', method: 'upi',
      vpa: 'asha.rao@okaxis', contact: '+919876543210', email: a.email, notes, created_at: now() });
    expect((await post({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: rz.get(`/payments/${payId}`) } } })).json()).toEqual({ ok: true, result: 'ignored' });
    const body = { orderId, paymentId: payId, signature: hmac(`${orderId}|${payId}`, KEY_SECRET) };
    expect((await a.call('POST', '/billing/razorpay/pass-verify', body)).statusCode).toBe(200);
    expect((await a.call('POST', '/billing/razorpay/pass-verify', body)).statusCode).toBe(200);
    await post({ entity: 'event', event: 'order.paid', payload: { payment: { entity: rz.get(`/payments/${payId}`) }, order: { entity: rz.get(`/orders/${orderId}`) } } });
    await settle();

    expect(ownerAbout('asha')).toEqual([`Trip Pass purchase: Trip Pass (14 days), ₹299 — ${who('asha')}`]);
    const m = toOwner().find(x => x.subject.endsWith(`(asha${D})`))!;
    for (const s of ['Amount: ₹299 INR', 'Mode: Test mode (Razorpay test key)', `User id: ${a.id}`, `Razorpay payment id: ${payId}`, `Razorpay order id: ${orderId}`,
      `Open customer in admin: ${config.siteUrl}/admin#users?q=${a.id}`, `Alert key: rzp:pay:${payId}`]) expect(m.text).toContain(s);
    expect((await sql`select count(*)::int as n from passes where purchase_token = ${'rzp:' + payId}`)[0].n).toBe(1);
    expect(await alertRow(`rzp:pay:${payId}`)).toMatchObject({ status: 'sent', attempts: 1, subject: null, bodyText: null, test: true });
    expect(m.idempotencyKey).toMatch(/^tablamigo-owner-alert-[0-9a-f]{48}$/);

    // The refund: voided pass, one owner alert, and the customer's own refund email to her.
    const rf = rzRefund('asha', payId, 29900);
    expect((await post(refundEvent('refund.processed', rf))).json().result).toBe('pass:sent');
    expect((await post(refundEvent('refund.processed', rf))).json().result).toBe('pass:duplicate');
    await settle();
    expect(ownerAbout('asha')).toContain(`Refund: Trip Pass (14 days), ₹299 — ${who('asha')}`);
    expect(ownerAbout('asha')).toHaveLength(2);
    expect(mails.filter(x => x.to === a.email).map(x => x.subject)).toEqual(['Your refund of ₹299 is on its way']);
  });

  it('subscription: started, first charge, renewal, failed and halted renewal, ended; each once, even three deliveries at the same moment', async () => {
    const b = people.ben, s = rzSub(b, 'ben'), first = rzCharge(s, 1);
    expect((await subVerify(b, s, first)).statusCode).toBe(200);
    expect((await post(subEvent('subscription.authenticated', s))).json().result).toBe('synced');
    expect((await post(subEvent('subscription.activated', s))).json().result).toBe('synced');
    const charged = subEvent('subscription.charged', s, first);
    expect((await Promise.all([post(charged), post(charged), post(charged)])).map(r => r.statusCode)).toEqual([200, 200, 200]);
    await settle();

    Object.assign(s, { paid_count: 2, current_start: now(), current_end: now() + 59 * DAY, charge_at: now() + 59 * DAY });
    const second = rzCharge(s, 2);
    await post(subEvent('subscription.charged', s, second)); await post(subEvent('subscription.charged', s, second));
    Object.assign(s, { status: 'pending' });
    await post(subEvent('subscription.pending', s)); await post(subEvent('subscription.pending', s));
    Object.assign(s, { status: 'halted' });
    await post(subEvent('subscription.halted', s)); await post(subEvent('subscription.halted', s));
    // SC-05: we cancel a halted subscription at once and its unpaid period ends Plus; Razorpay's own end events add nothing.
    expect((await sql`select ended_reason from subscriptions where purchase_token = ${'rzp:' + s.id}`)[0].endedReason).toBe('halted');
    Object.assign(s, { status: 'completed' });
    await post(subEvent('subscription.completed', s)); await post(subEvent('subscription.completed', s));
    await settle();

    expect(ownerAbout('ben').sort()).toEqual([
      `New subscription: Plus monthly, ₹499 — ${who('ben')}`,
      `First charge: Plus monthly, ₹499 — ${who('ben')}`,
      `Renewal: Plus monthly, ₹499 — ${who('ben')}`,
      `Renewal failed: Plus monthly, ₹499 — ${who('ben')}`,
      `Renewal halted: Plus monthly, ₹499 — ${who('ben')}`,
    ].sort());
    const renewal = toOwner().find(x => x.subject.startsWith('Renewal: ') && x.subject.endsWith(`(ben${D})`))!;
    for (const t of [`Razorpay payment id: ${second}`, `Razorpay subscription id: ${s.id}`, 'Charge number: 2', `https://dashboard.razorpay.com/app/payments/${second}`]) expect(renewal.text).toContain(t);
    const started = toOwner().find(x => x.subject.includes('New subscription') && x.subject.endsWith(`(ben${D})`))!;
    expect(started.text).toContain('Amount: ₹499 INR (plan price per month; not a charge)');
  });

  it("cancelled in the app, then Razorpay's subscription.cancelled, then a refund: one owner alert each; the customer's own emails go only to her", async () => {
    const c = people.cara, s = rzSub(c, 'cara'), pay = rzCharge(s, 1);
    expect((await subVerify(c, s, pay)).statusCode).toBe(200);
    expect((await c.call('POST', '/billing/razorpay/cancel')).statusCode).toBe(200);
    expect((await c.call('POST', '/billing/razorpay/cancel')).statusCode).toBe(200);
    Object.assign(s, { status: 'cancelled', ended_at: now() });
    // The app's Cancel already sent the customer's email (same key): the webhook adds nothing.
    expect((await post(subEvent('subscription.cancelled', s))).json().result).toBe('cancelled:duplicate');
    expect((await post(subEvent('subscription.cancelled', s))).json().result).toBe('cancelled:duplicate');
    const rf = rzRefund('cara', pay, 49900);
    expect((await post(refundEvent('refund.created', rf))).json().result).toBe('subscription:sent');
    expect((await post(refundEvent('refund.processed', rf))).json().result).toBe('subscription:duplicate');
    await settle();

    expect(ownerAbout('cara').sort()).toEqual([
      `New subscription: Plus monthly, ₹499 — ${who('cara')}`,
      `First charge: Plus monthly, ₹499 — ${who('cara')}`,
      `Cancellation requested: Plus monthly, ₹499 — ${who('cara')}`,
      `Refund: Plus monthly, ₹499 — ${who('cara')}`,
    ].sort());
    const refund = toOwner().find(x => x.subject.includes('Refund:') && x.subject.endsWith(`(cara${D})`))!;
    for (const t of [`Razorpay refund id: ${rf.id}`, `Razorpay payment id: ${pay}`, `Razorpay subscription id: ${s.id}`, 'Plus from it: ended now']) expect(refund.text).toContain(t);
    expect(toOwner().find(x => x.subject.includes('Cancellation requested') && x.subject.endsWith(`(cara${D})`))!.text).toContain('Requested in: the Tablamigo app');
    // The customer's receipts: to her, once each, and never to the owner.
    expect(mails.filter(m => m.to === c.email).map(m => m.subject).sort()).toEqual(['Your Plus subscription is cancelled', 'Your refund of ₹499 is on its way']);
    expect(toOwner().some(m => /^Your /.test(m.subject))).toBe(false);
  });

  it('forged, foreign or unverifiable Razorpay events: no alert', async () => {
    const d = people.dev, s = rzSub(d, 'dev'), pay = rzCharge(s, 1);
    expect((await subVerify(d, s, pay)).statusCode).toBe(200);
    await settle();
    expect(ownerAbout('dev')).toHaveLength(2);   // the real start and first charge

    const ev = subEvent('subscription.charged', s, pay), raw = JSON.stringify(ev);
    const hook = (body: string, sig?: string) => app.inject({ method: 'POST', url: '/billing/razorpay/webhook', payload: body, headers: { 'content-type': 'application/json', ...(sig ? { 'x-tablamigo-signature': sig } : {}) } });
    expect((await hook(raw)).statusCode).toBe(401);
    expect((await hook(raw, hmac(raw, 'not-the-forward-secret'))).statusCode).toBe(401);
    expect((await hook(raw.replace('"paid_count":1', '"paid_count":9'), hmac(raw, FORWARD))).statusCode).toBe(401);
    expect((await hook(raw, hmac(raw, KEY_SECRET))).statusCode).toBe(401);   // Razorpay's own key is not the forward secret
    // Signed, but another product's subscription.
    expect((await post(subEvent('subscription.charged', { ...s, notes: { service: 'hookpost', user_id: d.id } }, pay))).json().result).toBe('ignored');
    // Signed and ours, but a payment Razorpay doesn't know, one it didn't capture, and another subscription's payment.
    expect((await post({ ...ev, payload: { ...ev.payload, payment: { entity: { id: `pay_ghost${R}` } } } })).json().result).toBe('synced');
    const failedPay = rzCharge(s, 2, { status: 'failed' });
    expect((await post(subEvent('subscription.charged', s, failedPay))).json().result).toBe('synced');
    const other = rzSub(people.jai, 'jaiother'), otherPay = rzCharge(other, 1);
    expect((await post(subEvent('subscription.charged', s, otherPay))).json().result).toBe('synced');
    // A signed payment.captured whose order belongs to another product, and one for a user who doesn't exist.
    rz.set(`/orders/order_vet${R}`, { id: `order_vet${R}`, entity: 'order', notes: { service: 'vetnow', user_id: d.id, product: 'tablamigo_trip_pass' } });
    rz.set(`/payments/pay_vet${R}`, { id: `pay_vet${R}`, entity: 'payment', order_id: `order_vet${R}`, status: 'captured', amount: 29900, currency: 'INR', notes: { service: 'tablamigo', user_id: d.id } });
    rz.set(`/orders/order_nobody${R}`, { id: `order_nobody${R}`, entity: 'order', notes: { service: 'tablamigo', user_id: crypto.randomUUID(), product: 'tablamigo_trip_pass' } });
    rz.set(`/payments/pay_nobody${R}`, { id: `pay_nobody${R}`, entity: 'payment', order_id: `order_nobody${R}`, status: 'captured', amount: 29900, currency: 'INR', notes: {} });
    for (const id of [`pay_vet${R}`, `pay_nobody${R}`]) expect((await post({ entity: 'event', event: 'payment.captured', payload: { payment: { entity: { id, notes: { service: 'tablamigo' } } } } })).statusCode).toBe(200);
    await settle();
    expect(ownerAbout('dev')).toHaveLength(2);
    expect(toOwner().some(m => /ghost|pay_vet|pay_nobody|jaiother/.test(m.text))).toBe(false);
    expect((await sql`select count(*)::int as n from owner_sale_alerts where event_key = any(${[`rzp:pay:pay_ghost${R}`, `rzp:pay:${failedPay}`, `rzp:pay:${otherPay}`, `rzp:pay:pay_vet${R}`, `rzp:pay:pay_nobody${R}`]}::text[])`)[0].n).toBe(0);
  });

  it('email provider down: the webhook still answers 200 and Plus is applied; the alert goes out once on redelivery or by the retry job', async () => {
    const p = people.ivo, s = rzSub(p, 'ivo'), c1 = rzCharge(s, 1);
    expect((await subVerify(p, s, c1)).statusCode).toBe(200);
    await settle();
    expect(ownerAbout('ivo')).toHaveLength(2);

    Object.assign(s, { paid_count: 2, current_end: now() + 59 * DAY });
    const c2 = rzCharge(s, 2);
    mailDown = true;
    try {
      const r = await post(subEvent('subscription.charged', s, c2));
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true, result: 'synced' });
      await settle();
      expect(new Date((await sql`select plus_until from users where id = ${p.id}`)[0].plusUntil).getTime()).toBe(s.current_end * 1000);
      const failed = await alertRow(`rzp:pay:${c2}`);
      expect(failed.status).toBe('failed');
      expect(failed.error).toContain('resend 503');
      expect(failed.subject).toContain('Renewal');   // kept for the retry
      expect((await post(subEvent('subscription.charged', s, c2))).statusCode).toBe(200);
      await settle();
      expect((await alertRow(`rzp:pay:${c2}`)).status).toBe('failed');
    } finally { mailDown = false; }
    await post(subEvent('subscription.charged', s, c2)); await post(subEvent('subscription.charged', s, c2));
    await settle();
    expect(ownerAbout('ivo').filter(x => x.includes('Renewal:'))).toHaveLength(1);
    expect(await alertRow(`rzp:pay:${c2}`)).toMatchObject({ status: 'sent', subject: null, bodyText: null });
    expect(await retryFailedOwnerAlerts()).toBe(0);

    // The next one fails and nothing redelivers it: the email jobs' retry sends it, once.
    Object.assign(s, { paid_count: 3 });
    const c3 = rzCharge(s, 3);
    mailDown = true;
    try { await post(subEvent('subscription.charged', s, c3)); await settle(); } finally { mailDown = false; }
    expect(await retryFailedOwnerAlerts()).toBe(1);
    expect(await retryFailedOwnerAlerts()).toBe(0);
    expect(ownerAbout('ivo').filter(x => x.includes('Renewal:'))).toHaveLength(2);

    // The retry job and a redelivery reaching the same failed alert at the same moment: one email.
    Object.assign(s, { paid_count: 4 });
    const c4 = rzCharge(s, 4);
    mailDown = true;
    try { await post(subEvent('subscription.charged', s, c4)); await settle(); } finally { mailDown = false; }
    const [sentByJob] = await Promise.all([retryFailedOwnerAlerts(), post(subEvent('subscription.charged', s, c4))]);
    await settle();
    expect(sentByJob).toBeLessThanOrEqual(1);
    expect(ownerAbout('ivo').filter(x => x.includes('Renewal:'))).toHaveLength(3);

    // Retries stop after MAX_ATTEMPTS, and the unsent copy is cleared: a dead alert is never sent later.
    Object.assign(s, { paid_count: 5 });
    const c5 = rzCharge(s, 5);
    mailDown = true;
    try { await post(subEvent('subscription.charged', s, c5)); await settle(); } finally { mailDown = false; }
    await sql`update owner_sale_alerts set attempts = ${MAX_ATTEMPTS} where event_key = ${'rzp:pay:' + c5}`;
    expect(await retryFailedOwnerAlerts()).toBe(0);
    expect(await alertRow(`rzp:pay:${c5}`)).toMatchObject({ status: 'failed', subject: null, bodyText: null });
    await post(subEvent('subscription.charged', s, c5)); await settle();
    expect(ownerAbout('ivo').filter(x => x.includes('Renewal:'))).toHaveLength(3);
  });

  it('a slow email provider does not hold up the webhook', async () => {
    const p = people.ivo, s = rzSub(p, 'ivoslow'), c = rzCharge(s, 1);
    const before = ownerAbout('ivo').length;
    let release!: () => void;
    hold = new Promise<void>(r => { release = r; });
    try {
      const t0 = Date.now();
      const r = await post(subEvent('subscription.charged', s, c));
      expect(r.statusCode).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2000);
      // The alert is written after the webhook answered, so poll for it (a fixed 100 ms wait failed on a busy CI runner).
      // The provider is held, so the row stays pending until release(): the wait can only end on 'pending' or time out.
      await vi.waitFor(async () => expect(await alertRow(`rzp:pay:${c}`)).toMatchObject({ status: 'pending' }), { timeout: 5000, interval: 50 });
    } finally { hold = null; release(); }
    await settle();
    expect(await alertRow(`rzp:pay:${c}`)).toMatchObject({ status: 'sent' });
    expect(ownerAbout('ivo')).toHaveLength(before + 2);   // that subscription's start and first charge
  });

  it('Razorpay unreachable for a moment while an alert is built: retried; down for longer: the next delivery brings it', async () => {
    const p = people.max, s = rzSub(p, 'max'), c1 = rzCharge(s, 1);
    rzDown.set(`/payments/${c1}`, 1);
    expect((await subVerify(p, s, c1)).statusCode).toBe(200);
    await settle();
    expect(ownerAbout('max').sort()).toEqual([`First charge: Plus monthly, ₹499 — ${who('max')}`, `New subscription: Plus monthly, ₹499 — ${who('max')}`].sort());

    Object.assign(s, { paid_count: 2 });
    const c2 = rzCharge(s, 2);
    rzDown.set(`/payments/${c2}`, 50);
    expect((await post(subEvent('subscription.charged', s, c2))).json().result).toBe('synced');
    await settle();
    expect(ownerAbout('max')).toHaveLength(2);
    expect(await alertRow(`rzp:pay:${c2}`)).toBeUndefined();   // nothing claimed, so a later delivery can still send it
    rzDown.delete(`/payments/${c2}`);
    await post(subEvent('subscription.charged', s, c2));
    await settle();
    expect(ownerAbout('max').filter(x => x.includes('Renewal:'))).toHaveLength(1);

    // A charge Razorpay didn't invoice: the payment's own notes (ours, this user's) tie it to the subscription.
    Object.assign(s, { paid_count: 3 });
    const c3 = rzCharge(s, 3, {}, false);
    await post(subEvent('subscription.charged', s, c3));
    await settle();
    expect(toOwner().some(m => m.text.includes(`Razorpay payment id: ${c3}`))).toBe(true);
  });

  it('the periodic pull alerts what the forwarded webhook missed (a renewal, a halt); the late webhook adds nothing; a real plan change', async () => {
    const p = people.lea, s = rzSub(p, 'lea'), c1 = rzCharge(s, 1);
    expect((await subVerify(p, s, c1)).statusCode).toBe(200);
    await settle();
    Object.assign(s, { paid_count: 2, current_end: now() + 59 * DAY });
    const c2 = rzCharge(s, 2);
    await pull(p);
    await settle();
    expect(ownerAbout('lea').filter(x => x.includes('Renewal:'))).toEqual([`Renewal: Plus monthly, ₹499 — ${who('lea')}`]);
    await post(subEvent('subscription.charged', s, c2));
    await settle();
    expect(ownerAbout('lea')).toHaveLength(3);

    // subscription.updated with the same plan says nothing; a move to the yearly plan is a plan change, once.
    expect((await post(subEvent('subscription.updated', s))).json().result).toBe('synced');
    Object.assign(s, { plan_id: 'plan_yearly_fake' });
    await post(subEvent('subscription.updated', s)); await post(subEvent('subscription.updated', s));
    Object.assign(s, { status: 'halted' });
    await pull(p);
    await settle();
    expect(ownerAbout('lea').sort()).toEqual([
      `New subscription: Plus monthly, ₹499 — ${who('lea')}`,
      `First charge: Plus monthly, ₹499 — ${who('lea')}`,
      `Renewal: Plus monthly, ₹499 — ${who('lea')}`,
      `Plan change: Plus yearly, ₹3,999 — ${who('lea')}`,
      `Renewal halted: Plus yearly, ₹3,999 — ${who('lea')}`,
    ].sort());
    expect(toOwner().find(x => x.subject.includes('Plan change') && x.subject.endsWith(`(lea${D})`))!.text).toContain('Previous plan: Plus monthly');
  });

  it('paid event ticket: one alert from the verify call and the forwarded order.paid; its refund is alerted too', async () => {
    const saved = config.features.paidEvents;
    config.features.paidEvents = true;
    try {
      const plan = await createPlan(people.asha, { title: 'Sunset kayak', isPaid: true, ticketPricePaise: 50000, maxPeople: 10 });
      const k = people.kai;
      const o = await k.call('POST', `/activities/${plan.id}/ticket/order`);
      expect(o.statusCode).toBe(200);
      const orderId = o.json().orderId as string, payId = `pay_tkt${R}`;
      rz.set(`/payments/${payId}`, { id: payId, entity: 'payment', order_id: orderId, amount: 50000, currency: 'INR', status: 'captured', notes: rz.get(`/orders/${orderId}`).notes, method: 'upi', vpa: 'kai@okhdfc', created_at: now() });
      const v = await k.call('POST', `/activities/${plan.id}/ticket/verify`, { orderId, paymentId: payId, signature: hmac(`${orderId}|${payId}`, KEY_SECRET) });
      expect(v.statusCode).toBe(200);
      await post({ entity: 'event', event: 'order.paid', payload: { payment: { entity: rz.get(`/payments/${payId}`) }, order: { entity: rz.get(`/orders/${orderId}`) } } });
      await settle();
      expect(ownerAbout('kai')).toEqual([`Ticket purchase: Event ticket, ₹500 — ${who('kai')}`]);
      const m = toOwner().find(x => x.subject.endsWith(`(kai${D})`))!;
      expect(m.text).toContain('Event: Sunset kayak');
      expect(m.text).not.toContain(v.json().ticket.ticketCode);   // the check-in code is the buyer's, not in the alert
      const rf = rzRefund('kai', payId, 50000);
      expect((await post(refundEvent('refund.processed', rf))).json().result).toBe('no_subscription');
      await settle();
      expect(ownerAbout('kai')).toContain(`Refund: Event ticket, ₹500 — ${who('kai')}`);
    } finally { config.features.paidEvents = saved; }
  });

  it('labels: Live for a live key and a real customer (with sign-up source, never IP or phone); an internal account on a live key is Live too, with an Internal account badge, never test', async () => {
    const saved = config.razorpay.keyId;
    let hc = '';
    try {
      config.razorpay.keyId = 'rzp_live_fake';
      const e = rzSub(people.esi, 'esi'), ec = rzCharge(e, 1);
      const h = rzSub(people.hana, 'hana');
      hc = rzCharge(h, 1);
      await post(subEvent('subscription.charged', e, ec));
      await post(subEvent('subscription.charged', h, hc));
      await settle();
    } finally { config.razorpay.keyId = saved; }
    expect(ownerAbout('esi').sort()).toEqual([`First charge: Plus monthly, ₹499 — ${who('esi')}`, `New subscription: Plus monthly, ₹499 — ${who('esi')}`].sort());
    const esi = toOwner().find(x => x.subject.startsWith('First charge') && x.subject.endsWith(`(esi${D})`))!;
    expect(esi.text).toContain('Mode: Live');
    expect(esi.text).toMatch(/Signed up: \d{1,2} [A-Z][a-z]{2} \d{4} · source Google Search \/ organic · country IN · device Android/);
    for (const leak of ['203.0.113.9', 'secret-query', '+919811122233']) expect(esi.text + esi.html).not.toContain(leak);
    expect(ownerAbout('hana').sort()).toEqual([`First charge: Plus monthly, ₹499 — ${who('hana')}`, `New subscription: Plus monthly, ₹499 — ${who('hana')}`].sort());
    const hana = toOwner().find(x => x.subject.startsWith('First charge') && x.subject.endsWith(`(hana${D})`))!;
    expect(hana.text).toContain('Mode: Live (internal account (ADMIN_EMAILS))');
    expect(hana.html).toContain('Internal account · live money');
    expect(hana.html).not.toContain('Test mode');
    expect(await alertRow(`rzp:pay:${hc}`)).toMatchObject({ test: false });
    expect(esi.html).not.toContain('Test mode');
    expect(esi.html).not.toContain('Internal account');
  });

  it('with OWNER_SALES_ALERT_EMAIL unset: no email, no row, and the webhook works as before', async () => {
    const saved = config.ownerSalesAlerts;
    const s = rzSub(people.gus, 'gusoff'), c = rzCharge(s, 1);
    try {
      config.ownerSalesAlerts = { valid: [], invalid: 0 };
      expect(ownerAlertsStartupLine()).toBe('owner sale alerts: off (OWNER_SALES_ALERT_EMAIL unset)');
      expect((await post(subEvent('subscription.charged', s, c))).json()).toEqual({ ok: true, result: 'synced' });
      await settle();
    } finally { config.ownerSalesAlerts = saved; }
    expect(ownerAbout('gus')).toEqual([]);
    expect(await alertRow(`rzp:pay:${c}`)).toBeUndefined();
    expect(await alertRow(`rzp:sub_started:${s.id}`)).toBeUndefined();
    expect((await sql`select status from subscriptions where purchase_token = ${'rzp:' + s.id}`)[0].status).toBe('SUBSCRIPTION_STATE_ACTIVE');
  });
});

describe('owner sale alerts: Razorpay state the forward missed', () => {
  it("subscription.cancelled that also carries a renewal nobody forwarded: the renewal is alerted, and the cancellation once", async () => {
    const p = people.oli, s = rzSub(p, 'oli'), c1 = rzCharge(s, 1);
    expect((await subVerify(p, s, c1)).statusCode).toBe(200);
    Object.assign(s, { paid_count: 2, current_end: now() + 59 * DAY });
    const c2 = rzCharge(s, 2);   // its subscription.charged never arrives
    Object.assign(s, { status: 'cancelled', ended_at: now() });
    expect((await post(subEvent('subscription.cancelled', s))).json().result).toBe('cancelled:sent');
    await settle();
    expect(ownerAbout('oli').sort()).toEqual([
      `New subscription: Plus monthly, ₹499 — ${who('oli')}`,
      `First charge: Plus monthly, ₹499 — ${who('oli')}`,
      `Renewal: Plus monthly, ₹499 — ${who('oli')}`,
      `Cancelled: Plus monthly, ₹499 — ${who('oli')}`,
    ].sort());
    expect(toOwner().some(m => m.text.includes(`Razorpay payment id: ${c2}`))).toBe(true);
  });

  it('history is not news: a stored copy that fell behind, or a subscription first seen long after it started, alerts nothing old', async () => {
    const p = people.pia, old = now() - 10 * DAY;
    // Stored when it had one charge; Razorpay has since charged twice more and ended it, all 10 days ago.
    const s = rzSub(p, 'piaold', { paid_count: 3, status: 'cancelled', ended_at: old, created_at: now() - 70 * DAY });
    for (const n of [1, 2, 3]) { rzCharge(s, n); rz.get(`/invoices/inv_${s.id.slice(4)}c${n}`).paid_at = old - (3 - n) * DAY; }
    // And one halted a month ago, at the end of a cycle that ended 35 days ago, stored while still active.
    const h = rzSub(p, 'piahalt', { status: 'halted', current_end: now() - 35 * DAY, created_at: now() - 100 * DAY });
    for (const [sub, raw] of [[s, { ...s, paid_count: 1, status: 'active', ended_at: null }], [h, { ...h, status: 'active' }]] as const) {
      await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, raw)
        values (${'rzp:' + sub.id}, ${p.id}, 'razorpay', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', now() + interval '5 days', ${sql.json(raw)})`;
    }
    await pull(p);
    // Never stored (its checkout was never confirmed), started 40 days ago, last charged 10 days ago.
    const t = rzSub(p, 'piastale', { created_at: now() - 40 * DAY });
    rzCharge(t, 1); rz.get(`/invoices/inv_${t.id.slice(4)}c1`).paid_at = old;
    expect((await post(subEvent('subscription.activated', t))).json().result).toBe('synced');
    await settle();
    expect(ownerAbout('pia')).toEqual([]);
    expect((await sql`select status from subscriptions where purchase_token = ${'rzp:' + s.id}`)[0].status).toBe('SUBSCRIPTION_STATE_CANCELED');
  });

  it('two renewals missed by the forward: the pull alerts both', async () => {
    const p = people.pia, s = rzSub(p, 'pianew'), c1 = rzCharge(s, 1);
    // Pia's subscription from the test above still renews; a second one would be refused at verify (billing-scenarios.test.ts).
    await sql`update subscriptions set cancel_requested_at = now() where user_id = ${p.id} and platform = 'razorpay'`;
    expect((await subVerify(p, s, c1)).statusCode).toBe(200);
    Object.assign(s, { paid_count: 3 });
    const c2 = rzCharge(s, 2), c3 = rzCharge(s, 3);
    await pull(p);
    await settle();
    expect(ownerAbout('pia').filter(x => x.includes('Renewal:'))).toHaveLength(2);
    for (const c of [c2, c3]) expect(toOwner().some(m => m.text.includes(`Razorpay payment id: ${c}`))).toBe(true);
    expect(ownerAbout('pia')).toHaveLength(4);
  });
});

describe('owner sale alerts: Google Play (app)', () => {
  it('subscription: purchase, renewal, cancellation request and refund; one alert each however often Google pushes it', async () => {
    const f = people.fay, token = playToken('fay'), o1 = order('1111'), o2 = `${o1}..0`;
    playSub(token, { order: o1 });
    playOrder(o1, '499');
    expect((await googleVerify(f, 'tablamigo_plus', token)).statusCode).toBe(200);
    expect((await googleVerify(f, 'tablamigo_plus', token)).statusCode).toBe(200);
    expect((await rtdn(subNote(token, 4))).json()).toEqual({ ok: true });
    await settle();
    expect(ownerAbout('fay')).toEqual([`New subscription: Plus monthly, ₹499 — ${who('fay')}`]);
    const bought = toOwner().find(x => x.subject.endsWith(`(fay${D})`))!;
    for (const t of [`Google Play order id: ${o1}`, "Amount: ₹499 INR (order total, before Google's fee)", 'Mode: Live', 'Play state: active', 'Auto-renew: on', `User id: ${f.id}`]) expect(bought.text).toContain(t);

    playSub(token, { order: o2, days: 60 });
    playOrder(o2, '499');
    const id = String(++msgN);
    await rtdn(subNote(token, 2), { messageId: id }); await rtdn(subNote(token, 2), { messageId: id }); await rtdn(subNote(token, 2));
    playSub(token, { order: o2, days: 60, state: 'SUBSCRIPTION_STATE_CANCELED', autoRenew: false, cancel: { userInitiatedCancellation: { cancelTime: new Date().toISOString() } } });
    await rtdn(subNote(token, 3)); await rtdn(subNote(token, 3));
    playOrder(o2, '499', { state: 'REFUNDED', orderHistory: { refundEvent: { refundDetails: { total: { currencyCode: 'INR', units: '499' } } } } });
    const voided = { voidedPurchaseNotification: { purchaseToken: token, orderId: o2, productType: 1, refundType: 1 } };
    // Not in Google's voided list yet: nothing changes and nothing is alerted (a forged or early push).
    expect((await rtdn(voided)).statusCode).toBe(200);
    await settle();
    expect(ownerAbout('fay').some(x => x.startsWith('Refund'))).toBe(false);
    voidOnPlay(token, { purchaseToken: token, orderId: o2, voidedReason: 1, voidedSource: 0 });
    expect((await rtdn(voided)).statusCode).toBe(200); await rtdn(voided);
    await settle();
    expect(ownerAbout('fay').sort()).toEqual([
      `New subscription: Plus monthly, ₹499 — ${who('fay')}`,
      `Renewal: Plus monthly, ₹499 — ${who('fay')}`,
      `Cancellation requested: Plus monthly, ₹499 — ${who('fay')}`,
      `Refund: Plus monthly, ₹499 — ${who('fay')}`,
    ].sort());
    const cancelled = toOwner().find(x => x.subject.startsWith('Cancellation requested') && x.subject.endsWith(`(fay${D})`))!;
    expect(cancelled.text).toContain('Cancelled by: the customer');
    expect(cancelled.text).toContain('(list price per period; not a charge)');
    expect(toOwner().find(x => x.subject.startsWith('Refund') && x.subject.endsWith(`(fay${D})`))!.text).toContain('Amount: ₹499 INR (refunded)');
  });

  it('an intro offer: the alert names it in words, the subscription keeps it after renewals, and the admin panel shows it', async () => {
    const q = people.quin, token = playToken('quin'), o1 = order('6161'), o2 = `${o1}..0`;
    playSub(token, { order: o1, offer: 'monthly-intro-50' });
    playOrder(o1, '249');
    expect((await googleVerify(q, 'tablamigo_plus', token)).statusCode).toBe(200);
    await settle();
    const bought = toOwner().find(x => x.subject.startsWith('New subscription') && x.subject.endsWith(`(quin${D})`))!;
    expect(bought.subject).toBe(`New subscription: Plus monthly, ₹249 — ${who('quin')}`);
    expect(bought.text).toContain('Offer: monthly-intro-50 (first month 50% off)');
    const offerOf = async () => (await sql`select offer_id from subscriptions where purchase_token = ${token}`)[0].offerId;
    expect(await offerOf()).toBe('monthly-intro-50');
    // A later copy of the purchase that no longer names the offer leaves the record as it was.
    playSub(token, { order: o2, days: 60 }); playOrder(o2, '499');
    await rtdn(subNote(token, 2)); await settle();
    expect(await offerOf()).toBe('monthly-intro-50');
    expect(toOwner().find(x => x.subject.startsWith('Renewal') && x.subject.endsWith(`(quin${D})`))!.text).not.toContain('Offer:');
    const admin = (await people.hana.call('GET', '/admin/subscriptions')).json();
    expect(admin.subscriptions.find((s: any) => s.userId === q.id)).toMatchObject({ offer: 'monthly-intro-50 (first month 50% off)', plan: 'monthly' });
    expect(admin.subscriptions.every((s: any) => !('offerId' in s) && !('purchaseToken' in s))).toBe(true);
    const drawer = (await people.hana.call('GET', `/admin/users/${q.id}`)).json();
    expect(drawer.subscriptions[0].offer).toBe('monthly-intro-50 (first month 50% off)');
  });

  it('the yearly trial offer: an order of 0 reads as a free trial, not a lost sale', async () => {
    const q = people.quin, token = playToken('quintrial'), o1 = order('6262');
    await sql`update subscriptions set cancel_requested_at = now() where user_id = ${q.id}`;
    playSub(token, { order: o1, basePlan: 'yearly', offer: 'yearly-trial-3d', price: '3999' });
    playOrder(o1, '0');
    expect((await googleVerify(q, 'tablamigo_plus', token)).statusCode).toBe(200);
    await settle();
    const m = toOwner().find(x => x.subject.startsWith('New subscription: Plus yearly') && x.subject.endsWith(`(quin${D})`))!;
    expect(m.text).toContain('Offer: yearly-trial-3d (3-day free trial, then first year 20% off)');
  });

  it('payment problems and endings: grace period, on hold, recovered, revoked, expired; one alert each, and a recovery is a charge', async () => {
    const g = people.gus, token = playToken('gus'), o1 = order('2222'), o2 = `${o1}..0`;
    playSub(token, { order: o1 });
    expect((await googleVerify(g, 'tablamigo_plus', token)).statusCode).toBe(200);
    const twice = async (type: number) => { await rtdn(subNote(token, type)); await rtdn(subNote(token, type)); };
    playSub(token, { order: o2, paid: o1, state: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD' }); await twice(6);
    playSub(token, { order: o2, paid: o1, state: 'SUBSCRIPTION_STATE_ON_HOLD' }); await twice(5);
    playSub(token, { order: o2, days: 30 }); await twice(1);
    playSub(token, { order: o2, state: 'SUBSCRIPTION_STATE_EXPIRED', days: -1 }); await twice(12);
    await twice(13);
    await settle();
    expect(ownerAbout('gus').sort()).toEqual([
      `New subscription: Plus monthly, ₹499 — ${who('gus')}`,
      `Grace period: Plus monthly, ₹499 — ${who('gus')}`,
      `On hold: Plus monthly, ₹499 — ${who('gus')}`,
      `Renewal recovered: Plus monthly, ₹499 — ${who('gus')}`,
      `Revoked: Plus monthly, ₹499 — ${who('gus')}`,
      `Subscription ended: Plus monthly, ₹499 — ${who('gus')}`,
    ].sort());
    // No Orders API entry for these orders: the list price, said to be one.
    expect(toOwner().find(x => x.subject.includes('Renewal recovered') && x.subject.endsWith(`(gus${D})`))!.text).toContain('(list price; Google did not report the order total)');
  });

  it('a Play test purchase is test mode, and so is its partial refund; paused, resubscribed and plan change each alert once', async () => {
    const b = people.ben, token = playToken('bentest'), o = order('3333');
    playSub(token, { order: o, test: true, basePlan: 'weekly', price: '149' });
    expect((await googleVerify(b, 'tablamigo_plus', token)).statusCode).toBe(200);
    for (const t of [10, 10, 7, 7, 17, 17]) await rtdn(subNote(token, t));
    playOrder(o, '149', { orderHistory: { partialRefundEvents: [{ refundDetails: { total: { currencyCode: 'INR', units: '50' } } }, { refundDetails: { total: { currencyCode: 'INR', units: '25' } } }] } });
    voidOnPlay(token, { purchaseToken: token, orderId: o, voidedReason: 1, voidedSource: 1 });
    await rtdn({ voidedPurchaseNotification: { purchaseToken: token, orderId: o, productType: 1, refundType: 2 } });
    await settle();
    const play = toOwner().filter(x => x.text.includes(`Google Play order id: ${o}`)).map(x => x.subject);
    expect(play.sort()).toEqual([
      `New subscription: Plus weekly, ₹149 — ${who('ben')}`,
      `Paused: Plus weekly, ₹149 — ${who('ben')}`,
      `Resubscribed: Plus weekly, ₹149 — ${who('ben')}`,
      `Plan change: Plus weekly, ₹149 — ${who('ben')}`,
      `Refund: Plus weekly, ₹75 — ${who('ben')}`,
    ].sort());
    expect(toOwner().find(x => x.subject.includes('New subscription: Plus weekly'))!.text).toContain('Mode: Test mode (Google Play test purchase (license tester))');
    expect(toOwner().find(x => x.subject.includes('Refund: Plus weekly'))!.text).toContain('Refund: partial');
  });

  it('Trip Pass in the app: one purchase alert; a refund alert only once Google confirms the void, once; a pass with no order id still alerts once', async () => {
    const j = people.jai, token = playToken('jaipass'), o = order('4444');
    play.passes.set(token, { purchaseState: 0, consumptionState: 0, orderId: o, regionCode: 'IN', purchaseTimeMillis: String(Date.now()), purchaseToken: token });
    playOrder(o, '299');
    expect((await googleVerify(j, 'tablamigo_trip_pass', token)).statusCode).toBe(200);
    expect((await googleVerify(j, 'tablamigo_trip_pass', token)).statusCode).toBe(200);
    const voided = { voidedPurchaseNotification: { purchaseToken: token, orderId: o, productType: 2, refundType: 1 } };
    // A void Google doesn't confirm (the pass is still purchased): nothing changes, no alert.
    expect((await rtdn(voided)).statusCode).toBe(200);
    await settle();
    expect((await sql`select voided_at from passes where purchase_token = ${token}`)[0].voidedAt).toBeNull();
    expect(ownerAbout('jai')).toEqual([`Trip Pass purchase: Trip Pass (14 days), ₹299 — ${who('jai')}`]);
    play.passes.get(token).purchaseState = 1;
    await rtdn(voided); await rtdn(voided);
    await settle();
    expect((await sql`select voided_at from passes where purchase_token = ${token}`)[0].voidedAt).not.toBeNull();
    expect(ownerAbout('jai').sort()).toEqual([`Refund: Trip Pass (14 days), ₹299 — ${who('jai')}`, `Trip Pass purchase: Trip Pass (14 days), ₹299 — ${who('jai')}`]);

    const bare = playToken('jaibare');
    play.passes.set(bare, { purchaseState: 0, consumptionState: 0, regionCode: 'IN', purchaseType: 0 });
    expect((await googleVerify(j, 'tablamigo_trip_pass', bare)).statusCode).toBe(200);
    expect((await googleVerify(j, 'tablamigo_trip_pass', bare)).statusCode).toBe(200);
    await settle();
    expect(ownerAbout('jai').filter(x => x === `Trip Pass purchase: Trip Pass (14 days) — ${who('jai')}`)).toHaveLength(1);
    expect((await sql`select count(*)::int as n from owner_sale_alerts where event_key like 'play:pass:%' and user_id = ${j.id}`)[0].n).toBe(1);
  });

  it('an unauthenticated or foreign RTDN push: 401 or nothing, and no alert; the same push authenticated alerts once', async () => {
    const token = [...play.subs.keys()].find(t => t.startsWith('fay'))!, o3 = `${order('1111')}..1`;
    playSub(token, { order: o3, days: 90 });
    const saved = config.rtdnToken;
    try {
      config.rtdnToken = 'rtdn-osa-url-token';
      expect((await rtdn(subNote(token, 2))).statusCode).toBe(401);
      expect((await rtdn(subNote(token, 2), { query: '?token=rtdn-osa-url-tokeN' })).statusCode).toBe(401);
      await settle();
      expect(ownerAbout('fay').filter(x => x.includes('Renewal'))).toHaveLength(1);
      // Authenticated, but a purchase token that isn't ours: acknowledged, nothing done.
      const stranger = playToken('stranger');
      playSub(stranger, { order: order('9999') });
      expect((await rtdn(subNote(stranger, 4), { query: '?token=rtdn-osa-url-token' })).statusCode).toBe(200);
      expect((await rtdn({ voidedPurchaseNotification: { purchaseToken: stranger, orderId: order('9999'), productType: 1 } }, { query: '?token=rtdn-osa-url-token' })).statusCode).toBe(200);
      expect((await rtdn(subNote(token, 2), { query: '?token=rtdn-osa-url-token' })).statusCode).toBe(200);
      await settle();
    } finally { config.rtdnToken = saved; }
    expect(ownerAbout('fay').filter(x => x.includes('Renewal'))).toHaveLength(2);
    expect(toOwner().some(m => m.text.includes(order('9999')))).toBe(false);
    expect(await alertRow(`play:order:${order('9999')}`)).toBeUndefined();
  });

  it('email provider down during an RTDN renewal: 200 to Pub/Sub, Plus extended, the alert sent by the retry job', async () => {
    const f = people.fay, token = [...play.subs.keys()].find(t => t.startsWith('fay'))!, o4 = `${order('1111')}..2`;
    playSub(token, { order: o4, days: 120 });
    // Fay's subscription was refunded in the first Play test, which ended it for good (rule 4); this test needs it live.
    await sql`update subscriptions set ended_reason = null where purchase_token = ${token}`;
    mailDown = true;
    try {
      expect((await rtdn(subNote(token, 2))).json()).toEqual({ ok: true });
      await settle();
    } finally { mailDown = false; }
    const plus = new Date((await sql`select plus_until from users where id = ${f.id}`)[0].plusUntil).getTime();
    expect(plus).toBeGreaterThan(Date.now() + 100 * DAY * 1000);
    expect(await alertRow(`play:order:${o4}`)).toMatchObject({ status: 'failed' });
    expect(await retryFailedOwnerAlerts()).toBe(1);
    expect(ownerAbout('fay').filter(x => x.includes('Renewal'))).toHaveLength(3);
  });
});

describe('owner sale alerts: crashes, retention and deletion', () => {
  const copy = (n: Name) => ({ subject: `First charge: Plus monthly, ₹499 — ${who(n)}`, text: `Name: ${cap(n)} Test\nSent only to the owner (OWNER_SALES_ALERT_EMAIL).`, html: `<p>${cap(n)} Test</p>` });

  it('a claim left pending by a process that died mid-send is re-sent once (same Resend idempotency key); a fresh one is left alone', async () => {
    const n = people.noa, stale = `rzp:pay:pay_stale${R}`, fresh = `rzp:pay:pay_fresh${R}`, c = copy('noa');
    await sql`insert into owner_sale_alerts (event_key, kind, provider, user_id, test, status, subject, body_text, body_html, created_at, claimed_at)
      values (${stale}, 'first_charge', 'razorpay', ${n.id}, true, 'pending', ${c.subject}, ${c.text}, ${c.html}, now() - interval '20 minutes', now() - interval '20 minutes'),
             (${fresh}, 'first_charge', 'razorpay', ${n.id}, true, 'pending', ${c.subject}, ${c.text}, ${c.html}, now(), now())`;
    expect(await retryFailedOwnerAlerts()).toBe(1);
    expect(await retryFailedOwnerAlerts()).toBe(0);
    expect(await alertRow(stale)).toMatchObject({ status: 'sent', attempts: 2, subject: null });
    expect(await alertRow(fresh)).toMatchObject({ status: 'pending', attempts: 1 });
    const sent = toOwner().filter(m => m.subject === c.subject);
    expect(sent).toHaveLength(1);
    expect(sent[0].idempotencyKey).toMatch(/^tablamigo-owner-alert-[0-9a-f]{48}$/);
  });

  it('an unsent copy is cleared once it is out of attempts or older than 3 days, and when the customer deletes their account', async () => {
    const n = people.noa, c = copy('noa'), spent = `rzp:pay:pay_spent${R}`, old = `rzp:pay:pay_old${R}`, mine = `rzp:pay:pay_mine${R}`;
    await sql`insert into owner_sale_alerts (event_key, kind, provider, user_id, status, attempts, subject, body_text, body_html, created_at)
      values (${spent}, 'renewal', 'razorpay', ${n.id}, 'failed', ${MAX_ATTEMPTS}, ${c.subject}, ${c.text}, ${c.html}, now()),
             (${old}, 'renewal', 'razorpay', ${n.id}, 'failed', 1, ${c.subject}, ${c.text}, ${c.html}, now() - interval '4 days')`;
    expect(await retryFailedOwnerAlerts()).toBe(0);
    for (const k of [spent, old]) expect(await alertRow(k)).toMatchObject({ status: 'failed', subject: null, bodyText: null });

    mailDown = true;
    try {
      await sql`insert into owner_sale_alerts (event_key, kind, provider, user_id, status, subject, body_text, body_html)
        values (${mine}, 'renewal', 'razorpay', ${n.id}, 'failed', ${c.subject}, ${c.text}, ${c.html})`;
      expect((await n.call('DELETE', '/me')).statusCode).toBe(200);
    } finally { mailDown = false; }
    expect(await alertRow(mine)).toMatchObject({ status: 'failed', subject: null, bodyText: null });
    expect((await sql`select count(*)::int as n from owner_sale_alerts where user_id = ${n.id} and (subject ilike ${'%noa%'} or body_text ilike ${'%Noa%'} or body_html ilike ${'%Noa%'})`)[0].n).toBe(0);
  });
});

describe('owner sale alerts: what they carry and where they go', () => {
  it('no alert carries a purchase token, card, UPI, phone, IP, buyer address, ticket code, signature or key', () => {
    const all = toOwner().map(m => `${m.subject}\n${m.text}\n${m.html}`).join('\n');
    expect(toOwner().length).toBeGreaterThan(40);
    for (const secret of [...tokens, 'card_SECRET', 'last4', 'Visa', 'CARDHOLDER', 'token_ABCSECRET', 'okaxis', 'okhdfc', '+919876543210', '+919811122233', '203.0.113.9',
      'secret-query', KEY_SECRET, FORWARD, '400077', 'Maharashtra', 'obf-account-SECRET', 'purchaseToken', 'TM-TKT-']) expect(all, secret).not.toContain(secret);
  });

  it('every alert went to the owner only, and the owner got nothing else (customer emails stay with customers)', () => {
    for (const m of mails) expect(m.text.includes('Sent only to the owner (OWNER_SALES_ALERT_EMAIL)'), `${m.to}: ${m.subject}`).toBe(m.to === OWNER);
  });
});
