// The Google Play acknowledgement safety net on the real server process (src/main.ts with its own scheduler), over real HTTP.
// Google is a fake HTTP server (through src/scripts/e2e-preload.ts, which also captures every email in a file) whose
// acknowledge endpoint is down at first; the database is the throwaway test database. PLAY_ACK_GRACE_HOURS and
// PLAY_ACK_ALERT_HOURS are seconds here, so a day of Google failures happens in a few seconds.
// Proven: the purchase still gives Plus while the acknowledge fails; the server's own scheduler retries it; the owner gets one
// "not acknowledged" email and, once Google accepts it, one "now acknowledged" email; nothing to the customer; no token in
// any email. tests/integration/play-ack.test.ts covers each rule in-process.
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
const D = '@pack-e2e.tablamigo';
const OWNER = 'owner-pack@owner.example';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tablamigo-pack-e2e-'));
const MAIL = path.join(TMP, 'mail.jsonl'), LOG = path.join(TMP, 'server.log'), SA = path.join(TMP, 'sa.json');
fs.writeFileSync(MAIL, '');
fs.writeFileSync(SA, '{}');

const R = crypto.randomBytes(4).toString('hex');
const TOKEN = `pack-e2e-${R}-${'y'.repeat(30)}`;
let server: ChildProcess;
let fake: http.Server;
let BASE = '';
let ackDown = true;
const google = { subs: new Map<string, any>(), acks: 0, failedAcks: 0 };

const freePort = () => new Promise<number>(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const mails = () => fs.readFileSync(MAIL, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { to: string; subject: string; text: string; html: string });
const owner = () => mails().filter(m => m.to === OWNER && /Google Play purchase/.test(m.subject));
const waitFor = async <T>(f: () => T | Promise<T>, what: string, ms = 20_000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 200)); }
};
async function call(method: string, p: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': `10.161.0.${Math.floor(Math.random() * 250) + 1}` };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json };
}
let db: any;
const ackRow = async () => (await db`select ack_state, ack_attempts, ack_alerted_at from subscriptions where purchase_token = ${TOKEN}`)[0];
let user: { id: string; token: string };

beforeAll(async () => {
  fake = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const u = new URL(req.url!, 'http://f');
    const send = (o: unknown, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/google') {
      const p = String(JSON.parse(raw).url).replace(/^.*\/applications\/[^/]+\//, '');
      let m = p.match(/^purchases\/subscriptions\/[^/]+\/tokens\/(.+):acknowledge$/);
      if (m) {
        if (ackDown) { google.failedAcks++; return send({ error: { code: 503, message: 'The service is currently unavailable.' } }, 503); }
        google.acks++;
        const s = google.subs.get(decodeURIComponent(m[1])); if (s) s.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
        return send({});
      }
      m = p.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
      if (m) { const s = google.subs.get(decodeURIComponent(m[1])); return s ? send(s) : send({ error: { message: 'not found' } }, 404); }
      return send({ error: { message: 'not found' } }, 404);
    }
    if (u.pathname.startsWith('/nominatim/')) return send({ address: { city: 'Mumbai', country_code: 'in' } });
    if (u.pathname.startsWith('/photon/')) return send({ type: 'FeatureCollection', features: [] });
    if (u.pathname === '/openai/v1/moderations') return send({ results: [{ flagged: false, categories: {} }] });
    send({ error: 'not faked' }, 404);
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  const PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', PORT: String(PORT), PUBLIC_URL: BASE,
    DATABASE_URL: process.env.DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv',
    JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', ALL_FREE: 'false',
    // The server's own scheduler, every second; everything else it runs stays off.
    SCHEDULER: 'on', SCHEDULER_INTERVAL_MS: '1000', HOST_WELCOME: 'off', STARTER_PLANS: 'off', TRIP_MATCH: 'off', PLUS_WELCOME: 'off',
    CITY_NUDGE: 'off', EMAIL_LADDER: 'off', ENGAGEMENT: 'off',
    PLAY_ACK_GRACE_HOURS: '0.0005', PLAY_ACK_ALERT_HOURS: '0.002',          // 1.8 s and 7.2 s
    REVIEW_EMAILS: `buyer${D}`, REVIEW_CODE: '424242', OPENAI_API_KEY: 'sk-e2e-fake',
    PLAY_SERVICE_ACCOUNT_JSON: SA, OWNER_SALES_ALERT_EMAIL: OWNER,
    MAIL_CAPTURE_FILE: MAIL, E2E_FAKE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
  };
  const pg = await import('postgres');
  db = pg.default(process.env.DATABASE_URL!, { max: 1, transform: pg.default.camel });
  await db`delete from users where email like ${'%' + D}`;
  // Other files' leftovers must not be acknowledged against this fake: only this file's purchase is pending.
  await db`update subscriptions set ack_state = null where ack_state = 'pending'`;
  await db`update passes set ack_state = null where ack_state = 'pending'`;
  const out = fs.openSync(LOG, 'a');
  server = spawn(process.execPath, ['--import', 'tsx', '--import', './src/scripts/e2e-preload.ts', 'src/main.ts'], { cwd: API_DIR, env: env as any, stdio: ['ignore', out, out] });
  await waitFor(async () => (await fetch(BASE + '/health').then(r => r.ok).catch(() => false)), 'server /health', 60_000);

  const email = `buyer${D}`;
  await call('POST', '/auth/email/start', { body: { email } });
  const v = await call('POST', '/auth/email/verify', { body: { email, code: '424242' } });
  expect(v.status).toBe(200);
  const token = v.json.accessToken as string;
  expect((await call('PATCH', '/me', { token, body: { name: 'Bina Buyer', birthdate: '1994-02-03', gender: 'woman', homeCountry: 'IN', interests: ['food'] } })).status).toBe(200);
  user = { id: (await call('GET', '/me', { token })).json.id, token };
});

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  fake?.close();
  await db`delete from users where email like ${'%' + D}`;
  await db.end();
  if (process.env.E2E_ARTIFACTS) { fs.mkdirSync(process.env.E2E_ARTIFACTS, { recursive: true }); fs.copyFileSync(LOG, path.join(process.env.E2E_ARTIFACTS, 'play-ack.log')); }
});

describe('Play acknowledgement safety net on the server process', () => {
  it('Google refuses the acknowledge for a while: Plus still applies, the owner is told once, then told it is fixed', async () => {
    google.subs.set(TOKEN, {
      subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', startTime: new Date().toISOString(),
      lineItems: [{ productId: 'tablamigo_plus', expiryTime: new Date(Date.now() + 30 * 86400_000).toISOString(), offerDetails: { basePlanId: 'monthly' } }],
    });
    const v = await call('POST', '/billing/google/verify', { token: user.token, body: { productId: 'tablamigo_plus', purchaseToken: TOKEN } });
    expect(v.status, JSON.stringify(v.json)).toBe(200);
    expect(v.json.active).toBe(true);
    expect((await call('GET', '/billing/me', { token: user.token })).json.plus).toBe(true);
    // The 3 in-line tries (1 s and 3 s apart) take longer than this file's 1.8 s grace, so the scheduler may join in: harmless,
    // acknowledging twice is fine. In production the grace is an hour.
    expect((await ackRow()).ackState).toBe('pending');
    await waitFor(() => google.failedAcks >= 3, 'the in-line tries, after the answer');

    // The scheduler keeps trying; once the purchase is "a day" old the owner gets one email.
    const alert = await waitFor(() => owner()[0], 'owner alert');
    expect(alert.subject).toMatch(/^Google Play purchase not acknowledged after \d+ h, Google refunds it /);
    expect(alert.text).toContain('Customer: Bina Buyer (buyer@pack-e2e.tablamigo)');
    expect(alert.text).toContain('Last error: 503: The service is currently unavailable.');
    expect(google.failedAcks).toBeGreaterThan(4);                              // retried by the scheduler, not only in-line
    expect((await ackRow()).ackAlertedAt).toBeInstanceOf(Date);

    ackDown = false;
    await waitFor(async () => (await ackRow()).ackState === 'acknowledged', 'acknowledged by the safety net');
    await waitFor(() => owner().length === 2, 'the "now acknowledged" email');
    expect(owner().map(m => m.subject)[1]).toBe('Google Play purchase now acknowledged');
    expect(google.acks).toBe(1);
    expect(google.subs.get(TOKEN).acknowledgementState).toBe('ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED');

    // One "failing" email however many runs failed; nothing to the customer; never the token.
    await new Promise(r => setTimeout(r, 3000));
    expect(owner()).toHaveLength(2);
    expect(mails().filter(m => /Google Play purchase/.test(m.subject) && m.to !== OWNER)).toEqual([]);
    for (const m of mails()) expect(JSON.stringify(m)).not.toContain(TOKEN);
    expect(fs.readFileSync(LOG, 'utf8')).not.toContain(TOKEN);
  });
});
