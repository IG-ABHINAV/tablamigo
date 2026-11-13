// The real server process (src/main.ts) over HTTP, with paid plans on and a Play trial offer configured: a new traveller signs in
// with an emailed code, onboards, leaves the "what now" screen and gets the Plus screen once (never again, not even from a second
// sign-in), and the paywall learns the trial offer id from GET /billing/plans. Then the public live counts: a city with 10 real
// travellers is published, one with 9 is not, and the team's or a demo persona's trips never make up the difference.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const D = '@softpaywall-e2e.tablamigo';
const RUN = Math.random().toString(36).slice(2, 7);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tablamigo-softpaywall-e2e-'));
const MAIL = path.join(TMP, 'mail.jsonl');
const LOG = path.join(TMP, 'server.log');
fs.writeFileSync(MAIL, '');

let server: ChildProcess;
let fake: http.Server;
let BASE = '';
let db: any;
const freePort = () => new Promise<number>(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
let ipN = 0;
async function call(method: string, p: string, o: { token?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { 'x-forwarded-for': `10.151.0.${++ipN % 250 + 1}` };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const r = await fetch(BASE + p, { method, headers, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const text = await r.text();
  let json: any = null; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
}
const mails = () => fs.readFileSync(MAIL, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const waitFor = async <T>(f: () => T | Promise<T>, what: string, ms = 5000): Promise<NonNullable<T>> => {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as NonNullable<T>; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise(r => setTimeout(r, 100)); }
};
async function signIn(email: string) {
  const before = mails().length;
  expect((await call('POST', '/auth/email/start', { body: { email } })).status).toBe(200);
  const m = await waitFor(() => mails().slice(before).find((x: any) => x.to === email), `code email to ${email}`);
  const code = String(m.subject).match(/\b(\d{6})\b/)![1];
  const r = await call('POST', '/auth/email/verify', { body: { email, code } });
  expect(r.status).toBe(200);
  return r.json.accessToken as string;
}

const CITY = (s: string) => ({ name: `E2eburg${s}${RUN}`, key: `e2eburg${s}${RUN}-zz` });
const TEN = CITY('ten'), NINE = CITY('nine');
async function seedTravellers(c: { name: string; key: string }, count: number, emailOf = (i: number) => `t${i}-${c.key}${D}`) {
  for (let i = 0; i < count; i++) {
    const [u] = await db`insert into users (email, name, onboarded, birthdate, gender) values (${emailOf(i)}, 'Traveller', true, '1992-02-02', 'man') returning id`;
    await db`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${u.id}, ${c.name}, 'ZZ', ${c.key}, current_date + 3, current_date + 8)`;
  }
}

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    const u = new URL(req.url!, 'http://f');
    const send = (o: unknown, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/openai/v1/moderations') return send({ results: [{ flagged: false, categories: {} }] });
    if (u.pathname.startsWith('/nominatim/')) return send({ address: { city: 'Bangkok', country_code: 'th' } });
    if (u.pathname.startsWith('/photon/')) return send({ type: 'FeatureCollection', features: [] });
    send({ error: 'not faked' }, 404);
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const pg = await import('postgres');
  db = pg.default(process.env.DATABASE_URL!, { max: 1, transform: pg.default.camel });
  await db`delete from users where email like ${'%' + D}`;
  // Seeded before the server's first answer (it caches the counts for 5 minutes).
  await seedTravellers(TEN, 10);
  await seedTravellers(NINE, 9);
  // The team's account and a demo persona going to NINE would make 11, but they never count.
  await seedTravellers(NINE, 1, () => `persona-${RUN}@demo.tablamigo`);
  const [team] = await db`select id from users where account_kind = 'team' limit 1`;
  if (team) await db`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${team.id}, ${NINE.name}, 'ZZ', ${NINE.key}, current_date + 3, current_date + 8)`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', PORT: String(port), PUBLIC_URL: BASE,
    DATABASE_URL: process.env.DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv',
    JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', SCHEDULER: 'off', ALL_FREE: 'false',
    HOST_WELCOME: 'off', STARTER_PLANS: 'off', OPENAI_API_KEY: 'sk-e2e-fake', PLAY_YEARLY_TRIAL_OFFER_ID: 'yearly-trial-3d',
    MAIL_CAPTURE_FILE: MAIL, E2E_FAKE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
  };
  const out = fs.openSync(LOG, 'a');
  server = spawn(process.execPath, ['--import', 'tsx', '--import', './src/scripts/e2e-preload.ts', 'src/main.ts'], { cwd: API_DIR, env: env as any, stdio: ['ignore', out, out] });
  await waitFor(async () => (await fetch(BASE + '/health').then(r => r.ok).catch(() => false)), 'server /health', 60_000);
});

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  fake?.close();
  await db`delete from trips where city_key in (${TEN.key}, ${NINE.key})`;
  await db`delete from users where email like ${'%' + D} or email = ${`persona-${RUN}@demo.tablamigo`}`;
  await db.end();
});

describe('the Plus screen after onboarding, over the real server', () => {
  let token = '';
  it('a new traveller signs in and onboards', async () => {
    token = await signIn(`maya-${RUN}${D}`);
    const r = await call('PATCH', '/me', { token, body: { name: 'Maya', birthdate: '1994-06-01', gender: 'woman', homeCountry: 'IN', interests: ['food', 'culture', 'outdoors'] } });
    expect(r.status).toBe(200);
  });

  it('leaving the start screen shows the Plus screen once; the paywall gets the trial offer id', async () => {
    expect((await call('POST', '/me/plus-intro', { token, body: {} })).json).toEqual({ show: true, reason: 'show' });
    const plans = await call('GET', '/billing/plans', { token });
    expect(plans.json.playTrialOfferId).toBe('yearly-trial-3d');
    expect(plans.json.playYearlyTrialOfferId).toBeNull();
    expect(plans.json.allFree).toBe(false);
  });

  it('never again: the same session, or a second sign-in on another phone', async () => {
    expect((await call('POST', '/me/plus-intro', { token, body: {} })).json.show).toBe(false);
    const other = await signIn(`maya-${RUN}${D}`);
    expect((await call('POST', '/me/plus-intro', { token: other, body: {} })).json.show).toBe(false);
  });
});

describe('the public live counts, over the real server', () => {
  it('publishes the city with 10 real travellers and nothing about the one with 9 (the team and a demo persona do not count)', async () => {
    const r = await call('GET', '/public/social-proof');
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control')).toBe('public, max-age=300');
    const ten = r.json.cities.find((c: any) => c.cityKey === TEN.key);
    expect(ten).toMatchObject({ city: TEN.name, upcomingTrips: 10 });
    expect(JSON.stringify(r.json)).not.toContain(NINE.key);
    expect(JSON.stringify(r.json)).not.toContain(NINE.name);
  });

  it('the website (its own origin) may read it', async () => {
    const r = await fetch(BASE + '/public/social-proof', { headers: { origin: 'https://tablamigo.hookstep.in' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBeTruthy();
  });
});
