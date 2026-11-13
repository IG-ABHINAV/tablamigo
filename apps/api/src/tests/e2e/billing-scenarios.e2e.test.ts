// Billing scenarios on the real server process (src/main.ts, as PM2 starts it, scheduler on) over real HTTP. Razorpay and
// Google are a fake HTTP server (through src/scripts/e2e-preload.ts, which also captures every email in a file); the database
// is the throwaway test database. Proven here, end to end:
//   SC-06  Cancel in the web app stops Razorpay at once (cancel_at_cycle_end 0) and keeps the paid period;
//   SC-13  a forwarded chargeback locks web checkout, ends Plus, emails the customer once and alerts the owner once per status;
//   SC-21  a chargeback nobody forwarded is caught by the hourly reconcile the server's own scheduler runs;
//   SC-10  a voided Play subscription ends its Plus once Google lists it.
// tests/integration/billing-scenarios.test.ts covers every scenario in-process; tests/unit/billing-policy.test.ts the rules.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const D = '@bsc-e2e.tablamigo';
const OWNER = 'owner@owner.example';
const FORWARD = 'e2e-forward-secret', KEY_SECRET = 'e2e-razorpay-secret', RTDN = 'e2e-rtdn-url-token';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tablamigo-bsc-e2e-'));
const MAIL = path.join(TMP, 'mail.jsonl'), LOG = path.join(TMP, 'server.log'), SA = path.join(TMP, 'sa.json');
fs.writeFileSync(MAIL, '');
fs.writeFileSync(SA, '{}');

let server: ChildProcess;
let fake: http.Server;
let BASE = '';
const R = crypto.randomBytes(3).toString('hex');
const rz = new Map<string, any>();
const rzWrites: { path: string; body: any }[] = [];
const gp = { subs: new Map<string, any>(), voided: new Map<string, any>(), cancels: [] as string[] };
const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

const freePort = () => new Promise<number>(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const mails = () => fs.readFileSync(MAIL, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { to: string; subject: string; text: string });
const waitFor = async <T>(f: () => T | Promise<T>, what: string, ms = 15_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 150)); }
};
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
let ipN = 0;
async function call(method: string, p: string, o: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': `10.161.0.${++ipN % 250 + 1}`, ...o.headers };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined || o.raw !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const hook = (event: unknown) => { const raw = JSON.stringify(event); return call('POST', '/billing/razorpay/webhook', { raw, headers: { 'x-tablamigo-signature': crypto.createHmac('sha256', FORWARD).update(raw).digest('hex') } }); };
const rtdn = (data: unknown) => call('POST', `/billing/google/rtdn?token=${RTDN}`, { body: { message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.tablamigo.app', ...(data as object) })).toString('base64'), messageId: String(Date.now()) }, subscription: 'projects/x/subscriptions/y' } });

type U = { id: string; token: string; email: string };
const users: Record<string, U> = {};
async function person(tag: string, name: string): Promise<U> {
  const email = `${tag}${D}`;
  await call('POST', '/auth/email/start', { body: { email } });
  const v = await call('POST', '/auth/email/verify', { body: { email, code: '424242' } });
  expect(v.status).toBe(200);
  const token = v.json.accessToken as string;
  expect((await call('PATCH', '/me', { token, body: { name, birthdate: '1994-02-03', gender: 'woman', homeCountry: 'IN', interests: ['food'] } })).status).toBe(200);
  return { id: (await call('GET', '/me', { token })).json.id, token, email };
}
/** A paid monthly subscription with its invoice and first charge, verified through the web app's own call. */
async function subscribed(u: U, tag: string) {
  const id = `sub_${tag}${R}`, payId = `pay_${tag}${R}`, inv = `inv_${tag}${R}`;
  const notes = { service: 'tablamigo', user_id: u.id, product: 'tablamigo_plus_monthly' };
  const s = { id, entity: 'subscription', plan_id: 'plan_monthly', status: 'active', total_count: 120, remaining_count: 119, paid_count: 1, notes,
    current_start: now() - DAY, current_end: now() + 29 * DAY, charge_at: now() + 29 * DAY, ended_at: null, created_at: now() - 60 };
  rz.set(`/subscriptions/${id}`, s);
  rz.set(`/invoices/${inv}`, { id: inv, entity: 'invoice', status: 'paid', subscription_id: id, payment_id: payId, billing_start: now() - DAY, billing_end: now() + 29 * DAY, paid_at: now() - DAY });
  rz.set(`/payments/${payId}`, { id: payId, entity: 'payment', amount: 49900, currency: 'INR', status: 'captured', amount_refunded: 0, invoice_id: inv, notes, created_at: now() - DAY });
  const sig = crypto.createHmac('sha256', KEY_SECRET).update(`${payId}|${id}`).digest('hex');
  expect((await call('POST', '/billing/razorpay/subscription-verify', { token: u.token, body: { subscriptionId: id, paymentId: payId, signature: sig } })).status).toBe(200);
  return { s, payId };
}
const dispute = (payId: string, status = 'open') => {
  const d = { id: `disp_${payId.slice(4)}`, entity: 'dispute', payment_id: payId, amount: 49900, currency: 'INR', reason_code: 'fraud', status, respond_by: now() + 3 * DAY, created_at: now() };
  rz.set(`/disputes/${d.id}`, d);
  return d;
};

beforeAll(async () => {
  fake = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const u = new URL(req.url!, 'http://f');
    const send = (o: unknown, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname.startsWith('/razorpay/v1/')) {
      const p = u.pathname.slice('/razorpay/v1'.length);
      if (req.method === 'POST') {
        const body = raw ? JSON.parse(raw) : {};
        rzWrites.push({ path: p, body });
        const m = p.match(/^\/subscriptions\/([^/]+)\/cancel$/);
        const s = m && rz.get(`/subscriptions/${m[1]}`);
        if (s && !['cancelled', 'completed', 'expired'].includes(s.status)) return send(Object.assign(s, { status: 'cancelled', ended_at: now() }));
        return send({ error: { description: 'not allowed' } }, 400);
      }
      if (p === '/invoices') return send({ items: [...rz.values()].filter(o => o.entity === 'invoice' && o.subscription_id === u.searchParams.get('subscription_id')) });
      if (p === '/refunds') return send({ items: [...rz.values()].filter(o => o.entity === 'refund') });
      if (p === '/disputes') return send({ items: [...rz.values()].filter(o => o.entity === 'dispute') });
      if (/^\/payments\/[^/]+\/refunds$/.test(p)) return send({ items: [] });
      const o = rz.get(p);
      return o ? send(o) : send({ error: { description: 'not found' } }, 400);
    }
    if (u.pathname === '/google') {
      const g = JSON.parse(raw);
      const p = String(g.url).replace(/^.*\/applications\/[^/]+\//, '');
      if (/:acknowledge$/.test(p)) return send({});
      let m = p.match(/^purchases\/subscriptions\/[^/]+\/tokens\/([^/]+):cancel$/);
      if (m) { gp.cancels.push(decodeURIComponent(m[1])); return send({}); }
      if (/^purchases\/voidedpurchases\?/.test(p)) return send({ voidedPurchases: [...gp.voided.values()] });
      m = p.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
      if (m) { const s = gp.subs.get(decodeURIComponent(m[1])); return s ? send(s) : send({ error: { message: 'not found' } }, 404); }
      return send({ error: 'not faked' }, 404);
    }
    if (u.pathname === '/openai/v1/moderations') return send({ results: [{ flagged: false, categories: {} }] });
    if (u.pathname.startsWith('/nominatim/')) return send({ address: { city: 'Mumbai', country_code: 'in' } });
    if (u.pathname.startsWith('/photon/')) return send({ type: 'FeatureCollection', features: [] });
    send({ error: 'not faked' }, 404);
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const pg = await import('postgres');
  const db = pg.default(process.env.DATABASE_URL!, { max: 1 });
  await db`delete from users where email like ${'%' + D}`;
  await db.end();
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', PORT: String(PORT), PUBLIC_URL: BASE,
    DATABASE_URL: process.env.DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv',
    JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', ALL_FREE: 'false',
    // Off while the people sign up; the last test restarts the server with it on, as in production, so its first tick runs the
    // hourly billing reconcile.
    SCHEDULER: 'off', SCHEDULER_INTERVAL_MS: '1000',
    HOST_WELCOME: 'off', STARTER_PLANS: 'off', TRIP_MATCH: 'off', PLUS_WELCOME: 'off', CITY_NUDGE: 'off', EMAIL_LADDER: 'off', ENGAGEMENT: 'off',
    REVIEW_EMAILS: ['ria', 'sam', 'tia', 'uma'].map(t => t + D).join(','), REVIEW_CODE: '424242', OPENAI_API_KEY: 'sk-e2e-fake',
    RAZORPAY_KEY_ID: 'rzp_test_e2e', RAZORPAY_KEY_SECRET: KEY_SECRET, TABLAMIGO_FORWARD_SECRET: FORWARD, RTDN_TOKEN: RTDN,
    PLAY_SERVICE_ACCOUNT_JSON: SA, OWNER_SALES_ALERT_EMAIL: OWNER,
    MAIL_CAPTURE_FILE: MAIL, E2E_FAKE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
  };
  const out = fs.openSync(LOG, 'a');
  const start = (e: Record<string, string | undefined>) => spawn(process.execPath, ['--import', 'tsx', '--import', './src/scripts/e2e-preload.ts', 'src/main.ts'], { cwd: API_DIR, env: e as any, stdio: ['ignore', out, out] });
  server = start(env);
  await waitFor(async () => (await fetch(BASE + '/health').then(r => r.ok).catch(() => false)), 'server /health', 60_000);
  users.ria = await person('ria', 'Ria Web');
  users.sam = await person('sam', 'Sam Web');
  users.tia = await person('tia', 'Tia Swept');
  users.uma = await person('uma', 'Uma Play');
  // Restarted with the scheduler on once the people exist, so its first tick (the hourly reconcile) sees them.
  (globalThis as any).restart = async () => {
    server.kill('SIGTERM'); await new Promise(r => server.once('exit', r));
    server = start({ ...env, SCHEDULER: 'on' });
    await waitFor(async () => (await fetch(BASE + '/health').then(r => r.ok).catch(() => false)), 'server /health after restart', 60_000);
  };
});

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  fake?.close();
  const pg = await import('postgres');
  const db = pg.default(process.env.DATABASE_URL!, { max: 1 });
  await db`delete from owner_sale_alerts where event_key like ${'%' + R + '%'}`;
  await db`delete from users where email like ${'%' + D}`;
  await db.end();
  if (process.env.E2E_ARTIFACTS) { fs.mkdirSync(process.env.E2E_ARTIFACTS, { recursive: true }); fs.copyFileSync(LOG, path.join(process.env.E2E_ARTIFACTS, 'billing-scenarios.log')); }
});

describe('billing scenarios on the server process', () => {
  it('SC-06 Cancel in the web app stops Razorpay now and keeps the paid period', async () => {
    const { s } = await subscribed(users.ria, 'ria');
    expect((await call('POST', '/billing/razorpay/cancel', { token: users.ria.token })).status).toBe(200);
    expect(rzWrites.filter(w => w.path === `/subscriptions/${s.id}/cancel`)).toEqual([{ path: `/subscriptions/${s.id}/cancel`, body: { cancel_at_cycle_end: 0 } }]);
    const me = (await call('GET', '/billing/me', { token: users.ria.token })).json;
    expect(me.plus).toBe(true);
    expect(new Date(me.plusUntil).getTime()).toBe(s.current_end * 1000);
    await waitFor(() => mails().find(m => m.to === users.ria.email && m.subject === 'Your Plus subscription is cancelled'), "Ria's cancelled email");
  });

  it('SC-13 a forwarded chargeback: checkout refused, Plus ended, one customer email, one owner alert per status', async () => {
    const { s, payId } = await subscribed(users.sam, 'sam');
    const d = dispute(payId);
    const event = { entity: 'event', event: 'payment.dispute.created', payload: { dispute: { entity: d }, payment: { entity: { id: payId, notes: [] } } } };
    expect((await hook(event)).json).toEqual({ ok: true, result: 'disputed:1' });
    expect((await hook(event)).json).toEqual({ ok: true, result: 'dispute_open' });
    expect(rzWrites.some(w => w.path === `/subscriptions/${s.id}/cancel`)).toBe(true);
    expect((await call('GET', '/billing/me', { token: users.sam.token })).json.plus).toBe(false);
    const refused = await call('POST', '/billing/razorpay/subscribe', { token: users.sam.token, body: { period: 'monthly' } });
    expect(refused.status).toBe(409);
    expect(refused.json.error).toBe('billing_disputed');
    const alert = await waitFor(() => mails().find(m => m.to === OWNER && m.subject.startsWith('Chargeback:') && m.subject.includes(users.sam.email)), 'the chargeback alert');
    for (const t of [`Razorpay dispute id: ${d.id}`, `Razorpay payment id: ${payId}`, 'Respond by:', 'Clear billing dispute']) expect(alert.text).toContain(t);
    Object.assign(d, { status: 'lost' });
    expect((await hook({ ...event, event: 'payment.dispute.lost' })).json.result).toBe('dispute_lost');
    await waitFor(() => mails().filter(m => m.to === OWNER && m.subject.startsWith('Chargeback:') && m.subject.includes(users.sam.email)).length === 2, 'the lost alert');
    await pause(1500);
    expect(mails().filter(m => m.to === users.sam.email && !m.subject.startsWith('Welcome')).map(m => m.subject)).toEqual(['A payment to Tablamigo was disputed']);
    expect(mails().filter(m => m.to === OWNER && m.subject.startsWith('Chargeback:') && m.subject.includes(users.sam.email))).toHaveLength(2);
  });

  it('SC-10 a voided Play subscription ends its Plus once Google lists it', async () => {
    const token = `e2e${R}.AO-J1Oz${crypto.randomBytes(80).toString('base64url')}`, order = `GPA.1111-2222-3333-${parseInt(R, 16) % 100000}`;
    gp.subs.set(token, { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: order, regionCode: 'IN', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      lineItems: [{ productId: 'tablamigo_plus', expiryTime: new Date(Date.now() + 30 * DAY * 1000).toISOString(), latestSuccessfulOrderId: order, offerDetails: { basePlanId: 'monthly' } }] });
    expect((await call('POST', '/billing/google/verify', { token: users.uma.token, body: { productId: 'tablamigo_plus', purchaseToken: token } })).status).toBe(200);
    expect((await call('GET', '/billing/me', { token: users.uma.token })).json.plus).toBe(true);
    gp.voided.set(token, { purchaseToken: token, orderId: order, voidedReason: 1, voidedSource: 0 });
    expect((await rtdn({ voidedPurchaseNotification: { purchaseToken: token, orderId: order, productType: 1, refundType: 1 } })).json).toEqual({ ok: true });
    expect((await call('GET', '/billing/me', { token: users.uma.token })).json.plus).toBe(false);
    expect(gp.cancels).toEqual([token]);
  });

  it("SC-21 a chargeback nobody forwarded is caught by the server's own hourly reconcile", async () => {
    const { s, payId } = await subscribed(users.tia, 'tia');
    dispute(payId);
    await (globalThis as any).restart();
    await waitFor(async () => (await call('GET', '/billing/me', { token: users.tia.token })).json.plus === false, "Tia's Plus ended by the reconcile");
    expect(rzWrites.some(w => w.path === `/subscriptions/${s.id}/cancel`)).toBe(true);
    await waitFor(() => mails().find(m => m.to === users.tia.email && m.subject === 'A payment to Tablamigo was disputed'), "Tia's dispute email");
    expect((await call('POST', '/billing/razorpay/pass-order', { token: users.tia.token })).json.error).toBe('billing_disputed');
  });
});
