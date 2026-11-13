// The owner's sale alerts on the real server process (src/main.ts, as PM2 starts it) over real HTTP: a forwarded Razorpay
// webhook and Google Play's RTDN push come in as production receives them, Razorpay and Google are a fake HTTP server (through
// src/scripts/e2e-preload.ts, which also captures every email in a file), and the database is the throwaway test database.
// Proven here: the startup line; one alert per event however often it is delivered (one after another or at once); none for a
// forged webhook or an unauthenticated push; the webhook still answers 200 and Plus still applies while the email provider is
// down, and the alert is sent when the event is delivered again. tests/integration/owner-sale-alerts.test.ts covers every
// event kind in-process.
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
const D = '@osa-e2e.tablamigo';
const OWNER = 'owner@owner.example';
const FORWARD = 'e2e-forward-secret', KEY_SECRET = 'e2e-razorpay-secret', RTDN = 'e2e-rtdn-url-token';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tablamigo-osa-e2e-'));
const MAIL = path.join(TMP, 'mail.jsonl'), LOG = path.join(TMP, 'server.log'), SA = path.join(TMP, 'sa.json');
fs.writeFileSync(MAIL, '');
fs.writeFileSync(SA, '{}');

let server: ChildProcess;
let fake: http.Server;
let BASE = '';
const R = crypto.randomBytes(3).toString('hex');
const rz = new Map<string, any>();
const gp = { subs: new Map<string, any>(), orders: new Map<string, any>() };
const now = () => Math.floor(Date.now() / 1000);

const freePort = () => new Promise<number>(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const mails = () => fs.readFileSync(MAIL, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { to: string; subject: string; text: string });
const owner = () => mails().filter(m => m.to === OWNER);
const waitFor = async <T>(f: () => T | Promise<T>, what: string, ms = 8000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); }
};
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
let ipN = 0;
async function call(method: string, p: string, o: { token?: string; body?: unknown; raw?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': `10.160.0.${++ipN % 250 + 1}`, ...o.headers };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined || o.raw !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: o.raw ?? (o.body !== undefined ? JSON.stringify(o.body) : undefined) });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
const hookRaw = (raw: string, secret = FORWARD) => call('POST', '/billing/razorpay/webhook', { raw, headers: { 'x-tablamigo-signature': crypto.createHmac('sha256', secret).update(raw).digest('hex') } });
const rtdn = (data: unknown, query = '') => call('POST', `/billing/google/rtdn${query}`, { body: { message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.tablamigo.app', ...(data as object) })).toString('base64'), messageId: String(Date.now()) }, subscription: 'projects/x/subscriptions/y' } });

let user: { id: string; token: string; email: string };
let sub: any;
function charge(n: number) {
  const pid = `pay_e2e${R}c${n}`, inv = `inv_e2e${R}c${n}`;
  rz.set(`/invoices/${inv}`, { id: inv, entity: 'invoice', status: 'paid', paid_at: now() + n, subscription_id: sub.id, payment_id: pid });
  rz.set(`/payments/${pid}`, { id: pid, entity: 'payment', amount: 49900, currency: 'INR', status: 'captured', invoice_id: inv, method: 'upi', vpa: 'someone@okicici', contact: '+919800000000', notes: sub.notes, created_at: now() });
  return pid;
}
const chargedEvent = (pid: string) => JSON.stringify({ entity: 'event', event: 'subscription.charged', contains: ['subscription', 'payment'], payload: { subscription: { entity: sub }, payment: { entity: rz.get(`/payments/${pid}`) } }, created_at: now() });

beforeAll(async () => {
  fake = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const u = new URL(req.url!, 'http://f');
    const send = (o: unknown, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname.startsWith('/razorpay/v1/')) {
      const o = req.method === 'GET' ? rz.get(u.pathname.slice('/razorpay/v1'.length)) : null;
      return o ? send(o) : send({ error: { description: 'not found' } }, 400);
    }
    if (u.pathname === '/google') {
      const p = String(JSON.parse(raw).url).replace(/^.*\/applications\/[^/]+\//, '');
      if (/:acknowledge$/.test(p)) return send({});
      let m = p.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
      if (m) { const s = gp.subs.get(decodeURIComponent(m[1])); return s ? send(s) : send({ error: { message: 'not found' } }, 404); }
      m = p.match(/^orders\/(.+)$/);
      if (m) { const o = gp.orders.get(decodeURIComponent(m[1])); return o ? send(o) : send({ error: { message: 'not found' } }, 404); }
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
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', PORT: String(PORT), PUBLIC_URL: BASE,
    DATABASE_URL: process.env.DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv',
    JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', SCHEDULER: 'off', ALL_FREE: 'false',
    HOST_WELCOME: 'off', STARTER_PLANS: 'off', REVIEW_EMAILS: `buyer${D}`, REVIEW_CODE: '424242', OPENAI_API_KEY: 'sk-e2e-fake',
    RAZORPAY_KEY_ID: 'rzp_test_e2e', RAZORPAY_KEY_SECRET: KEY_SECRET, TABLAMIGO_FORWARD_SECRET: FORWARD, RTDN_TOKEN: RTDN,
    PLAY_SERVICE_ACCOUNT_JSON: SA, OWNER_SALES_ALERT_EMAIL: OWNER,
    MAIL_CAPTURE_FILE: MAIL, E2E_FAKE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
  };
  const pg = await import('postgres');
  const db = pg.default(process.env.DATABASE_URL!, { max: 1 });
  await db`delete from users where email like ${'%' + D}`;
  await db`delete from owner_sale_alerts where event_key like ${'%' + R + '%'}`;
  await db.end();
  const out = fs.openSync(LOG, 'a');
  server = spawn(process.execPath, ['--import', 'tsx', '--import', './src/scripts/e2e-preload.ts', 'src/main.ts'], { cwd: API_DIR, env: env as any, stdio: ['ignore', out, out] });
  await waitFor(async () => (await fetch(BASE + '/health').then(r => r.ok).catch(() => false)), 'server /health', 60_000);

  const email = `buyer${D}`;
  await call('POST', '/auth/email/start', { body: { email } });
  const v = await call('POST', '/auth/email/verify', { body: { email, code: '424242' } });
  expect(v.status).toBe(200);
  const token = v.json.accessToken as string;
  expect((await call('PATCH', '/me', { token, body: { name: 'Bina Buyer', birthdate: '1994-02-03', gender: 'woman', homeCountry: 'IN', interests: ['food'] } })).status).toBe(200);
  user = { id: (await call('GET', '/me', { token })).json.id, token, email };
  sub = { id: `sub_e2e${R}`, entity: 'subscription', plan_id: 'plan_monthly', status: 'active', paid_count: 1, quantity: 1, created_at: now() - 60,
    notes: { service: 'tablamigo', user_id: user.id, product: 'tablamigo_plus_monthly' }, current_start: now(), current_end: now() + 30 * 86400, charge_at: now() + 30 * 86400 };
  rz.set(`/subscriptions/${sub.id}`, sub);
});

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  fake?.close();
  const pg = await import('postgres');
  const db = pg.default(process.env.DATABASE_URL!, { max: 1 });
  await db`delete from owner_sale_alerts where event_key like ${'%' + R + '%'}`;
  await db`delete from users where email like ${'%' + D}`;
  await db.end();
  if (process.env.E2E_ARTIFACTS) { fs.mkdirSync(process.env.E2E_ARTIFACTS, { recursive: true }); fs.copyFileSync(LOG, path.join(process.env.E2E_ARTIFACTS, 'owner-sale-alerts.log')); }
});

describe('owner sale alerts on the server process', () => {
  it('logs that alerts are on at startup', () => {
    expect(fs.readFileSync(LOG, 'utf8')).toContain('owner sale alerts: on, 1 recipient');
  });

  it('a forwarded subscription.charged for a new subscription, delivered 5 times (3 at once): one start and one charge alert, to the owner only', async () => {
    const pid = charge(1), raw = chargedEvent(pid);
    expect((await hookRaw(raw)).json).toEqual({ ok: true, result: 'synced' });
    expect((await Promise.all([hookRaw(raw), hookRaw(raw), hookRaw(raw)])).map(r => r.status)).toEqual([200, 200, 200]);
    expect((await hookRaw(raw)).status).toBe(200);
    const m = await waitFor(() => owner().find(x => x.subject.includes('First charge')), 'the charge alert');
    await pause(1500);
    expect(owner().map(x => x.subject).sort()).toEqual([
      `First charge: Plus monthly, ₹499 — Bina Buyer (${user.email})`,
      `New subscription: Plus monthly, ₹499 — Bina Buyer (${user.email})`,
    ]);
    expect(m.text).toContain(`Razorpay payment id: ${pid}`);
    expect(m.text).not.toMatch(/okicici|\+919800000000/);
    expect(mails().filter(x => x.subject.endsWith(` — Bina Buyer (${user.email})`)).every(x => x.to === OWNER)).toBe(true);
    expect((await call('GET', '/billing/me', { token: user.token })).json.plus).toBe(true);
  });

  it('a forged webhook (wrong secret) and an RTDN push without its token: 401, no alert', async () => {
    const pid = charge(2), raw = chargedEvent(pid);
    expect((await hookRaw(raw, 'not-the-forward-secret')).status).toBe(401);
    expect((await call('POST', '/billing/razorpay/webhook', { raw })).status).toBe(401);
    expect((await rtdn({ subscriptionNotification: { notificationType: 2, purchaseToken: 'x'.repeat(120) } })).status).toBe(401);
    await pause(1500);
    expect(owner()).toHaveLength(2);
  });

  it('Google Play: the app verifies a purchase, then RTDN pushes a renewal twice: one alert each', async () => {
    const token = `e2e${R}.AO-J1Oz${crypto.randomBytes(80).toString('base64url')}`, o1 = `GPA.9999-8888-7777-${String(parseInt(R, 16) % 100000).padStart(5, '0')}`;
    const playSub = (order: string, days: number) => gp.subs.set(token, { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', latestOrderId: order, regionCode: 'IN', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
      lineItems: [{ productId: 'tablamigo_plus', expiryTime: new Date(Date.now() + days * 86400_000).toISOString(), latestSuccessfulOrderId: order,
        autoRenewingPlan: { autoRenewEnabled: true, recurringPrice: { currencyCode: 'INR', units: '499' } }, offerDetails: { basePlanId: 'monthly' } }] });
    playSub(o1, 30);
    gp.orders.set(o1, { orderId: o1, total: { currencyCode: 'INR', units: '499' } });
    expect((await call('POST', '/billing/google/verify', { token: user.token, body: { productId: 'tablamigo_plus', purchaseToken: token } })).status).toBe(200);
    await waitFor(() => owner().find(m => m.subject.includes('New subscription')), 'the Play purchase alert');
    playSub(`${o1}..0`, 60);
    const renewed = { subscriptionNotification: { version: '1.0', notificationType: 2, purchaseToken: token, subscriptionId: 'tablamigo_plus' } };
    expect((await rtdn(renewed, `?token=${RTDN}`)).json).toEqual({ ok: true });
    expect((await rtdn(renewed, `?token=${RTDN}`)).json).toEqual({ ok: true });
    await waitFor(() => owner().find(m => m.subject.includes('Renewal:')), 'the Play renewal alert');
    await pause(1500);
    const play = owner().filter(m => m.text.includes('Google Play order id'));
    expect(play.map(m => m.subject).sort()).toEqual([
      `New subscription: Plus monthly, ₹499 — Bina Buyer (${user.email})`,
      `Renewal: Plus monthly, ₹499 — Bina Buyer (${user.email})`,
    ]);
    for (const m of play) expect(m.text + m.subject).not.toContain(token);
  });

  it('email provider down: the webhook still answers 200 and Plus still applies; the alert goes out when the event comes again', async () => {
    sub.paid_count = 2; sub.current_end = now() + 60 * 86400;
    const pid = charge(3), raw = chargedEvent(pid);
    const before = owner().length;
    fs.writeFileSync(MAIL + '.down', '');
    try {
      expect((await hookRaw(raw)).json).toEqual({ ok: true, result: 'synced' });
      await pause(1500);
      expect(owner()).toHaveLength(before);
      expect(new Date((await call('GET', '/billing/me', { token: user.token })).json.plusUntil).getTime()).toBe(sub.current_end * 1000);
    } finally { fs.rmSync(MAIL + '.down', { force: true }); }
    expect((await hookRaw(raw)).status).toBe(200);
    await waitFor(() => owner().length > before, 'the alert after the outage');
    await pause(1500);
    expect(owner()).toHaveLength(before + 1);
    expect(owner().at(-1)!.subject).toBe(`Renewal: Plus monthly, ₹499 — Bina Buyer (${user.email})`);
    expect(fs.readFileSync(LOG, 'utf8')).toContain('owner sale alert: send failed');
  });
});
