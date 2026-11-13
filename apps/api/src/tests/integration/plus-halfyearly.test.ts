// The 6-month Plus plan (halfyearly, 2 Nov 2026) on the web: listed and sold only once RAZORPAY_PLAN_HALFYEARLY is set, a Razorpay
// subscription on that plan with 20 cycles, Plus to Razorpay's current_end, the owner alert and receipt say "6-month", and the
// admin's estimated MRR counts a sixth of its price. Google Play's halfyearly base plan needs nothing new here: verify trusts
// Google's expiry for any base plan of tablamigo_plus. Fake Razorpay: fetch is stubbed, nothing leaves the machine.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
process.env.REVIEW_EMAILS = 'hana@half.tablamigo,ivo@half.tablamigo';
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'ivo@half.tablamigo';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret';
process.env.RAZORPAY_PLAN_MONTHLY = 'plan_monthly_fake';
process.env.RAZORPAY_PLAN_YEARLY = 'plan_yearly_fake';
process.env.RAZORPAY_PLAN_HALFYEARLY = 'plan_half_fake';

const subs = new Map<string, any>(); let n = 0;
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : {};
  const [, , kind, id] = u.pathname.split('/');
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (kind === 'subscriptions' && method === 'POST' && !id) {
    const o = { id: `sub_h${++n}`, entity: 'subscription', status: 'created', plan_id: body.plan_id, total_count: body.total_count, notes: body.notes, current_end: null };
    subs.set(o.id, o); return json(o);
  }
  if (kind === 'subscriptions' && subs.has(id)) return json(subs.get(id));
  if (kind === 'invoices') return json({ items: [] });
  return json({ error: { description: 'not found' } }, 400);
}));

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { sellablePeriods } = await import('../../lib/razorpay.js');
const { razorpayProduct, playProduct } = await import('../../lib/owner-alerts.js');
const T = await import('../../lib/emails/templates.js');

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

beforeAll(async () => { app = await build(); await sql`delete from users where email like '%@half.tablamigo'`; });
afterAll(async () => { await sql`delete from users where email like '%@half.tablamigo'`; await app.close(); await sql.end(); vi.unstubAllGlobals(); });

describe('6-month Plus on the web', () => {
  it('lists ₹2,499 between monthly and yearly, and the Play product list has halfyearly (P6M)', async () => {
    const hana = await login('hana@half.tablamigo');
    const r = (await hana('GET', '/billing/plans')).json();
    expect(r.razorpay.prices).toEqual({ monthly: 49900, halfyearly: 249900, yearly: 399900, pass: 29900 });
    expect(Object.keys(r.razorpay.prices)).toEqual(['monthly', 'halfyearly', 'yearly', 'pass']);
    expect(r.products.map((p: any) => p.basePlan)).toEqual(['weekly', 'monthly', 'halfyearly', 'yearly']);
    expect(r.products.find((p: any) => p.basePlan === 'halfyearly')).toEqual({ id: 'tablamigo_plus', basePlan: 'halfyearly', label: '6 months', period: 'P6M' });
  });

  it('subscribes on the 6-month plan (20 cycles), verifies, and Plus runs to current_end', async () => {
    const hana = await login('hana@half.tablamigo');
    const s = (await hana('POST', '/billing/razorpay/subscribe', { period: 'halfyearly' })).json();
    expect(s.description).toBe('Plus · 6 months');
    const fake = subs.get(s.subscriptionId);
    expect(fake).toMatchObject({ plan_id: 'plan_half_fake', total_count: 20, notes: { service: 'tablamigo', product: 'tablamigo_plus_halfyearly' } });
    const end = Math.floor((Date.now() + 182 * DAY) / 1000);
    Object.assign(fake, { status: 'active', current_end: end, paid_count: 1 });
    const ok = (await hana('POST', '/billing/razorpay/subscription-verify', { subscriptionId: s.subscriptionId, paymentId: 'pay_h1', signature: sign(`pay_h1|${s.subscriptionId}`) })).json();
    expect(ok.active).toBe(true);
    const [u] = await sql`select plus_until from users where email = 'hana@half.tablamigo'`;
    expect(new Date(u.plusUntil).getTime()).toBe(end * 1000);
  });

  it('the admin revenue counts it at its own price, a sixth of it per month in MRR', async () => {
    const admin = await login('ivo@half.tablamigo');
    const saved = config.adminEmails; config.adminEmails = ['ivo@half.tablamigo'];
    try {
      const r = await admin('GET', '/admin/revenue');
      expect(r.statusCode).toBe(200);
      const rv = r.json();
      expect(rv.prices.halfyearly).toBe(249900);
      expect(rv.estimated.razorpaySubs.halfyearly).toMatchObject({ renewing: 1, paidCycles: 1, estCollected: 249900 });
      expect(rv.estimated.mrr).toBeGreaterThanOrEqual(Math.round(249900 / 6));
    } finally { config.adminEmails = saved; }
  });

  it('refuses an unknown period, and halfyearly when its Razorpay plan is not configured', async () => {
    const ivo = await login('ivo@half.tablamigo');
    expect((await ivo('POST', '/billing/razorpay/subscribe', { period: 'quarterly' })).statusCode).toBe(400);
    const saved = config.razorpay.planHalfyearly; config.razorpay.planHalfyearly = '';
    try {
      expect(sellablePeriods()).toEqual(['monthly', 'yearly']);
      const r = await ivo('POST', '/billing/razorpay/subscribe', { period: 'halfyearly' });
      expect(r.statusCode).toBe(400); expect(r.json().error).toBe('plan_not_available');
      expect((await ivo('GET', '/billing/plans')).json().razorpay.prices).toEqual({ monthly: 49900, yearly: 399900, pass: 29900 });
    } finally { config.razorpay.planHalfyearly = saved; }
  });

  it('owner alerts and emails call it "6-month", for Razorpay and Google Play', () => {
    expect(razorpayProduct('tablamigo_plus_halfyearly')).toBe('Plus 6-month');
    expect(playProduct('tablamigo_plus', 'halfyearly')).toBe('Plus 6-month');
    expect(playProduct('tablamigo_plus', 'monthly')).toBe('Plus monthly');
    const e = T.plusStarted({ name: 'Hana', kind: 'subscription', platform: 'google', period: 'halfyearly', amount: '₹2,499', startedAt: new Date(), until: null });
    const body = JSON.stringify(e.blocks);
    expect(body).toContain('Plus · 6-month');
    expect(body).not.toContain('halfyearly');
  });
});
