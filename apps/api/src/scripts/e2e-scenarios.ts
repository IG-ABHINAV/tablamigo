/**
 * Multi-account end-to-end run of the team test plan (TESTING.md) against a LOCAL API server, over HTTP.
 *
 *   cd apps/api && npx tsx src/scripts/e2e-scenarios.ts [--keep]
 *
 * - Starts a fake for every outside service (Razorpay, Google Play, FCM, Web Push, OpenAI moderation,
 *   Nominatim) on a random 127.0.0.1 port.
 * - Spawns the API (src/main.ts) on another 127.0.0.1 port with src/scripts/e2e-preload.ts, which sends
 *   those services to the fake, blocks every other outside request and writes emails to a capture file.
 * - a/b/c/d/f@e2e.test sign in with the REVIEW_EMAILS fixed code; e@e2e.test, x@e2e.test and the admin
 *   use real emailed codes read back from the capture file.
 * - Time-based emails (join batches, digest, receipts) are run from this process with the scheduler's
 *   own functions against the same database, as the server's 10-minute timer would.
 * - Uses the local development database (the one vitest uses) and refuses any other host. Where a case
 *   needs a phone (push delivery, camera, Play purchases) the server side is tested, marked in the table.
 *
 * Prints a PASS/FAIL table and exits 1 if anything failed. --keep leaves the e2e rows in the database.
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';

// ---- safety and environment (before any app module reads config) --------------------------------
// A throwaway local test database only (same rule as the vitest suites, src/test-db-guard.ts): DATABASE_URL must be set,
// local, and name a "test" database. It counts emails, so give it a database no other suite writes to (tablamigo_e2e_test).
const { testDatabaseProblem } = await import('../test-db-guard.js');
const dbProblem = testDatabaseProblem(process.env);
if (dbProblem) {
  console.error(`Refusing to run: ${dbProblem}. The end-to-end run only uses a throwaway local test database, never production (see TESTING.md).`);
  process.exit(2);
}
const DB = process.env.DATABASE_URL!;
const KEEP = process.argv.includes('--keep');
const freePort = () => new Promise<number>(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const API_PORT = await freePort();
const BASE = `http://127.0.0.1:${API_PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tablamigo-e2e-'));
const MAIL_FILE = path.join(TMP, 'mail.jsonl');
const SA_FILE = path.join(TMP, 'fake-service-account.json');
fs.writeFileSync(MAIL_FILE, '');
fs.writeFileSync(SA_FILE, JSON.stringify({ project_id: 'tablamigo-e2e', client_email: 'e2e@tablamigo-e2e.iam.gserviceaccount.com' }));

const D = '@e2e.test';
const REVIEW_CODE = '424242';
const RZP_SECRET = 'e2e-fake-secret';
const ADMIN = `admin${D}`;
const ENV = {
  NODE_ENV: 'development', DATABASE_URL: DB, PORT: String(API_PORT), PUBLIC_URL: BASE,
  JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', SCHEDULER: 'off',   // reminders and recurrence are run by hand here, never by a timer
  REVIEW_EMAILS: ['a', 'b', 'c', 'd', 'f'].map(k => k + D).join(','), REVIEW_CODE,
  ADMIN_EMAILS: ADMIN,
  RAZORPAY_KEY_ID: 'rzp_test_e2e', RAZORPAY_KEY_SECRET: RZP_SECRET, RAZORPAY_PLAN_MONTHLY: 'plan_e2e_monthly', RAZORPAY_PLAN_YEARLY: 'plan_e2e_yearly',
  PLAY_SERVICE_ACCOUNT_JSON: SA_FILE, FIREBASE_SERVICE_ACCOUNT_JSON: SA_FILE, FIREBASE_PROJECT_ID: 'tablamigo-e2e',
  WEBPUSH_PUBLIC_KEY: 'BE2EPublicKey', WEBPUSH_PRIVATE_KEY: 'e2e-private-key',
  OPENAI_API_KEY: 'sk-e2e-fake', RTDN_TOKEN: '', RTDN_PUSH_EMAIL: '',
  R2_ACCOUNT_ID: '', R2_ACCESS_KEY: '', R2_BUCKET: '',
  MAIL_CAPTURE_FILE: MAIL_FILE,
  ALL_FREE: 'false',   // the run covers the paid tiers (limits, purchases, renewals); all-free.test.ts covers ALL_FREE on
};
Object.assign(process.env, ENV);

const { sql } = await import('../lib/db.js');
const { setMailTransport } = await import('../lib/mail.js');
const { runEmailJobs, planJoins, weeklyDigest, isDigestTime } = await import('../lib/emails/jobs.js');
const { FOOTER_ORG } = await import('../lib/emails/layout.js');
const { ticketSubject } = await import('../lib/emails/support-templates.js');
const reportTickets: [string, string][] = []; // [reporter email, TM- ref] from section 6
// This process runs the scheduler, so its emails go to the same capture file as the server's.
setMailTransport(async m => { fs.appendFileSync(MAIL_FILE, JSON.stringify({ ...m, at: new Date().toISOString(), by: 'scheduler' }) + '\n'); return { id: 'captured' }; });

// ---- fakes for every outside service ------------------------------------------------------------
const fake = {
  rz: { orders: new Map<string, any>(), payments: new Map<string, any>(), subs: new Map<string, any>(), n: 0 },
  play: { subs: new Map<string, any>(), products: new Map<string, any>() },
  calls: [] as string[],
  pushes: [] as { kind: 'fcm' | 'web'; to: string; title: string; body: string }[],
};
const fakeServer = http.createServer(async (req, res) => {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8'); const body = raw ? JSON.parse(raw) : {};
  const u = new URL(req.url!, 'http://fake');
  const send = (o: unknown, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const method = req.method ?? 'GET';
  if (u.pathname.startsWith('/razorpay/v1/')) {
    const [kind, id, action] = u.pathname.slice('/razorpay/v1/'.length).split('/');
    fake.calls.push(`razorpay ${method} /${kind}${id ? '/' + id : ''}${action ? '/' + action : ''}`);
    const store = kind === 'orders' ? fake.rz.orders : kind === 'payments' ? fake.rz.payments : fake.rz.subs;
    if (method === 'POST' && !id) {
      const o = kind === 'orders' ? { id: `order_e2e${++fake.rz.n}`, entity: 'order', status: 'created', amount: body.amount, currency: body.currency, notes: body.notes }
        : { id: `sub_e2e${++fake.rz.n}`, entity: 'subscription', status: 'created', plan_id: body.plan_id, notes: body.notes, current_end: null };
      store.set(o.id, o); return send(o);
    }
    const o = store.get(id);
    if (!o) return send({ error: { description: 'not found' } }, 400);
    if (action === 'capture') o.status = 'captured';
    if (action === 'cancel') { if (o.failCancel) return send({ error: { description: 'e2e: cancel refused' } }, 500); o.cancelAtCycleEnd = body.cancel_at_cycle_end; }
    return send(o);
  }
  if (u.pathname === '/openai/v1/moderations') {
    const flagged = String(body.input ?? '').includes('E2E-ABUSE');
    return send({ results: [{ flagged, categories: { harassment: flagged } }] });
  }
  if (u.pathname === '/openai/v1/chat/completions') {
    // AI plan ideas: two places the geocoder double knows near Bangkok, one it doesn't.
    const ideas = [
      { emoji: '🍜', title: 'Street food crawl on Yaowarat', category: 'food', placeName: 'Yaowarat Road', why: 'Chinatown comes alive after dark' },
      { emoji: '🌅', title: 'Sunset at Wat Arun', category: 'culture', placeName: 'Wat Arun', why: 'Best view across the river' },
      { emoji: '🎤', title: 'Karaoke night', category: 'nightlife', placeName: 'E2E Unknown Karaoke', why: 'Loud and silly' },
    ];
    return send({ choices: [{ message: { content: JSON.stringify({ ideas }) } }] });
  }
  if (u.pathname === '/photon/api/') {
    const at: Record<string, [number, number]> = { 'Yaowarat Road': [100.5096, 13.7398], 'Wat Arun': [100.4889, 13.7437] };
    const c = at[u.searchParams.get('q') ?? ''];
    return send({ type: 'FeatureCollection', features: c ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: c }, properties: { name: u.searchParams.get('q') } }] : [] });
  }
  if (u.pathname === '/nominatim/reverse') {
    const lat = Number(u.searchParams.get('lat'));
    return send({ address: lat > 10 && lat < 20 ? { city: 'Bangkok', country_code: 'th' } : { city: 'Lisbon', country_code: 'pt' } });
  }
  if (u.pathname === '/google') {
    const g = new URL(body.url); const p = decodeURIComponent(g.pathname);
    fake.calls.push(`google ${body.method} ${g.hostname}${p.replace(/^\/androidpublisher\/v3\/applications\/[^/]+/, '')}`);
    if (g.hostname === 'fcm.googleapis.com') {
      const m = body.data?.message ?? {};
      fake.pushes.push({ kind: 'fcm', to: m.token, title: m.notification?.title, body: m.notification?.body });
      return send({ name: 'projects/tablamigo-e2e/messages/1' });
    }
    let m = p.match(/\/purchases\/subscriptionsv2\/tokens\/(.+)$/);
    if (m) { const s = fake.play.subs.get(m[1]); return s ? send(s) : send({ error: { code: 404 } }, 404); }
    m = p.match(/\/purchases\/subscriptions\/[^/]+\/tokens\/(.+):acknowledge$/);
    if (m) { const s = fake.play.subs.get(m[1]); if (s) s.acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED'; return send({}); }
    m = p.match(/\/purchases\/products\/[^/]+\/tokens\/(.+):consume$/);
    if (m) { const s = fake.play.products.get(m[1]); if (s) s.consumptionState = 1; return send({}); }
    m = p.match(/\/purchases\/products\/[^/]+\/tokens\/(.+)$/);
    if (m) { const s = fake.play.products.get(m[1]); return s ? send(s) : send({ error: { code: 404 } }, 404); }
    return send({ error: 'unknown google call' }, 400);
  }
  if (u.pathname === '/webpush') {
    const pl = JSON.parse(body.payload ?? '{}');
    fake.pushes.push({ kind: 'web', to: body.endpoint, title: pl.title, body: pl.body });
    return send({});
  }
  send({ error: 'unknown fake route' }, 404);
});
await new Promise<void>(r => fakeServer.listen(0, '127.0.0.1', () => r()));
const FAKE_URL = `http://127.0.0.1:${(fakeServer.address() as AddressInfo).port}`;

// ---- the local API server -----------------------------------------------------------------------
const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const serverLog = path.join(TMP, 'server.log');
const logFd = fs.openSync(serverLog, 'a');
const server: ChildProcess = spawn(process.execPath, ['--import', 'tsx', '--import', './src/scripts/e2e-preload.ts', 'src/main.ts'], {
  cwd: API_DIR, env: { ...process.env, ...ENV, E2E_FAKE_URL: FAKE_URL }, stdio: ['ignore', logFd, logFd],
});
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
for (let i = 0; ; i++) {
  const ok = await fetch(`${BASE}/health`).then(r => r.ok).catch(() => false);
  if (ok) break;
  if (i > 100 || server.exitCode !== null) { console.error('API did not start:\n' + fs.readFileSync(serverLog, 'utf8').slice(-3000)); process.exit(2); }
  await sleep(200);
}

// ---- helpers -------------------------------------------------------------------------------------
type Res = { status: number; json: any; text: string; headers: Headers };
async function call(method: string, p: string, o: { token?: string; body?: unknown; ip?: string; raw?: Buffer; type?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? '10.250.0.1' };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: any;
  if (o.raw) { body = o.raw; headers['content-type'] = o.type ?? 'application/octet-stream'; }
  else if (o.body !== undefined) { body = JSON.stringify(o.body); headers['content-type'] = 'application/json'; }
  const r = await fetch(BASE + p, { method, headers, body });
  const text = await r.text(); let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, json, text, headers: r.headers };
}
type Mail = { to: string; subject: string; html: string; text: string; headers?: Record<string, string>; by: string };
const mails = (): Mail[] => fs.readFileSync(MAIL_FILE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const mailsTo = (to: string, from = 0) => mails().slice(from).filter(m => m.to === to);
async function waitFor<T>(f: () => T | Promise<T>, what: string, ms = 4000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(50); }
}
const codeIn = (m?: Mail) => m?.subject.match(/^(\d{6}) is your Tablamigo code$/)?.[1];

let ipN = 0;
type User = { key: string; email: string; ip: string; token: string; refresh: string; id: string; req: (method: string, p: string, body?: unknown) => Promise<Res> };
function makeUser(key: string, email: string, ip: string, tokens: { accessToken: string; refreshToken: string }, id: string): User {
  const u: User = { key, email, ip, token: tokens.accessToken, refresh: tokens.refreshToken, id, req: (m, p, b) => call(m, p, { token: u.token, body: b, ip }) };
  return u;
}
async function reviewLogin(key: string, ip = `10.200.0.${++ipN}`) {
  const email = key + D;
  must((await call('POST', '/auth/email/start', { body: { email }, ip })).status === 200, `code start for ${email}`);
  const r = await call('POST', '/auth/email/verify', { body: { email, code: REVIEW_CODE }, ip });
  st(r, 200, `sign-in ${email}`);
  const [row] = await sql`select id from users where email = ${email}`;
  return makeUser(key, email, ip, r.json, row.id);
}
/** The real path: request a code, read it from the captured email, verify it. */
async function emailedCode(email: string, ip: string, start = '/auth/email/start') {
  const before = mails().length;
  st(await call('POST', start, { body: { email }, ip }), 200, `${start} for ${email}`);
  return waitFor(() => codeIn(mailsTo(email, before).at(-1)), `code email to ${email}`);
}

// ---- result table --------------------------------------------------------------------------------
type Row = { plan: string; name: string; ok: boolean; note: string; server: boolean };
const rows: Row[] = [];
async function tc(plan: string, name: string, fn: () => Promise<string | void>, opts: { server?: boolean } = {}) {
  try { const note = await fn(); rows.push({ plan, name, ok: true, note: note || '', server: !!opts.server }); }
  catch (e) { rows.push({ plan, name, ok: false, note: String((e as Error).message).replace(/\s+/g, ' ').slice(0, 220), server: !!opts.server }); }
}
function must(c: unknown, msg: string): asserts c { if (!c) throw new Error(msg); }
function st(r: Res, want: number, what: string) { if (r.status !== want) throw new Error(`${what}: HTTP ${r.status} ${r.text.slice(0, 160)} (want ${want})`); return r.json; }
function eq(got: unknown, want: unknown, what: string) { if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
const errOf = (r: Res) => r.json?.error;

const BKK = { lat: 13.7466, lng: 100.5346 };
const DAY = 86400_000;
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
const near = (a: number, b: number, tol = 120_000) => Math.abs(a - b) < tol;
const plusUntil = async (id: string) => { const [r] = await sql`select plus_until from users where id = ${id}`; return r?.plusUntil ? new Date(r.plusUntil).getTime() : null; };
const sign = (payload: string) => crypto.createHmac('sha256', RZP_SECRET).update(payload).digest('hex');
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');
const RUN_START = new Date();

// Leftovers from an earlier run (deleted accounts keep their id, not their address).
async function wipe(known: string[] = []) {
  const ids = [...new Set([...known, ...(await sql`select id from users where email like ${'%' + D}
    union select user_id from email_log where to_email like ${'%' + D} and user_id is not null`).map(r => r.id as string)])];
  // Messages outlive their sender (sender_id is set null), so shared city chats would keep them; DM chats have no owner row.
  await sql`delete from messages where sender_id = any(${ids}::uuid[])`;
  await sql`delete from chats where kind = 'dm' and (split_part(dm_key, ':', 1) = any(${ids}::text[]) or split_part(dm_key, ':', 2) = any(${ids}::text[]))`;
  await sql`delete from users where id = any(${ids}::uuid[])`;
  await sql`delete from email_log where to_email like ${'%' + D}`;
  await sql`delete from otp_codes where email like ${'%' + D}`;
}
await wipe();

// The scheduler's clock for the runs that aren't about the digest. On a Monday from 09:00 IST (isDigestTime) the real
// clock would send the weekly digest in the middle of the receipt cases, so then it is the same moment a day earlier.
// The digest cases pass nextMonday instead.
const offDigest = () => { const now = new Date(); return isDigestTime(now) ? new Date(now.getTime() - DAY) : now; };
const nextMonday = (() => { const d = new Date(); const add = ((8 - d.getUTCDay()) % 7) || 7; return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + add, 5, 0, 0)); })();
const allIds: string[] = [];
const U: Record<string, User> = {};

try {
  // ================================================================================ 1. Sign-up
  await tc('1', 'Email code sign-in (real emailed code for e@, fixed review code for a-d, f)', async () => {
    for (const k of ['a', 'b', 'c', 'd', 'f']) U[k] = await reviewLogin(k);
    const ip = `10.200.0.${++ipN}`;
    const code = await emailedCode(`e${D}`, ip);
    const r = await call('POST', '/auth/email/verify', { body: { email: `e${D}`, code }, ip });
    st(r, 200, 'verify e@');
    must(r.json.isNew === true, 'a first sign-in reports isNew');
    const [row] = await sql`select id from users where email = ${'e' + D}`;
    U.e = makeUser('e', `e${D}`, ip, r.json, row.id);
    const wrong = await call('POST', '/auth/email/verify', { body: { email: `a${D}`, code: '000000' }, ip: U.a.ip });
    must(['wrong_code', 'code_expired'].includes(errOf(wrong)), 'a wrong code is refused');
    Object.values(U).forEach(u => allIds.push(u.id));
    return '6 accounts; e@ read its code from the captured email';
  });

  await tc('1', 'Under-18 birthday refused', async () => {
    const d = new Date(); d.setUTCFullYear(d.getUTCFullYear() - 17);
    const r = await U.a.req('PATCH', '/me', { birthdate: d.toISOString().slice(0, 10) });
    st(r, 400, 'under-18 PATCH'); eq(errOf(r), 'under_18', 'error');
    must((await U.a.req('GET', '/me')).json.birthdate === null, 'birthdate not stored');
  });

  const PROFILES: Record<string, any> = {
    a: { name: 'Asha', birthdate: '1994-05-02', gender: 'woman', homeCountry: 'in', bio: 'Chai and street food', languages: ['English', 'Hindi'], interests: ['food', 'coffee', 'markets'] },
    b: { name: 'Ben', birthdate: '1990-02-02', gender: 'man', homeCountry: 'gb', languages: ['English'], interests: ['hiking', 'food'] },
    c: { name: 'Cara', birthdate: '1992-07-07', gender: 'woman', homeCountry: 'pt', languages: ['Portuguese'], interests: ['art', 'coffee'] },
    d: { name: 'Dee', birthdate: '1995-03-03', gender: 'woman', homeCountry: 'us', languages: ['English'], interests: ['yoga'] },
    e: { name: 'Eli', birthdate: '1991-01-01', gender: 'man', homeCountry: 'de', languages: ['German'], interests: ['food'] },
    f: { name: 'Fay', birthdate: '1993-09-09', gender: 'woman', homeCountry: 'ca', languages: ['English'], interests: ['books'] },
  };
  await tc('1', 'Profile fields saved (name, birthday, gender, country, bio, languages, interests)', async () => {
    for (const [k, p] of Object.entries(PROFILES)) {
      const r = await U[k].req('PATCH', '/me', p);
      st(r, 200, `PATCH ${k}`); must(r.json.onboarded === true, `${k} onboarded`);
      st(await U[k].req('POST', '/me/location', BKK), 200, `location ${k}`);
    }
    const me = (await U.a.req('GET', '/me')).json;
    eq([me.name, me.birthdate, me.gender, me.homeCountry, me.bio, me.languages, me.interests, me.city],
      ['Asha', '1994-05-02', 'woman', 'IN', 'Chai and street food', ['English', 'Hindi'], ['food', 'coffee', 'markets'], 'Bangkok'], 'A profile');
  });

  await tc('1', 'Partial profile edit keeps interests', async () => {
    st(await U.a.req('PATCH', '/me', { bio: 'Chai, street food and sunsets' }), 200, 'bio only');
    const me = (await U.a.req('GET', '/me')).json;
    eq(me.interests, ['food', 'coffee', 'markets'], 'interests'); eq(me.languages, ['English', 'Hindi'], 'languages');
    eq(me.bio, 'Chai, street food and sunsets', 'bio');
  });

  await tc('1', 'Countries visited saved (deduplicated, shown to others)', async () => {
    st(await U.a.req('PATCH', '/me', { countriesVisited: ['th', 'JP', 'TH'] }), 200, 'countries');
    eq((await U.a.req('GET', '/me')).json.countriesVisited, ['TH', 'JP'], 'own profile');
    eq((await U.b.req('GET', `/users/${U.a.id}`)).json.countriesVisited, ['TH', 'JP'], 'seen by B');
    st(await U.a.req('PATCH', '/me', { countriesVisited: ['ZZ'] }), 400, 'unknown country refused');
  });

  await tc('1', 'Logout revokes the session; logging back in keeps the data', async () => {
    st(await U.a.req('POST', '/auth/logout', { refreshToken: U.a.refresh }), 200, 'logout');
    st(await call('POST', '/auth/refresh', { body: { refreshToken: U.a.refresh }, ip: U.a.ip }), 401, 'old refresh token');
    U.a = await reviewLogin('a', U.a.ip);
    const me = (await U.a.req('GET', '/me')).json;
    eq([me.name, me.interests, me.countriesVisited, me.onboarded], ['Asha', ['food', 'coffee', 'markets'], ['TH', 'JP'], true], 'after re-login');
  });

  // ================================================================================ 10. Admin sign-in lock (needed early)
  let admin!: User;
  await tc('10', 'Admin-login lock: non-admin gets no code, same answer as an admin, cannot verify; admin signs in', async () => {
    const xip = `10.200.0.${++ipN}`, aip = `10.200.0.${++ipN}`;
    const before = mails().length;
    const rx = await call('POST', '/admin/auth/start', { body: { email: `x${D}` }, ip: xip });
    const ra = await call('POST', '/admin/auth/start', { body: { email: ADMIN }, ip: aip });
    eq([rx.status, rx.text], [ra.status, ra.text], 'non-admin vs admin response');
    eq([ra.status, ra.text], [200, '{"ok":true}'], 'response');
    const code = await waitFor(() => codeIn(mailsTo(ADMIN, before).at(-1)), 'admin code');
    await sleep(150);
    eq(mailsTo(`x${D}`, before).length, 0, 'emails to the non-admin');
    // x@ can get a genuine code from the app's own sign-in, but it doesn't open the admin panel.
    const xcode = await emailedCode(`x${D}`, xip);
    const xv = await call('POST', '/admin/auth/verify', { body: { email: `x${D}`, code: xcode }, ip: xip });
    eq([xv.status, errOf(xv)], [400, 'wrong_code'], 'non-admin admin-verify');
    eq((await sql`select count(*)::int as n from users where email = ${'x' + D}`)[0].n, 0, 'accounts created for x@');
    // A normal app session of a non-admin gets 403 from every admin endpoint.
    st(await U.b.req('GET', '/admin/me'), 403, 'B on /admin/me');
    const v = await call('POST', '/admin/auth/verify', { body: { email: ADMIN, code }, ip: aip });
    st(v, 200, 'admin verify');
    const [row] = await sql`select id from users where email = ${ADMIN}`;
    admin = makeUser('admin', ADMIN, aip, v.json, row.id); allIds.push(row.id);
    eq((await admin.req('GET', '/admin/me')).json.email, ADMIN, '/admin/me');
  });

  // ================================================================================ 2. Plans
  let P1: any, P2: any, P4: any;
  await tc('2', 'A hosts (limit 3); B and C join; join messages in the group chat; D refused as full', async () => {
    P1 = st(await U.a.req('POST', '/activities', { title: 'E2E temple walk', emoji: '🛕', category: 'explore', placeName: 'Wat Arun', ...BKK, startsAt: inHours(3), maxPeople: 3 }), 200, 'create P1');
    for (const k of ['b', 'c']) eq((await U[k].req('POST', `/activities/${P1.id}/join`)).json?.chatId, P1.chatId, `${k} joins`);
    const msgs = (await U.a.req('GET', `/chats/${P1.chatId}/messages`)).json.messages.map((m: any) => m.body);
    must(msgs.includes('Ben joined') && msgs.includes('Cara joined'), `join messages: ${JSON.stringify(msgs)}`);
    const d = await U.d.req('POST', `/activities/${P1.id}/join`);
    eq([d.status, errOf(d)], [400, 'full'], 'D joins a full plan');
    eq((await U.a.req('GET', `/activities/${P1.id}`)).json.going, 3, 'going');
  });

  // Push tokens first, so the next join can be seen going out.
  const ASHA_FCM = 'e2e-fcm-token-asha-0001';
  const ASHA_WEB = { endpoint: 'https://fcm.googleapis.com/fcm/send/e2e-asha-web', keys: { p256dh: 'B' + 'x'.repeat(86), auth: 'e2e-auth-secret' } };
  await tc('7', 'Push token registration (Android FCM token + browser subscription) and a send attempt on join', async () => {
    st(await U.a.req('POST', '/me/push-token', { token: ASHA_FCM, platform: 'android' }), 200, 'android token');
    st(await U.a.req('POST', '/me/push-token', { token: JSON.stringify(ASHA_WEB), platform: 'web' }), 200, 'web subscription');
    eq(errOf(await U.a.req('POST', '/me/push-token', { token: JSON.stringify({ ...ASHA_WEB, endpoint: 'https://evil.example/x' }), platform: 'web' })), 'bad_subscription', 'foreign push host');
    eq((await sql`select platform from push_tokens where user_id = ${U.a.id} order by platform`).map(r => r.platform), ['android', 'web'], 'stored tokens');
    P2 = st(await U.a.req('POST', '/activities', { title: 'E2E women-only brunch', emoji: '🥞', category: 'food', placeName: 'Cafe Tartine', ...BKK, startsAt: inHours(5), womenOnly: true }), 200, 'create P2');
    const from = fake.pushes.length;
    st(await U.c.req('POST', `/activities/${P2.id}/join`), 200, 'C joins P2');
    await waitFor(() => fake.pushes.slice(from).filter(p => p.title === 'Cara joined your plan 🎉').length >= 2, 'FCM + web push to A');
    const got = fake.pushes.slice(from).filter(p => p.title === 'Cara joined your plan 🎉');
    eq(got.map(p => `${p.kind}:${p.to}`).sort(), [`fcm:${ASHA_FCM}`, `web:${ASHA_WEB.endpoint}`], 'push targets');
    return 'server side only: delivery to a locked phone not tested';
  }, { server: true });

  await tc('2', 'Women-only plan: invisible to man B in the list and a 404 by id; A and C (women) see it', async () => {
    const list = async (u: User) => (await u.req('GET', `/activities?lat=${BKK.lat}&lng=${BKK.lng}`)).json.activities.map((x: any) => x.id);
    must(!(await list(U.b)).includes(P2.id), 'B list hides it');
    eq((await U.b.req('GET', `/activities/${P2.id}`)).status, 404, 'B by id');
    eq((await U.b.req('POST', `/activities/${P2.id}/join`)).status, 403, 'B join');
    must((await list(U.d)).includes(P2.id), 'D (woman) sees it');
    eq((await U.a.req('GET', `/activities/${P2.id}`)).status, 200, 'A by id');
  });

  await tc('2', 'A closes P1: D cannot join, members still chat; A reopens it', async () => {
    eq((await U.b.req('POST', `/activities/${P1.id}/close`, { closed: true })).status, 403, 'non-host close');
    eq((await U.a.req('POST', `/activities/${P1.id}/close`, { closed: true })).json.closed, true, 'close');
    eq(errOf(await U.d.req('POST', `/activities/${P1.id}/join`)), 'plan_closed', 'D join while closed');
    st(await U.b.req('POST', `/chats/${P1.chatId}/messages`, { body: 'Still on for tonight?' }), 200, 'member chats');
    eq((await U.a.req('POST', `/activities/${P1.id}/close`, { closed: false })).json.closed, false, 'reopen');
    eq(errOf(await U.d.req('POST', `/activities/${P1.id}/join`)), 'full', 'reopened, capacity still applies');
    st(await U.c.req('POST', `/activities/${P1.id}/leave`), 200, 'C leaves');
    st(await U.d.req('POST', `/activities/${P1.id}/join`), 200, 'D joins after reopen');
    const msgs = (await U.a.req('GET', `/chats/${P1.chatId}/messages`)).json.messages.map((m: any) => m.body);
    must(msgs.includes('The host closed this plan to new people.') && msgs.includes('The host reopened this plan to new people.'), 'close/reopen system messages');
  });

  await tc('2', 'A cancels P2: members get one inbox notice (cancelling twice does not repeat it)', async () => {
    st(await U.a.req('POST', `/activities/${P2.id}/cancel`), 200, 'cancel');
    const notices = async () => (await U.c.req('GET', '/inbox')).json.notifications.filter((n: any) => n.kind === 'cancelled' && n.activityId === P2.id);
    eq((await notices()).length, 1, 'C notices after cancel');
    eq((await notices())[0].body, 'E2E women-only brunch was cancelled by the host', 'notice text');
    const again = await U.a.req('POST', `/activities/${P2.id}/cancel`);
    must(again.status < 500, 'second cancel is not a server error');
    eq((await notices()).length, 1, 'C notices after a second cancel');
    const sys = (await U.c.req('GET', `/chats/${P2.chatId}/messages`)).json.messages.filter((m: any) => m.body === 'The host cancelled this plan.');
    eq(sys.length, 1, 'cancel system messages');
  });

  await tc('2', '"Someone joined your plan" email is batched: at most 1 per plan per 6 hours', async () => {
    P4 = st(await U.b.req('POST', '/activities', { title: 'E2E tapas night', emoji: '🍢', category: 'food', placeName: 'Soi 11', ...BKK, startsAt: inHours(8) }), 200, 'B creates P4');
    for (const k of ['c', 'd']) st(await U[k].req('POST', `/activities/${P4.id}/join`), 200, `${k} joins P4`);
    await sleep(300);   // let B's own last_seen_at bumps land before the clock is moved
    // Time shift in the database: the joins were 40 minutes ago and B last opened the app 2 hours ago.
    await sql`update activity_members set joined_at = now() - interval '40 minutes' where activity_id = ${P4.id} and user_id <> ${U.b.id}`;
    await sql`update users set last_seen_at = now() - interval '2 hours' where id = ${U.b.id}`;
    const m0 = mails().length;
    await planJoins();
    eq(mailsTo(U.b.email, m0).map(m => m.subject), ['2 people joined E2E tapas night'], 'first batch');
    await planJoins();
    eq(mailsTo(U.b.email, m0).length, 1, 'second scheduler run');
    st(await U.a.req('POST', `/activities/${P4.id}/join`), 200, 'A joins P4');
    await sleep(200);
    await sql`update activity_members set joined_at = now() - interval '20 minutes' where activity_id = ${P4.id} and user_id = ${U.a.id}`;
    await planJoins();
    eq(mailsTo(U.b.email, m0).length, 1, 'a new join inside 6 hours waits');
    // Move the whole story 7 hours back: first joins, then the first email; Asha's join stays recent.
    await sql`update activity_members set joined_at = joined_at - interval '7 hours' where activity_id = ${P4.id} and user_id not in (${U.b.id}, ${U.a.id})`;
    await sql`update email_log set created_at = created_at - interval '7 hours' where kind = 'plan_joined' and ref = ${P4.id}`;
    await planJoins();
    const got = mailsTo(U.b.email, m0);
    eq(got.map(m => m.subject), ['2 people joined E2E tapas night', 'Asha joined E2E tapas night'], 'after 6 hours');
    must(!got[1].text.includes('Cara'), 'second batch lists only the new joiner');
    await planJoins();
    eq(mailsTo(U.b.email, m0).length, 2, 'no repeat');
    return 'clock moved in the database';
  });

  // ================================================================================ 3. Chat
  await tc('3', 'Messages list (sender name, order, unread for others)', async () => {
    st(await U.b.req('POST', `/chats/${P1.chatId}/messages`, { body: 'Meet at the pier at 5?' }), 200, 'send');
    const list = (await U.a.req('GET', `/chats/${P1.chatId}/messages`)).json.messages;
    const last = list.at(-1);
    eq([last.body, last.senderName, last.kind], ['Meet at the pier at 5?', 'Ben', 'text'], 'last message');
    must((await U.a.req('GET', '/chats')).json.chats.find((c: any) => c.id === P1.chatId).unread > 0, 'unread for A');
    eq((await U.e.req('GET', `/chats/${P1.chatId}/messages`)).status, 403, 'non-member');
  });

  await tc('3', 'Photo message via direct upload', async () => {
    const up = st(await call('POST', '/uploads/image/direct?kind=chat', { token: U.b.token, ip: U.b.ip, raw: JPEG, type: 'image/jpeg' }), 200, 'upload');
    must(new RegExp(`^chat/${U.b.id}/[0-9a-f]{16}\\.jpg$`).test(up.key), `key ${up.key}`);
    st(await U.b.req('POST', `/chats/${P1.chatId}/messages`, { body: up.publicUrl, kind: 'image' }), 200, 'send image');
    const last = (await U.a.req('GET', `/chats/${P1.chatId}/messages`)).json.messages.at(-1);
    eq([last.kind, last.body], ['image', up.publicUrl], 'image message');
    const img = await fetch(up.publicUrl);
    eq([img.status, img.headers.get('content-type')], [200, 'image/jpeg'], 'photo served');
    st(await call('POST', '/uploads/image/direct?kind=chat', { token: U.b.token, ip: U.b.ip, raw: Buffer.from('hi'), type: 'text/plain' }), 400, 'non-image refused');
  });

  await tc('3', 'Poll: create, vote, change vote', async () => {
    const p = st(await U.a.req('POST', `/chats/${P1.chatId}/polls`, { question: 'Dinner where?', options: ['Thai', 'Indian', 'Street food'] }), 200, 'create poll');
    const vote = (u: User, option: number) => u.req('POST', `/chats/${P1.chatId}/polls/${p.id}/vote`, { option });
    eq((await vote(U.b, 0)).json.poll.counts, [1, 0, 0], 'B votes Thai');
    const changed = (await vote(U.b, 2)).json.poll;
    eq([changed.counts, changed.myVote], [[0, 0, 1], 2], 'B changes to street food');
    eq((await vote(U.d, 2)).json.poll.counts, [0, 0, 2], 'D votes');
    eq((await vote(U.d, 5)).status, 400, 'option out of range');
    eq((await vote(U.e, 0)).status, 403, 'non-member vote');
  });

  let city: any;
  await tc('3', 'Live location allowed in a plan chat, refused in a city chat', async () => {
    const loc = st(await U.a.req('POST', `/chats/${P1.chatId}/locations`, { ...BKK, minutes: 15 }), 200, 'share in plan chat');
    must(loc.location && new Date(loc.location.expiresAt).getTime() > Date.now() + 14 * 60_000, 'expires in 15 minutes');
    st(await U.a.req('PATCH', `/chats/${P1.chatId}/locations/${loc.id}`, { lat: 13.75, lng: 100.54 }), 200, 'move');
    eq((await U.b.req('PATCH', `/chats/${P1.chatId}/locations/${loc.id}`, { lat: 1, lng: 1 })).status, 403, 'someone else moves it');
    st(await U.a.req('POST', `/chats/${P1.chatId}/locations/${loc.id}/stop`), 200, 'stop');
    city = st(await U.a.req('POST', '/chats/city-here', BKK), 200, 'city chat here');
    eq(city.city, 'Bangkok', 'city');
    const r = await U.a.req('POST', `/chats/${city.chatId}/locations`, { ...BKK, minutes: 15 });
    eq([r.status, errOf(r)], [400, 'no_location_in_city_chat'], 'city chat location');
  });

  await tc('3', 'Abusive message blocked in a group chat', async () => {
    const r = await U.b.req('POST', `/chats/${P1.chatId}/messages`, { body: 'E2E-ABUSE you are worthless' });
    eq([r.status, errOf(r)], [400, 'message_blocked'], 'abusive message');
    must(!(await U.a.req('GET', `/chats/${P1.chatId}/messages`)).json.messages.some((m: any) => m.body.includes('E2E-ABUSE')), 'not stored');
    return 'server side with a moderation double (OpenAI not called)';
  }, { server: true });

  await tc('3', 'Direct message', async () => {
    const dm = st(await U.a.req('POST', `/dm/${U.b.id}`), 200, 'open DM');
    eq((await U.b.req('POST', `/dm/${U.a.id}`)).json.chatId, dm.chatId, 'same DM from the other side');
    st(await U.a.req('POST', `/chats/${dm.chatId}/messages`, { body: 'Hey Ben, want to share a tuk-tuk?' }), 200, 'send');
    const chat = (await U.b.req('GET', '/chats')).json.chats.find((c: any) => c.id === dm.chatId);
    eq([chat.kind, chat.title, chat.lastMessage.body], ['dm', 'Asha', 'Hey Ben, want to share a tuk-tuk?'], 'B chat list');
    eq((await U.a.req('POST', `/chats/${dm.chatId}/polls`, { question: 'x?', options: ['a', 'b'] })).status, 400, 'no polls in a DM');
  });

  await tc('3', 'Reactions, replies and read receipts', async () => {
    const m = st(await U.a.req('POST', `/chats/${P1.chatId}/messages`, { body: 'Street food after the pier?' }), 200, 'send');
    const r = st(await U.b.req('POST', `/chats/${P1.chatId}/messages/${m.id}/react`, { emoji: '👍' }), 200, 'react');
    eq(r.reactions.map((x: any) => [x.emoji, x.count, x.mine]), [['👍', 1, true]], 'B reacted');
    eq((await U.b.req('POST', `/chats/${P1.chatId}/messages/${m.id}/react`, { emoji: '👍' })).json.emoji, null, 'toggle off');
    st(await U.b.req('POST', `/chats/${P1.chatId}/messages/${m.id}/react`, { emoji: '❤️' }), 200, 'B reacts again');
    const reply = st(await U.b.req('POST', `/chats/${P1.chatId}/messages`, { body: 'Yes, Yaowarat!', replyTo: m.id }), 200, 'reply');
    eq([reply.replyTo.id, reply.replyTo.senderName, reply.replyTo.body], [m.id, 'Asha', 'Street food after the pier?'], 'quote');
    const dm = st(await U.a.req('POST', `/dm/${U.b.id}`), 200, 'DM');
    const dmMsg = st(await U.a.req('POST', `/chats/${dm.chatId}/messages`, { body: 'Private' }), 200, 'DM message');
    eq(errOf(await U.b.req('POST', `/chats/${P1.chatId}/messages`, { body: 'x', replyTo: dmMsg.id })), 'reply_not_in_chat', 'quote from another chat');
    const view = (await U.a.req('GET', `/chats/${P1.chatId}/messages`)).json;
    eq(view.messages.find((x: any) => x.id === m.id).reactions.map((x: any) => x.emoji), ['❤️'], 'A sees B\'s reaction');
    st(await U.b.req('POST', `/chats/${P1.chatId}/read`), 200, 'B reads');
    const later = st(await U.a.req('POST', `/chats/${P1.chatId}/messages`, { body: 'See you at 5' }), 200, 'A sends');
    st(await U.b.req('POST', `/chats/${P1.chatId}/read`), 200, 'B reads again');
    must(Number((await U.a.req('GET', `/chats/${P1.chatId}/messages`)).json.reads[U.b.id]) >= Number(later.id), 'seen by B');
  });

  await tc('2', 'AI idea pins: only geocoded places get coordinates; quota checked first', async () => {
    const q = st(await U.a.req('GET', '/ai/quota'), 200, 'quota');
    must(q.remaining > 0 && q.limit === 3, `quota ${JSON.stringify(q)}`);
    const r = st(await U.a.req('GET', `/ai/suggest?city=Bangkok&lat=${BKK.lat}&lng=${BKK.lng}`), 200, 'suggest');
    eq(r.ideas.map((i: any) => [i.placeName, i.lat ?? null, i.lng ?? null]),
      [['Yaowarat Road', 13.7398, 100.5096], ['Wat Arun', 13.7437, 100.4889], ['E2E Unknown Karaoke', null, null]], 'coordinates');
    eq((await U.a.req('GET', '/ai/quota')).json.remaining, q.remaining - 1, 'one used');
    return 'server side with OpenAI and Photon doubles';
  }, { server: true });

  // ================================================================================ 4. Trips
  const trips: Record<string, any> = {};
  await tc('4', 'Overlapping trips see each other', async () => {
    trips.a = st(await U.a.req('POST', '/trips', { city: 'Tavira', countryCode: 'pt', startDate: iso(2), endDate: iso(8) }), 200, 'A trip');
    trips.b = st(await U.b.req('POST', '/trips', { city: 'Tavira', countryCode: 'PT', startDate: iso(4), endDate: iso(10) }), 200, 'B trip');
    eq([trips.a.startDate, trips.a.endDate], [iso(2), iso(8)], 'dates round-trip');
    const oa = (await U.a.req('GET', `/trips/${trips.a.id}/overlaps`)).json, ob = (await U.b.req('GET', `/trips/${trips.b.id}/overlaps`)).json;
    eq([oa.total, oa.travelers.map((t: any) => t.name)], [1, ['Ben']], 'A sees');
    eq([ob.total, ob.travelers.map((t: any) => t.name)], [1, ['Asha']], 'B sees');
    const list = (await U.a.req('GET', '/trips')).json.trips.find((t: any) => t.id === trips.a.id);
    eq([list.overlapCount, list.overlapFaces.map((f: any) => f.name)], [1, ['Ben']], 'trip list');
    eq(errOf(await U.a.req('POST', '/trips', { city: 'Tavira', countryCode: 'PT', startDate: iso(8), endDate: iso(2) })), 'bad_dates', 'end before start');
  });

  await tc('4', 'City chat join (free: within 3 days of arrival)', async () => {
    const c = st(await U.a.req('POST', `/trips/${trips.a.id}/city-chat`), 200, 'A joins');
    must((await U.a.req('GET', '/chats')).json.chats.some((x: any) => x.id === c.chatId), 'in chat list');
    const early = await U.b.req('POST', `/trips/${trips.b.id}/city-chat`);
    eq([early.status, errOf(early)], [402, 'plus_required'], 'B arrives in 4 days (free plan)');
  });

  let digestA: Mail | undefined;
  await tc('4', 'Weekly digest generated for users with an upcoming trip', async () => {
    const m0 = mails().length;
    await weeklyDigest({}, nextMonday);
    digestA = mailsTo(U.a.email, m0)[0];
    eq(mailsTo(U.a.email, m0).map(m => m.subject), ['1 traveler in Tavira on your dates'], 'A digest');
    eq(mailsTo(U.b.email, m0).map(m => m.subject), ['1 traveler in Tavira on your dates'], 'B digest');
    must(digestA!.text.includes('Ben'), 'lists Ben');
    for (const k of ['c', 'd', 'e', 'f']) eq(mailsTo(U[k].email, m0).length, 0, `${k} has no trip`);
    await weeklyDigest({}, nextMonday);
    eq(mailsTo(U.a.email, m0).length + mailsTo(U.b.email, m0).length, 2, 'second run same week');
    return `week of ${nextMonday.toISOString().slice(0, 10)} (Monday 10:30 IST)`;
  });

  await tc('4', 'Unsubscribe link works and stops the digest', async () => {
    must(digestA, 'A digest exists');
    const link = digestA.html.match(/href="(http[^"]*\/email\/unsubscribe\?t=[^"]+)"/)?.[1].replace(/&amp;/g, '&');
    must(link && link.startsWith(BASE), `link points at this server: ${link}`);
    eq(digestA.headers?.['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click', 'one-click header');
    const page = await call('GET', link.slice(BASE.length));
    must(page.status === 200 && page.text.includes(`You're unsubscribed`), `unsubscribe page ${page.status}`);
    eq((await U.a.req('GET', '/me/email-prefs')).json.prefs.digest, false, 'pref stored');
    const m0 = mails().length;
    await weeklyDigest({}, new Date(nextMonday.getTime() + 7 * DAY));
    eq(mailsTo(U.a.email, m0).length, 0, 'A next week');
    eq(mailsTo(U.b.email, m0).length, 1, 'B next week');
  });

  // ================================================================================ 5. Profile views, thumbs-up, snooze
  await tc('5', 'Free users see profile views with hidden names', async () => {
    st(await U.b.req('GET', `/users/${U.a.id}`), 200, 'B opens A');
    const v = (await U.a.req('GET', '/me/viewers')).json;
    eq([v.count >= 1, v.locked, v.viewers], [true, true, []], 'A (free) viewers');
    const n = (await U.a.req('GET', '/inbox')).json.notifications.find((x: any) => x.kind === 'profile_view');
    eq([n?.locked, n?.actorName, n?.body], [true, null, 'Someone viewed your profile'], 'inbox entry');
  });

  await tc('5', 'Thumbs-up only after the plan starts and only between co-members', async () => {
    const early = await U.a.req('POST', '/vouches', { activityId: P1.id, userId: U.b.id });
    eq(errOf(early), 'plan_not_started', 'before start');
    await sql`update activities set starts_at = now() - interval '1 hour' where id = ${P1.id}`;
    st(await U.a.req('POST', '/vouches', { activityId: P1.id, userId: U.b.id }), 200, 'A thumbs-up B');
    eq(errOf(await U.a.req('POST', '/vouches', { activityId: P1.id, userId: U.e.id })), 'not_in_plan', 'A to non-member E');
    eq(errOf(await U.e.req('POST', '/vouches', { activityId: P1.id, userId: U.a.id })), 'not_in_plan', 'non-member E to A');
    eq(errOf(await U.c.req('POST', '/vouches', { activityId: P1.id, userId: U.b.id })), 'not_in_plan', 'C left the plan');
    eq((await U.a.req('GET', `/users/${U.b.id}`)).json.vouches, 1, 'B vouch count');
    must((await U.b.req('GET', '/inbox')).json.notifications.some((n: any) => n.kind === 'vouch' && n.body === 'Asha gave you a thumbs-up for E2E temple walk'), 'B inbox');
    st(await U.a.req('POST', '/vouches', { activityId: P1.id, userId: U.b.id }), 200, 'repeat is a no-op');
    eq((await U.a.req('GET', `/users/${U.b.id}`)).json.vouches, 1, 'still 1');
    return 'plan start moved into the past in the database';
  });

  await tc('5', 'Snooze hides you from nearby and travelers; undo restores', async () => {
    const ids = async (p: string) => (await U.a.req('GET', `${p}?lat=${BKK.lat}&lng=${BKK.lng}`)).json.travelers.map((t: any) => t.id);
    must((await ids('/travelers')).includes(U.b.id), 'B visible first');
    st(await U.b.req('POST', '/me/snooze', { duration: '24h' }), 200, 'snooze');
    must((await U.b.req('GET', '/me')).json.snoozed === true, 'B snoozed');
    must(!(await ids('/travelers')).includes(U.b.id) && !(await ids('/travelers/nearby')).includes(U.b.id), 'hidden');
    st(await U.b.req('DELETE', '/me/snooze'), 200, 'undo');
    must((await ids('/travelers')).includes(U.b.id) && (await ids('/travelers/nearby')).includes(U.b.id), 'back');
  });

  // ================================================================================ 6. Safety
  const REASONS = ['harassment', 'spam', 'fake_profile', 'inappropriate', 'unsafe', 'underage', 'other'];
  await tc('6', 'Report with each reason (user, plan and message targets)', async () => {
    // Every report opens a support ticket: the reporter gets a confirmation email carrying its TM- ref.
    const report = async (k: 'a' | 'c' | 'd', payload: object, what: string) => {
      const r = await U[k].req('POST', '/reports', payload); st(r, 200, what);
      must(/^TM-/.test(r.json.ref ?? ''), `${what}: ticket ref`); reportTickets.push([k + D, r.json.ref]);
    };
    for (const reason of REASONS) await report('a', { targetType: 'user', targetId: U.e.id, reason, details: `e2e ${reason}` }, `report ${reason}`);
    await report('c', { targetType: 'activity', targetId: P4.id, reason: 'spam' }, 'plan report');
    const msg = (await U.a.req('GET', `/chats/${P1.chatId}/messages`)).json.messages.find((m: any) => m.senderId === U.b.id);
    await report('d', { targetType: 'message', targetId: msg.id, reason: 'inappropriate' }, 'message report');
    eq((await U.a.req('POST', '/reports', { targetType: 'user', targetId: U.e.id, reason: 'rude' })).status, 400, 'unknown reason');
    eq((await sql`select count(*)::int as n from reports where reporter_id = ${U.a.id}`)[0].n, 7, 'stored');
  });

  await tc('6', 'Block hides both ways (lists, plans, profile, DMs, city chat, trips)', async () => {
    st(await U.e.req('POST', '/trips', { city: 'Tavira', countryCode: 'PT', startDate: iso(3), endDate: iso(6) }), 200, 'E trip');
    st(await U.e.req('POST', '/chats/city-here', BKK), 200, 'E in city chat');
    const tv = async (u: User) => (await u.req('GET', `/travelers?lat=${BKK.lat}&lng=${BKK.lng}`)).json.travelers.map((t: any) => t.id);
    must((await tv(U.a)).includes(U.e.id) && (await tv(U.e)).includes(U.a.id), 'visible before the block');
    st(await U.a.req('POST', `/blocks/${U.e.id}`), 200, 'A blocks E');
    const nearby = async (u: User) => (await u.req('GET', `/travelers/nearby?lat=${BKK.lat}&lng=${BKK.lng}`)).json.travelers.map((t: any) => t.id);
    must(!(await tv(U.a)).includes(U.e.id) && !(await nearby(U.a)).includes(U.e.id), 'A no longer sees E');
    must(!(await tv(U.e)).includes(U.a.id) && !(await nearby(U.e)).includes(U.a.id), 'E no longer sees A');
    must(!(await U.e.req('GET', `/activities?lat=${BKK.lat}&lng=${BKK.lng}`)).json.activities.some((x: any) => x.host.id === U.a.id), 'A plans hidden from E');
    eq(errOf(await U.e.req('POST', `/dm/${U.a.id}`)), 'blocked', 'E DMs A');
    eq(errOf(await U.a.req('POST', `/dm/${U.e.id}`)), 'blocked', 'A DMs E');
    eq(errOf(await U.e.req('GET', `/users/${U.a.id}`)), 'not_found', 'E opens A');
    st(await U.e.req('POST', `/chats/${city.chatId}/messages`, { body: 'Anyone for rooftop drinks?' }), 200, 'E posts in city chat');
    st(await U.a.req('POST', `/chats/${city.chatId}/messages`, { body: 'Hello Bangkok travelers' }), 200, 'A posts in city chat');
    const bodies = async (u: User) => (await u.req('GET', `/chats/${city.chatId}/messages`)).json.messages.map((m: any) => m.body);
    must(!(await bodies(U.a)).includes('Anyone for rooftop drinks?'), 'A does not see E in the city chat');
    must(!(await bodies(U.e)).includes('Hello Bangkok travelers'), 'E does not see A in the city chat');
    const ov = (await U.a.req('GET', `/trips/${trips.a.id}/overlaps`)).json.travelers.map((t: any) => t.id);
    must(!ov.includes(U.e.id), 'trip overlaps hide E');
    const tl = (await U.a.req('GET', '/trips')).json.trips.find((t: any) => t.id === trips.a.id);
    eq([tl.overlapCount, tl.overlapFaces.map((f: any) => f.name)], [1, ['Ben']], 'A trip list (count and faces) hides E');
    const el = (await U.e.req('GET', '/trips')).json.trips[0];
    must(!el.overlapFaces.some((f: any) => f.id === U.a.id), 'E trip list hides A');
  });

  const selfies: Record<string, string> = {};
  const FACE = (f: string) => fs.readFileSync(path.join(API_DIR, 'src/test-fixtures/faces', f));
  await tc('6', 'Verification is automatic: matching selfie approved, stranger rejected with a reason, emails sent', async () => {
    const m0 = mails().length;
    // B's selfie is the same person as the profile photo, head turned; C's is someone else.
    for (const [k, selfieFile] of [['b', 'same-person-turned.jpg'], ['c', 'other-person-turned.jpg']] as const) {
      const u = U[k];
      const avatar = st(await call('POST', '/uploads/image/direct?kind=avatar', { token: u.token, ip: u.ip, raw: FACE('profile.jpg'), type: 'image/jpeg' }), 200, 'avatar');
      eq(errOf(await u.req('POST', '/verify', { key: avatar.key, pose: 'turn_head' })), 'photo_needed', 'no profile photo yet');
      st(await u.req('PATCH', '/me', { photoUrl: avatar.publicUrl }), 200, 'set photo');
      const selfie = st(await call('POST', '/uploads/image/direct?kind=avatar', { token: u.token, ip: u.ip, raw: FACE(selfieFile), type: 'image/jpeg' }), 200, 'selfie');
      eq(errOf(await u.req('POST', '/verify', { key: `avatar/${U.a.id}/0123456789abcdef.jpg`, pose: 'turn_head' })), 'bad_photo', "someone else's key");
      eq((await u.req('POST', '/verify', { key: selfie.key, pose: 'turn_head' })).json.status, 'pending', 'submit');
      selfies[k] = selfie.key;
    }
    await waitFor(async () => (await U.b.req('GET', '/verify')).json.status !== 'pending' && (await U.c.req('GET', '/verify')).json.status !== 'pending', 'automatic outcomes', 15000);
    eq((await U.b.req('GET', '/verify?v=2')).json.status, 'approved', 'B approved');
    const c = (await U.c.req('GET', '/verify?v=2')).json;
    eq([c.status, c.reason, c.triesLeft], ['rejected', 'no_match', 4], 'C rejected');
    await waitFor(() => mailsTo(U.b.email, m0).length && mailsTo(U.c.email, m0).length, 'verification emails');
    eq(mailsTo(U.b.email, m0).map(m => m.subject), [`You're verified on Tablamigo`], 'B email');
    eq(mailsTo(U.c.email, m0).map(m => m.subject), [`Your verification photo didn't pass`], 'C email');
    eq([(await U.b.req('GET', '/me')).json.verified, (await U.c.req('GET', '/me')).json.verified], [true, false], 'verified flags');
    must((await U.c.req('GET', '/inbox')).json.notifications.some((n: any) => n.kind === 'verify_rejected'), 'C inbox');
    return 'server side only: the camera capture itself is on the phone';
  }, { server: true });

  // ================================================================================ 10. Admin panel
  await tc('10', 'Admin sees overview, users, reports and verifications', async () => {
    const ov = st(await admin.req('GET', '/admin/overview'), 200, 'overview');
    must(ov.users.total >= 7 && ov.queues.openReports >= 9, `overview numbers ${JSON.stringify(ov.queues)}`);
    eq((await admin.req('GET', `/admin/users?q=${encodeURIComponent('a' + D)}`)).json.users.map((u: any) => u.email), [U.a.email], 'user search');
    const detail = st(await admin.req('GET', `/admin/users/${U.e.id}`), 200, 'user detail');
    eq(detail.reports.length, 7, 'reports on E');
    const reps = (await admin.req('GET', '/admin/reports')).json.reports.filter((r: any) => r.reporterId === U.a.id);
    eq(reps.map((r: any) => r.reason).sort(), [...REASONS].sort(), 'reports queue');
    eq(reps[0].targetUserEmail, U.e.email, 'report target resolved');
    const ver = (await admin.req('GET', '/admin/verifications')).json.requests.filter((r: any) => [U.b.id, U.c.id].includes(r.userId));
    eq(ver.map((r: any) => r.status).sort(), ['approved', 'rejected'], 'verification outcomes log');
    must(ver.every((r: any) => r.selfieUrl.includes('/dev-files/avatar/') && typeof r.scores?.similarity === 'number'), 'selfie urls and scores');
    for (const p of ['/admin/plans?when=all&status=all', '/admin/subscriptions', '/admin/emails', '/admin/revenue']) st(await admin.req('GET', p), 200, p);
    st(await admin.req('POST', `/admin/reports/${reps[0].id}/resolve`), 200, 'resolve a report');
  });

  await tc('6', 'Admin override (optional) flips an automatic outcome', async () => {
    const ver = (await admin.req('GET', '/admin/verifications')).json.requests;
    const idOf = (u: User) => ver.find((r: any) => r.userId === u.id).id;
    eq((await admin.req('POST', `/admin/verifications/${idOf(U.b)}/approve`)).status, 404, 'already approved');
    eq((await admin.req('POST', `/admin/verifications/${idOf(U.c)}/approve`)).json, { ok: true, status: 'approved' }, 'override C');
    eq((await U.c.req('GET', '/me')).json.verified, true, 'C verified by override');
  });

  await tc('10', 'Comp Plus works', async () => {
    const r = st(await admin.req('POST', `/admin/users/${U.a.id}/comp`, { days: 30 }), 200, 'comp');
    must(near(new Date(r.plusUntil).getTime(), Date.now() + 30 * DAY, 60_000), 'plus_until = +30 days');
    eq((await U.a.req('GET', '/me')).json.plus, true, 'A is Plus');
    eq((await admin.req('GET', `/admin/users?q=${encodeURIComponent('a' + D)}`)).json.users[0].plusSource, 'comp', 'plus source');
  });

  await tc('5', 'Plus users see who viewed them (names shown)', async () => {
    const v = (await U.a.req('GET', '/me/viewers')).json;
    eq([v.locked, v.viewers.map((x: any) => x.name)], [false, ['Ben']], 'A (Plus via comp) viewers');
    const n = (await U.a.req('GET', '/inbox')).json.notifications.find((x: any) => x.kind === 'profile_view');
    eq([n.locked, n.actorName], [false, 'Ben'], 'inbox entry unlocked');
  });

  await tc('10', 'A non-admin gets 403 from admin endpoints', async () => {
    for (const p of ['/admin/overview', '/admin/users', '/admin/reports', '/admin/verifications', '/admin/me']) eq((await U.b.req('GET', p)).status, 403, p);
    eq((await U.b.req('POST', `/admin/users/${U.b.id}/comp`, { days: 30 })).status, 403, 'comp');
    eq((await U.b.req('POST', `/admin/users/${U.e.id}/ban`)).status, 403, 'ban');
    eq((await call('GET', '/admin/overview')).status, 401, 'no token');
  });

  // ================================================================================ 8. Payments
  const SUB_TOKEN = 'e2e-play-sub-ben-000001';
  await tc('8', 'Google Play verify + RTDN renewal gives Plus and a receipt email', async () => {
    const exp = Date.now() + 7 * DAY;
    fake.play.subs.set(SUB_TOKEN, { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', latestOrderId: 'GPA.e2e-0001', startTime: new Date().toISOString(),
      lineItems: [{ productId: 'tablamigo_plus', expiryTime: new Date(exp).toISOString(), offerDetails: { basePlanId: 'weekly' }, autoRenewingPlan: { recurringPrice: { currencyCode: 'INR', units: '149', nanos: 0 } } }] });
    const v = st(await U.b.req('POST', '/billing/google/verify', { productId: 'tablamigo_plus', purchaseToken: SUB_TOKEN }), 200, 'verify');
    eq(v.active, true, 'active');
    eq((await U.b.req('GET', '/me')).json.plus, true, 'B is Plus');
    await waitFor(() => fake.calls.some(c => c.includes(`${SUB_TOKEN}:acknowledge`)), 'acknowledged with Google (after the answer)');
    eq(errOf(await U.c.req('POST', '/billing/google/verify', { productId: 'tablamigo_plus', purchaseToken: SUB_TOKEN })), 'verify_failed', "C can't reuse B's token");
    const renewed = Date.now() + 14 * DAY;
    fake.play.subs.get(SUB_TOKEN).lineItems[0].expiryTime = new Date(renewed).toISOString();
    st(await call('POST', '/billing/google/rtdn', { body: { message: { data: b64({ subscriptionNotification: { purchaseToken: SUB_TOKEN, notificationType: 2 } }) } } }), 200, 'RTDN');
    must(near((await plusUntil(U.b.id))!, renewed, 2000), 'renewal moved plus_until');
    const m0 = mails().length;
    await runEmailJobs(offDigest());
    const receipt = mailsTo(U.b.email, m0);
    eq(receipt.map(m => m.subject), ['Your Tablamigo Plus receipt'], 'receipt');
    must(receipt[0].text.includes('₹149') && receipt[0].text.includes('Google Play'), 'receipt details');
    return 'server side only: Play purchase answered by a Google Play double';
  }, { server: true });

  const PASS1 = 'e2e-play-pass-cara-0001', PASS2 = 'e2e-play-pass-cara-0002';
  await tc('8', 'Trip Pass stacks days (Play pass twice = 28 days) with a receipt for each', async () => {
    fake.play.products.set(PASS1, { purchaseState: 0, consumptionState: 0, orderId: 'GPA.e2e-pass-1' });
    fake.play.products.set(PASS2, { purchaseState: 0, consumptionState: 0, orderId: 'GPA.e2e-pass-2' });
    const one = st(await U.c.req('POST', '/billing/google/verify', { productId: 'tablamigo_trip_pass', purchaseToken: PASS1 }), 200, 'pass 1');
    must(near(new Date(one.expiresAt).getTime(), Date.now() + 14 * DAY), 'first pass = 14 days');
    const two = st(await U.c.req('POST', '/billing/google/verify', { productId: 'tablamigo_trip_pass', purchaseToken: PASS2 }), 200, 'pass 2');
    must(near(new Date(two.expiresAt).getTime(), Date.now() + 28 * DAY), 'second pass stacks to 28 days');
    const again = st(await U.c.req('POST', '/billing/google/verify', { productId: 'tablamigo_trip_pass', purchaseToken: PASS2 }), 200, 'retry pass 2');
    eq(again.expiresAt, two.expiresAt, 'a retry grants nothing extra');
    await waitFor(() => fake.calls.filter(c => c.includes(':consume')).length === 2, 'both consumed (after the answer)');
    const m0 = mails().length;
    await runEmailJobs(offDigest());
    eq(mailsTo(U.c.email, m0).map(m => m.subject), ['Your Trip Pass receipt', 'Your Trip Pass receipt'], 'receipts');
    return 'server side only: Play purchase answered by a Google Play double';
  }, { server: true });

  await tc('5', 'Plus user (Trip Pass) sees the name of a new viewer', async () => {
    st(await U.b.req('GET', `/users/${U.c.id}`), 200, 'B opens C');
    const v = (await U.c.req('GET', '/me/viewers')).json;
    eq([v.locked, v.viewers.map((x: any) => x.name)], [false, ['Ben']], 'C viewers');
  });

  await tc('8', 'A refunded (voided) pass removes Plus; a forged void is ignored', async () => {
    const rtdnVoid = (token: string) => call('POST', '/billing/google/rtdn', { body: { message: { data: b64({ voidedPurchaseNotification: { purchaseToken: token, productType: 2 } }) } } });
    fake.play.products.get(PASS2).purchaseState = 1;
    st(await rtdnVoid(PASS2), 200, 'void pass 2');
    must(near((await plusUntil(U.c.id))!, Date.now() + 14 * DAY), 'back to the first pass');
    st(await rtdnVoid(PASS1), 200, 'forged void of pass 1');
    must(near((await plusUntil(U.c.id))!, Date.now() + 14 * DAY), 'Google still says purchased: kept');
    fake.play.products.get(PASS1).purchaseState = 1;
    st(await rtdnVoid(PASS1), 200, 'void pass 1');
    eq([await plusUntil(U.c.id), (await U.c.req('GET', '/me')).json.plus], [null, false], 'Plus removed');
    return 'server side only: refund notification answered by a Google Play double';
  }, { server: true });

  const rzpSubs: Record<string, string> = {};
  async function razorpaySubscribe(u: User) {
    const s = st(await u.req('POST', '/billing/razorpay/subscribe', { period: 'monthly' }), 200, `${u.key} subscribe`);
    Object.assign(fake.rz.subs.get(s.subscriptionId), { status: 'active', current_end: Math.floor((Date.now() + 30 * DAY) / 1000) });
    const v = st(await u.req('POST', '/billing/razorpay/subscription-verify', { subscriptionId: s.subscriptionId, paymentId: `pay_${u.key}sub`, signature: sign(`pay_${u.key}sub|${s.subscriptionId}`) }), 200, `${u.key} subscription-verify`);
    eq(v.active, true, 'subscription active');
    rzpSubs[u.key] = s.subscriptionId;
  }
  await tc('8', 'Razorpay pass + subscription verify via the Razorpay double', async () => {
    const o = st(await U.d.req('POST', '/billing/razorpay/pass-order', {}), 200, 'order');
    eq([o.amount, o.currency, fake.rz.orders.get(o.orderId).notes], [29900, 'INR', { service: 'tablamigo', user_id: U.d.id, product: 'tablamigo_trip_pass' }], 'order');
    fake.rz.payments.set('pay_e2e_dee', { id: 'pay_e2e_dee', order_id: o.orderId, amount: 29900, currency: 'INR', status: 'authorized' });
    eq(errOf(await U.d.req('POST', '/billing/razorpay/pass-verify', { orderId: o.orderId, paymentId: 'pay_e2e_dee', signature: sign('forged') })), 'verify_failed', 'bad signature');
    const pv = st(await U.d.req('POST', '/billing/razorpay/pass-verify', { orderId: o.orderId, paymentId: 'pay_e2e_dee', signature: sign(`${o.orderId}|pay_e2e_dee`) }), 200, 'pass verify');
    must(pv.active && fake.calls.includes('razorpay POST /payments/pay_e2e_dee/capture'), 'captured and granted');
    await razorpaySubscribe(U.d);
    eq((await U.d.req('GET', '/billing/plans')).json.razorpay.subscription.cancelled, false, 'subscription listed');
    fake.play.products.clear();
    await razorpaySubscribe(U.f);
    fake.rz.subs.get(rzpSubs.f).failCancel = true;   // for the deletion fallback below
    const m0 = mails().length;
    await runEmailJobs(offDigest());
    eq(mailsTo(U.d.email, m0).map(m => m.subject).sort(), ['Your Tablamigo Plus receipt', 'Your Trip Pass receipt'], 'D receipts');
    must(mailsTo(U.d.email, m0).some(m => m.text.includes('₹299')) && mailsTo(U.d.email, m0).some(m => m.text.includes('₹499')), 'amounts');
    eq(mailsTo(U.f.email, m0).map(m => m.subject), ['Your Tablamigo Plus receipt'], 'F receipt');
    return 'server side only: Checkout answered by a Razorpay double';
  }, { server: true });

  // ================================================================================ 9. Delete account
  let P5: any;
  await tc('9', 'Delete account: data wiped, plans cancelled, web subscription auto-cancelled, deletion email sent', async () => {
    P5 = st(await U.d.req('POST', '/activities', { title: 'E2E sunrise yoga', emoji: '🧘', category: 'sports', placeName: 'Lumpini Park', ...BKK, startsAt: inHours(20) }), 200, 'D hosts P5');
    st(await U.a.req('POST', `/activities/${P5.id}/join`), 200, 'A joins P5');
    st(await U.d.req('POST', '/trips', { city: 'Tavira', countryCode: 'PT', startDate: iso(20), endDate: iso(25) }), 200, 'D trip');
    st(await U.d.req('POST', '/me/push-token', { token: 'e2e-fcm-token-dee-0001', platform: 'android' }), 200, 'D push token');
    const m0 = mails().length;
    st(await U.d.req('DELETE', '/me'), 200, 'delete');
    must(fake.calls.includes(`razorpay POST /subscriptions/${rzpSubs.d}/cancel`), 'Razorpay cancel called');
    eq(fake.rz.subs.get(rzpSubs.d).cancelAtCycleEnd, 0, 'cancelled at Razorpay now (SC-06)');
    const bye = await waitFor(() => mailsTo(U.d.email, m0)[0], 'deletion email');
    eq(bye.subject, 'Your Tablamigo account is deleted', 'subject');
    must(bye.text.includes(`We've cancelled your web Plus subscription`) && !bye.text.includes('still set to renew'), 'says it was cancelled');
    eq((await U.d.req('GET', '/me')).status, 401, 'old token');
    const [row] = await sql`select email, name, bio, birthdate, deleted_at, (select count(*)::int from trips where user_id = users.id) as trips,
        (select count(*)::int from push_tokens where user_id = users.id) as tokens, (select count(*)::int from activity_members where user_id = users.id) as memberships
      from users where id = ${U.d.id}`;
    eq([row.email, row.name, row.bio, row.birthdate, !!row.deletedAt, row.trips, row.tokens, row.memberships],
      [`deleted-${U.d.id}@deleted.tablamigo`, 'Deleted user', null, null, true, 0, 0, 0], 'tombstone');
    eq((await sql`select status from activities where id = ${P5.id}`)[0].status, 'cancelled', 'hosted plan');
    const att = (await U.a.req('GET', `/activities/${P1.id}`)).json.attendees.map((x: any) => x.id);
    must(!att.includes(U.d.id), 'gone from P1 attendees');
    must((await U.a.req('GET', '/inbox')).json.notifications.some((n: any) => n.kind === 'cancelled' && n.activityId === P5.id), 'P5 members told');
    const sub = await sql`select cancel_requested_at from subscriptions where purchase_token = ${'rzp:' + rzpSubs.d}`;
    must(sub[0]?.cancelRequestedAt, 'cancel recorded');
  });

  await tc('9', 'Delete account fallback: Razorpay cancel fails, email says the subscription still renews', async () => {
    const m0 = mails().length;
    st(await U.f.req('DELETE', '/me'), 200, 'delete F');
    const bye = await waitFor(() => mailsTo(U.f.email, m0)[0], 'deletion email');
    must(bye.text.includes('still set to renew') && !bye.text.includes(`We've cancelled`), 'fallback wording');
    return 'Razorpay double refuses the cancel';
  });

  // ================================================================================ 10. Ban
  await tc('10', 'Ban logs the user out and hides them', async () => {
    st(await admin.req('POST', `/admin/users/${U.e.id}/ban`), 200, 'ban E');
    eq([(await U.e.req('GET', '/me')).status, errOf(await U.e.req('GET', '/me'))], [403, 'banned'], 'E token');
    eq((await call('POST', '/auth/refresh', { body: { refreshToken: U.e.refresh }, ip: U.e.ip })).status, 401, 'E refresh');
    const code = await emailedCode(U.e.email, U.e.ip);
    eq(errOf(await call('POST', '/auth/email/verify', { body: { email: U.e.email, code }, ip: U.e.ip })), 'banned', 'E signs in again');
    must(!(await U.b.req('GET', `/travelers?lat=${BKK.lat}&lng=${BKK.lng}`)).json.travelers.some((t: any) => t.id === U.e.id), 'hidden from travelers');
    const prof = await U.b.req('GET', `/users/${U.e.id}`);
    must(prof.status >= 400 && errOf(prof) === 'not_found', `profile of a banned user: HTTP ${prof.status}`);
    eq((await U.b.req('POST', `/dm/${U.e.id}`)).status, 404, 'DM a banned user');
    const ov = (await U.b.req('GET', `/trips/${trips.b.id}/overlaps`)).json.travelers.map((t: any) => t.id);
    must(!ov.includes(U.e.id), 'hidden from trip overlaps');
    const tl = (await U.b.req('GET', '/trips')).json.trips.find((t: any) => t.id === trips.b.id);
    must(!tl.overlapFaces.some((f: any) => f.id === U.e.id), 'hidden from trip faces');
    eq((await admin.req('GET', `/admin/users?filter=banned&q=${encodeURIComponent(U.e.email)}`)).json.total, 1, 'banned filter');
    eq((await admin.req('POST', `/admin/users/${admin.id}/ban`)).json.error, 'cannot_ban_self', 'self-ban');
  });

  // ================================================================================ 7. Inbox
  await tc('7', 'Inbox entries (join, cancelled, vouch, profile view, verification) and read state', async () => {
    const a = (await U.a.req('GET', '/inbox')).json.notifications.map((n: any) => n.kind);
    must(a.includes('join') && a.includes('profile_view') && a.includes('cancelled'), `A kinds ${a}`);
    const b = (await U.b.req('GET', '/inbox')).json.notifications.map((n: any) => n.kind);
    must(b.includes('vouch') && b.includes('verified') && b.includes('join'), `B kinds ${b}`);
    must((await U.a.req('GET', '/inbox/unread')).json.count > 0, 'unread');
    st(await U.a.req('POST', '/inbox/read', {}), 200, 'mark read');
    eq((await U.a.req('GET', '/inbox/unread')).json.count, 0, 'unread after read');
  });

  // ================================================================================ Emails
  await tc('Email', 'Second scheduler runs send nothing new (normal and digest time)', async () => {
    await runEmailJobs(offDigest()); await runEmailJobs(nextMonday);
    const m0 = mails().length;
    await runEmailJobs(offDigest()); await runEmailJobs(nextMonday); await planJoins();
    const extra = mails().slice(m0);
    eq(extra.map(m => `${m.to}: ${m.subject}`), [], 'emails from the repeat runs');
  });

  await tc('Email', 'Every email goes to the right recipient, exactly as often as expected', async () => {
    const got = mails().filter(m => m.to.endsWith(D) && !codeIn(m));
    const W = `Welcome to Tablamigo, `;
    const expected: [string, string, number][] = [
      ...['a', 'b', 'c', 'd', 'e', 'f'].map(k => [k + D, W + PROFILES[k].name, 1] as [string, string, number]),
      [`b${D}`, '2 people joined E2E tapas night', 1], [`b${D}`, 'Asha joined E2E tapas night', 1],
      [`a${D}`, '1 traveler in Tavira on your dates', 1], [`b${D}`, '1 traveler in Tavira on your dates', 2],
      [`b${D}`, `You're verified on Tablamigo`, 1], [`c${D}`, `Your verification photo didn't pass`, 1],
      [`c${D}`, `You're verified on Tablamigo`, 1], // the admin override in section 6 approves C and tells her
      [`b${D}`, 'Your Tablamigo Plus receipt', 1], [`c${D}`, 'Your Trip Pass receipt', 2],
      [`d${D}`, 'Your Trip Pass receipt', 1], [`d${D}`, 'Your Tablamigo Plus receipt', 1], [`f${D}`, 'Your Tablamigo Plus receipt', 1],
      [`d${D}`, 'Your Tablamigo account is deleted', 1], [`f${D}`, 'Your Tablamigo account is deleted', 1],
      // one support-ticket confirmation per report (section 6), each with its own ref
      ...reportTickets.map(([to, ref]) => [to, ticketSubject(ref), 1] as [string, string, number]),
    ];
    must(reportTickets.length === REASONS.length + 2, `report tickets recorded: ${reportTickets.length}`);
    const problems: string[] = [];
    for (const [to, subject, n] of expected) {
      const c = got.filter(m => m.to === to && m.subject === subject).length;
      if (c !== n) problems.push(`${to} "${subject}": ${c} (want ${n})`);
    }
    for (const m of got) if (!expected.some(([to, s]) => to === m.to && s === m.subject)) problems.push(`unexpected: ${m.to} "${m.subject}"`);
    // Sign-in codes: only to people who asked, never to the non-admin on the admin route.
    const codes = mails().filter(m => m.to.endsWith(D) && codeIn(m)).map(m => m.to);
    eq([...new Set(codes)].sort(), [ADMIN, `e${D}`, `x${D}`].sort(), 'sign-in code recipients');
    must(!problems.length, problems.join('; '));
    return `${got.length} emails to e2e accounts + ${codes.length} sign-in codes`;
  });

  await tc('Email', `Footer says "${FOOTER_ORG}"; no "Hookstep", no street address`, async () => {
    const all = mails();
    const bad: string[] = [];
    for (const m of all) {
      const foot = (m.text.split('\n\n--\n\n')[1] ?? '').replace(/https?:\/\/\S+/g, '');
      if (!m.text.includes(FOOTER_ORG) || !m.html.includes(FOOTER_ORG.replace(/&/g, '&amp;'))) bad.push(`${m.to} "${m.subject}": footer missing`);
      // "Hookstep" is the brand in FOOTER_ORG ("Tablamigo by Hookstep · Ghatkopar, Mumbai, India") and the hookstep.in addresses,
      // and nowhere else; the legal
      // name and the shared Razorpay account's other product (Hookpost) never appear. The old rule refused "Hookstep" anywhere,
      // which no email could pass because the footer itself says it.
      const outsideFooter = (m.subject + m.html + m.text).split(FOOTER_ORG).join('').replace(/[\w.@-]*hookstep\.in\b/gi, '');
      if (/Hookstep|Hookpost|Mahajan|JR Consulting|Pvt\.? Ltd|Private Limited/i.test(outsideFooter)) bad.push(`${m.to} "${m.subject}": legal name`);
      if (/\d/.test(foot) || /\b(road|marg|street|lane|nagar|floor|building|west|east|pin)\b/i.test(foot.replace(FOOTER_ORG, ''))) bad.push(`${m.to} "${m.subject}": address-like footer`);
    }
    must(!bad.length, bad.slice(0, 5).join('; '));
    const others = all.filter(m => !m.to.endsWith(D)).length;
    return `${all.length} emails checked${others ? ` (${others} to existing local demo accounts from the digest run)` : ''}`;
  });
} finally {
  // ---- report and clean up ------------------------------------------------------------------------
  server.kill('SIGTERM');
  fakeServer.close();
  const w = { plan: 5, name: Math.max(...rows.map(r => r.name.length), 4) };
  console.log(`\nTablamigo end-to-end run · API ${BASE} · ${new Date().toISOString()}\n`);
  console.log(`${'#'.padEnd(w.plan)} ${'Case'.padEnd(w.name)}  Result  Note`);
  console.log('-'.repeat(w.plan + w.name + 40));
  for (const r of rows) console.log(`${r.plan.padEnd(w.plan)} ${r.name.padEnd(w.name)}  ${r.ok ? 'PASS  ' : 'FAIL  '}  ${r.server ? '[server-side only] ' : ''}${r.note}`);
  const failed = rows.filter(r => !r.ok).length;
  console.log(`\n${rows.length - failed} passed, ${failed} failed, ${rows.filter(r => r.server).length} server-side only · emails captured in ${MAIL_FILE}`);
  if (failed) console.log(`server log: ${serverLog}`);
  // CI: a JUnit report (E2E_JUNIT=<path>) and a copy of the server log next to it, uploaded as workflow artifacts.
  if (process.env.E2E_JUNIT) {
    const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const cases = rows.map(r => `  <testcase classname="e2e-scenarios.section-${x(r.plan)}" name="${x(r.name)}">${r.ok ? (r.note ? `<system-out>${x(r.note)}</system-out>` : '') : `<failure message="${x(r.note)}"/>`}</testcase>`);
    fs.mkdirSync(path.dirname(process.env.E2E_JUNIT), { recursive: true });
    fs.writeFileSync(process.env.E2E_JUNIT, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="e2e-scenarios" tests="${rows.length}" failures="${failed}">\n${cases.join('\n')}\n</testsuite>\n`);
    try { fs.copyFileSync(serverLog, path.join(path.dirname(process.env.E2E_JUNIT), 'e2e-scenarios-server.log')); } catch {}
  }
  if (!KEEP) {
    await wipe(allIds).catch(e => console.error('cleanup failed', e.message));
    await sql`delete from email_log where created_at >= ${RUN_START}`.catch(() => {});
    for (const id of allIds) for (const k of ['avatar', 'chat']) fs.rmSync(path.join(API_DIR, '.dev-files', k, id), { recursive: true, force: true });
  }
  await sql.end();
  process.exitCode = failed ? 1 : 0;
}
