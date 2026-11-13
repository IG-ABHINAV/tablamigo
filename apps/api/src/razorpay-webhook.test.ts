// Razorpay events forwarded by Hookpost: signed fixtures in, state + emails out. Razorpay is a fake
// (fetch is stubbed) and mail goes to a recorder; nothing leaves the machine.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
process.env.REVIEW_EMAILS = 'gia@rzpwh.tablamigo,hal@rzpwh.tablamigo,ivy@rzpwh.tablamigo,jon@rzpwh.tablamigo,kim@rzpwh.tablamigo';
process.env.REVIEW_CODE = '424242';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret';
process.env.TABLAMIGO_FORWARD_SECRET = 'forward-secret-for-tests';

const rz = new Map<string, any>();
/** Subscriptions the code cancelled at Razorpay, in order. The only write it may make. */
const cancels: string[] = [];
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const path = u.pathname.replace(/^\/v1/, '');
  const c = path.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (c && init.method === 'POST' && JSON.parse(init.body).cancel_at_cycle_end === 0) {
    const s = rz.get(`/subscriptions/${c[1]}`);
    if (!s) return json({ error: { description: 'not found' } }, 400);
    cancels.push(c[1]); Object.assign(s, { status: 'cancelled', ended_at: Math.floor(Date.now() / 1000) });
    return json(s);
  }
  if ((init.method ?? 'GET') !== 'GET') throw new Error(`unexpected write to Razorpay: ${init.method} ${url}`);
  if (path === '/invoices') return json({ items: [...rz.values()].filter(o => o.entity === 'invoice' && o.subscription_id === u.searchParams.get('subscription_id')) });
  const m = path.match(/^\/payments\/([^/]+)\/refunds$/);
  if (m) return json({ items: [...rz.values()].filter(o => o.entity === 'refund' && o.payment_id === m[1]) });
  const o = rz.get(path);
  return o ? json(o) : json({ error: { description: 'not found' } }, 400);
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const { syncRazorpay } = await import('./lib/razorpay.js');

let app: Awaited<ReturnType<typeof build>>;
const mails: { to: string; subject: string; text: string; html: string }[] = [];
const DAY = 86400, now = () => Math.floor(Date.now() / 1000);
const SECRET = 'forward-secret-for-tests';
const sign = (raw: string, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');

async function user(email: string) {
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email } });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' } });
  expect(r.statusCode).toBe(200);
  return (await sql`select id from users where email = ${email}`)[0].id as string;
}
const plusUntil = async (id: string) => (await sql`select plus_until from users where id = ${id}`)[0].plusUntil as Date | null;
const post = (event: any, secret = SECRET) => {
  const raw = JSON.stringify(event);
  return app.inject({ method: 'POST', url: '/billing/razorpay/webhook', payload: raw, headers: { 'content-type': 'application/json', 'x-tablamigo-signature': sign(raw, secret) } });
};

/** A monthly Plus subscription with one paid invoice for the current period. */
function subscription(id: string, userId: string, extra: any = {}) {
  const notes = { service: 'tablamigo', user_id: userId, product: 'tablamigo_plus_monthly' };
  const s = { id, entity: 'subscription', status: 'active', notes, current_start: now() - 2 * DAY, current_end: now() + 28 * DAY, charge_at: now() + 28 * DAY, ended_at: null, ...extra };
  rz.set(`/subscriptions/${id}`, s);
  rz.set(`/invoices/inv_${id}`, { id: `inv_${id}`, entity: 'invoice', subscription_id: id, payment_id: `pay_${id}`, billing_start: now() - 2 * DAY, billing_end: now() + 28 * DAY });
  rz.set(`/payments/pay_${id}`, { id: `pay_${id}`, entity: 'payment', amount: 49900, currency: 'INR', amount_refunded: 0, status: 'captured', invoice_id: `inv_${id}`, notes });
  return s;
}
function refund(id: string, paymentId: string, amount: number, status = 'processed') {
  const r = { id, entity: 'refund', amount, currency: 'INR', payment_id: paymentId, notes: { comment: '' }, status, created_at: now() };
  rz.set(`/refunds/${id}`, r);
  const p = rz.get(`/payments/${paymentId}`); if (p && status === 'processed') p.amount_refunded = (p.amount_refunded ?? 0) + amount;
  return r;
}
const cancelledEvent = (s: any) => ({ entity: 'event', event: 'subscription.cancelled', payload: { subscription: { entity: s } } });
const refundEvent = (type: string, r: any) => ({ entity: 'event', event: type, payload: { refund: { entity: r } } });

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@rzpwh.tablamigo'`;
  setMailTransport(async m => { mails.push(m as any); return { id: `re_${mails.length}` }; });
});
afterAll(async () => { await sql`delete from users where email like '%@rzpwh.tablamigo'`; setMailTransport(null); await app.close(); await sql.end(); vi.unstubAllGlobals(); });
beforeEach(() => { mails.length = 0; });

describe('forwarded Razorpay webhook', () => {
  it('rejects a missing or wrong signature', async () => {
    const raw = JSON.stringify({ event: 'ping' });
    expect((await app.inject({ method: 'POST', url: '/billing/razorpay/webhook', payload: raw, headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    expect((await post({ event: 'ping' }, 'not-the-secret')).statusCode).toBe(401);
    expect((await post({ event: 'ping' })).json()).toEqual({ ok: true, result: 'ignored' });
  });

  it('subscription.cancelled mid-cycle: Plus stays until current_end, one email however often it arrives', async () => {
    const gia = await user('gia@rzpwh.tablamigo');
    const s = subscription('sub_gia', gia);
    Object.assign(s, { status: 'cancelled', ended_at: now() });
    const first = await post(cancelledEvent(s));
    expect(first.json()).toEqual({ ok: true, result: 'cancelled:sent' });
    expect((await post(cancelledEvent(s))).json().result).toBe('cancelled:duplicate');

    expect((await plusUntil(gia))!.getTime()).toBe(s.current_end * 1000);
    expect((await sql`select status from subscriptions where purchase_token = 'rzp:sub_gia'`)[0].status).toBe('SUBSCRIPTION_STATE_CANCELED');
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: 'gia@rzpwh.tablamigo', subject: 'Your Plus subscription is cancelled' });
    expect(mails[0].text).toContain('Plus until:');
    expect(mails[0].text).toContain('Future charges: None');
    expect(mails[0].text).toContain("you won't be charged again");
    expect(mails[0].text).toContain('Tablamigo by Hookstep · Ghatkopar, Mumbai, India');
    // "Hookstep" only in that footer line and the hookstep.in addresses; the legal name and Hookpost (whose webhook forwards
    // this event) never. Was `not.toMatch(/Hookstep/i)` over the whole email, which contradicted the line above (red on main).
    const prose = (mails[0].html + mails[0].text).split('Tablamigo by Hookstep').join('').replace(/[\w.@-]*hookstep\.in\b/gi, '');
    expect(prose).not.toMatch(/Hookstep|Hookpost|Mahajan|JR Consulting/i);
  });

  it('a partial refund on a cancelled subscription ends Plus now; refund.created + refund.processed = one email', async () => {
    const gia = (await sql`select id from users where email = 'gia@rzpwh.tablamigo'`)[0].id as string;
    const r = refund('rfnd_gia', 'pay_sub_gia', 49300);
    expect((await post(refundEvent('refund.created', r))).json().result).toBe('subscription:sent');
    expect((await post(refundEvent('refund.processed', r))).json().result).toBe('subscription:duplicate');

    expect(await plusUntil(gia)).toBeNull();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Your refund of ₹493 is on its way');
    expect(mails[0].text).toContain('Refund ID: rfnd_gia');
    expect(mails[0].text).toContain('usually reaches your bank in 5–7 working days');
    expect(mails[0].text).toContain('its Plus has ended');

    // the periodic sync sees Razorpay's paid-up current_end and must not bring Plus back
    await syncRazorpay(gia);
    await syncRazorpay();
    expect(await plusUntil(gia)).toBeNull();
  });

  it('cancel after refund (other order): Plus ends now and the email says it ended; a comp is kept and named', async () => {
    const hal = await user('hal@rzpwh.tablamigo');
    const comp = new Date('2100-01-01T00:59:59+01:00');
    await sql`update users set comp_until = ${comp} where id = ${hal}`;
    const s = subscription('sub_hal', hal, { status: 'cancelled', ended_at: now() });
    refund('rfnd_hal', 'pay_sub_hal', 49300);
    expect((await post(cancelledEvent(s))).json().result).toBe('cancelled:sent');
    expect((await plusUntil(hal))!.getTime()).toBe(comp.getTime());
    expect(mails[0].text).toContain('Ended:');
    expect(mails[0].text).toContain('You still have Plus until Thu 31 Dec 2099 from complimentary access');
    expect((await sql`select status, raw->>'tablamigo_refund_id' as rid from subscriptions where purchase_token = 'rzp:sub_hal'`)[0]).toEqual({ status: 'SUBSCRIPTION_STATE_EXPIRED', rid: 'rfnd_hal' });

    expect((await post(refundEvent('refund.processed', rz.get('/refunds/rfnd_hal')))).json().result).toBe('subscription:sent');
    expect(mails[1].subject).toBe('Your refund of ₹493 is on its way');
    expect(mails[1].text).toContain('complimentary access');
    expect((await plusUntil(hal))!.getTime()).toBe(comp.getTime());
  });

  it('SC-10 a partial refund on a live subscription ends it now: cancelled at Razorpay, Plus gone, one email that says so', async () => {
    const ivy = await user('ivy@rzpwh.tablamigo');
    subscription('sub_ivy', ivy);
    const r = refund('rfnd_ivy', 'pay_sub_ivy', 10000);
    expect((await post(refundEvent('refund.processed', r))).json().result).toBe('subscription:sent');
    expect(cancels).toContain('sub_ivy');
    expect(await plusUntil(ivy)).toBeNull();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Your refund of ₹100 is on its way');
    expect(mails[0].text).toContain('its Plus has ended');
    // Razorpay's subscription.cancelled for our own cancel adds no second email, and a later sync never brings Plus back.
    expect((await post(cancelledEvent(rz.get('/subscriptions/sub_ivy')))).json().result).toBe('cancelled:refund');
    await syncRazorpay();
    expect(await plusUntil(ivy)).toBeNull();
    expect(mails).toHaveLength(1);
  });

  it('a pending refund.created waits; a Trip Pass refund voids the pass', async () => {
    const jon = await user('jon@rzpwh.tablamigo');
    const notes = { service: 'tablamigo', user_id: jon, product: 'tablamigo_trip_pass' };
    rz.set('/payments/pay_pass_jon', { id: 'pay_pass_jon', entity: 'payment', amount: 29900, currency: 'INR', order_id: 'order_jon', status: 'captured', notes });
    await sql`insert into passes (purchase_token, user_id, product_id, order_id, expires_at, raw) values ('rzp:pay_pass_jon', ${jon}, 'tablamigo_trip_pass', 'order_jon', now() + interval '14 days', '{}')`;
    await sql`update users set plus_until = now() + interval '14 days' where id = ${jon}`;

    const pending = refund('rfnd_jon', 'pay_pass_jon', 29900, 'pending');
    expect((await post(refundEvent('refund.created', pending))).json().result).toBe('pending');
    expect(mails).toHaveLength(0);

    rz.get('/refunds/rfnd_jon').status = 'processed';
    expect((await post(refundEvent('refund.processed', pending))).json().result).toBe('pass:sent');
    expect((await sql`select voided_at from passes where purchase_token = 'rzp:pay_pass_jon'`)[0].voidedAt).not.toBeNull();
    expect(await plusUntil(jon)).toBeNull();
    expect(mails[0].subject).toBe('Your refund of ₹299 is on its way');
    expect(mails[0].text).toContain('Trip Pass is cancelled');
  });

  it("ignores another product's objects", async () => {
    const jon = (await sql`select id from users where email = 'jon@rzpwh.tablamigo'`)[0].id as string;
    rz.set('/subscriptions/sub_hp', { id: 'sub_hp', status: 'cancelled', notes: { service: 'hookpost', orgId: 'o1', user_id: jon } });
    expect((await post(cancelledEvent({ id: 'sub_hp' }))).json().result).toBe('not_ours');
    rz.set('/payments/pay_hp', { id: 'pay_hp', amount: 59900, notes: { service: 'hookpost' } });
    expect((await post(refundEvent('refund.processed', refund('rfnd_hp', 'pay_hp', 59900)))).json().result).toBe('not_ours');
    expect(mails).toHaveLength(0);
  });
});

/** A renewal charge on subscription `subId`: Razorpay gives it no notes of its own (notes: [], as on the live account). */
function renewal(subId: string, payId: string, extra: any = {}) {
  rz.set(`/invoices/inv_${payId}`, { id: `inv_${payId}`, entity: 'invoice', subscription_id: subId, payment_id: payId, billing_start: now() - DAY, billing_end: now() + 29 * DAY });
  rz.set(`/payments/${payId}`, { id: payId, entity: 'payment', amount: 49900, currency: 'INR', amount_refunded: 0, status: 'captured', invoice_id: `inv_${payId}`, notes: [], ...extra });
}

describe('refunds of renewal charges (no notes on the payment)', () => {
  it('a refunded renewal on a live subscription is ours through its subscription: email sent, Plus ends (rule 4)', async () => {
    const kim = await user('kim@rzpwh.tablamigo');
    subscription('sub_kim', kim);
    renewal('sub_kim', 'pay_renew_kim');
    const r = refund('rfnd_renew_kim', 'pay_renew_kim', 49900);
    expect((await post(refundEvent('refund.processed', r))).json().result).toBe('subscription:sent');
    expect(await plusUntil(kim)).toBeNull();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe('Your refund of ₹499 is on its way');
    expect(mails[0].text).toContain('its Plus has ended');
    // Razorpay retries: still one email.
    expect((await post(refundEvent('refund.processed', r))).json().result).toBe('subscription:duplicate');
    expect(mails).toHaveLength(1);
  });

  it('a refunded renewal on a cancelled subscription ends Plus now', async () => {
    // A sixth sign-in in this file hits the per-IP code limit, so Jon (whose Trip Pass was refunded above) takes a subscription.
    const jon = (await sql`select id from users where email = 'jon@rzpwh.tablamigo'`)[0].id as string;
    subscription('sub_jon', jon);
    renewal('sub_jon', 'pay_renew_jon');
    expect((await post(cancelledEvent(Object.assign(rz.get('/subscriptions/sub_jon'), { status: 'cancelled', ended_at: now() })))).json().result).toBe('cancelled:sent');
    mails.length = 0;
    const r = refund('rfnd_renew_jon', 'pay_renew_jon', 49900);
    expect((await post(refundEvent('refund.processed', r))).json().result).toBe('subscription:sent');
    expect(await plusUntil(jon)).toBeNull();
    expect(mails[0].text).toContain('its Plus has ended');
  });

  it("an untagged payment is not ours unless its subscription is: another product's, none, a forged user id, a dead invoice", async () => {
    const kim = (await sql`select id from users where email = 'kim@rzpwh.tablamigo'`)[0].id as string;
    const before = await plusUntil(kim);
    // Another product's subscription on the shared account, even naming one of our users.
    rz.set('/subscriptions/sub_vet', { id: 'sub_vet', entity: 'subscription', status: 'cancelled', notes: { service: 'vetnow', user_id: kim } });
    renewal('sub_vet', 'pay_vet');
    expect((await post(refundEvent('refund.processed', refund('rfnd_vet', 'pay_vet', 49900)))).json().result).toBe('not_ours');
    // No invoice at all (the Rs 5 mandate check looks like this).
    rz.set('/payments/pay_bare', { id: 'pay_bare', entity: 'payment', amount: 500, currency: 'INR', status: 'captured', notes: [] });
    expect((await post(refundEvent('refund.processed', refund('rfnd_bare', 'pay_bare', 500)))).json().result).toBe('not_ours');
    // Our subscription notes, but the user id is not a user of ours.
    rz.set('/subscriptions/sub_ghost', { id: 'sub_ghost', entity: 'subscription', status: 'active', notes: { service: 'tablamigo', user_id: '00000000-0000-0000-0000-000000000000' } });
    renewal('sub_ghost', 'pay_ghost');
    expect((await post(refundEvent('refund.processed', refund('rfnd_ghost', 'pay_ghost', 49900)))).json().result).toBe('not_ours');
    // The invoice cannot be read: unplaceable, so nothing changes.
    rz.set('/payments/pay_noinv', { id: 'pay_noinv', entity: 'payment', amount: 49900, currency: 'INR', status: 'captured', invoice_id: 'inv_missing', notes: [] });
    expect((await post(refundEvent('refund.processed', refund('rfnd_noinv', 'pay_noinv', 49900)))).json().result).toBe('not_ours');
    // A payment tagged as another product's stays not ours even if its invoice points at our subscription.
    renewal('sub_kim', 'pay_tagged_hp', { notes: { service: 'hookpost' } });
    expect((await post(refundEvent('refund.processed', refund('rfnd_tagged_hp', 'pay_tagged_hp', 49900)))).json().result).toBe('not_ours');

    expect(mails).toHaveLength(0);
    expect(await plusUntil(kim)).toEqual(before);
  });

  it("a tagged payment whose invoice belongs to someone else's subscription does not touch that subscription", async () => {
    const kim = (await sql`select id from users where email = 'kim@rzpwh.tablamigo'`)[0].id as string;
    const jon = (await sql`select id from users where email = 'jon@rzpwh.tablamigo'`)[0].id as string;
    const kimBefore = await plusUntil(kim);
    // Jon's tagged payment, but the invoice points at Kim's subscription.
    renewal('sub_kim', 'pay_cross', { notes: { service: 'tablamigo', user_id: jon, product: 'tablamigo_plus_monthly' } });
    expect((await post(refundEvent('refund.processed', refund('rfnd_cross', 'pay_cross', 49900)))).json().result).toBe('no_subscription');
    expect(await plusUntil(kim)).toEqual(kimBefore);
    expect(mails).toHaveLength(0);
  });
});
