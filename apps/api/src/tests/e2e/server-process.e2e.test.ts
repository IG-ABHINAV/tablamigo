// The real server process, as production starts it (src/main.ts: Fastify + socket.io + timers), over real HTTP and a real
// WebSocket. Outside services go to a fake in this file through src/scripts/e2e-preload.ts (it refuses to load in production
// and blocks any other outside request); emails land in a capture file. One traveller's day, end to end: sign in with an
// emailed code, onboard, find and join a plan, chat live, vote, report, block, hit a free limit, delete the account.
// src/scripts/e2e-scenarios.ts (npm run test:scenarios) is the longer multi-account run of the team test plan.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const D = '@proc.tablamigo';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tablamigo-proc-e2e-'));
const MAIL = path.join(TMP, 'mail.jsonl');
const LOG = path.join(TMP, 'server.log');
fs.writeFileSync(MAIL, '');

let server: ChildProcess;
let fake: http.Server;
let BASE = '';
let PORT = 0;
const fakeCalls: string[] = [];

const freePort = () => new Promise<number>(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
type Res = { status: number; json: any; headers: Headers };
let ipN = 0;
async function call(method: string, p: string, o: { token?: string; body?: unknown; ip?: string; headers?: Record<string, string> } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'x-forwarded-for': o.ip ?? `10.150.0.${++ipN % 250 + 1}`, ...o.headers };
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

/** A bare socket.io v4 client over Node's WebSocket (the API has no socket.io-client dependency). */
function socket(token: string) {
  const events: { event: string; data: any }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/rt/?EIO=4&transport=websocket`);
  const ready = new Promise<void>((resolve, reject) => {
    ws.onmessage = e => {
      const d = String(e.data);
      if (d === '2') ws.send('3');
      else if (d.startsWith('0')) ws.send('40' + JSON.stringify({ token }));
      else if (d.startsWith('40')) setTimeout(resolve, 300);
      else if (d.startsWith('44')) reject(new Error('refused: ' + d));
      else if (d.startsWith('42')) { const [event, data] = JSON.parse(d.slice(2)); events.push({ event, data }); }
    };
    ws.onerror = () => reject(new Error('socket error'));
  });
  return { ready, events, close: () => ws.close() };
}

async function signInWithEmailedCode(email: string, ip: string) {
  const before = mails().length;
  expect((await call('POST', '/auth/email/start', { body: { email }, ip })).status).toBe(200);
  const m = await waitFor(() => mails().slice(before).find((x: any) => x.to === email), `code email to ${email}`);
  const code = String(m.subject).match(/\b(\d{6})\b/)![1];
  const r = await call('POST', '/auth/email/verify', { body: { email, code }, ip });
  expect(r.status).toBe(200);
  return r.json as { accessToken: string; refreshToken: string; isNew: boolean };
}

beforeAll(async () => {
  // The fake for every outside service the server may call (OpenAI moderation, geocoding); anything else 404s.
  fake = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString();
    const u = new URL(req.url!, 'http://f');
    fakeCalls.push(u.pathname);
    const send = (o: unknown, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (u.pathname === '/openai/v1/moderations') {
      const flagged = raw.includes('QA-ABUSE');
      return send({ results: [{ flagged, categories: { harassment: flagged } }] });
    }
    if (u.pathname.startsWith('/nominatim/')) return send({ address: { city: 'Bangkok', country_code: 'th' } });
    if (u.pathname.startsWith('/photon/')) return send({ type: 'FeatureCollection', features: [] });
    send({ error: 'not faked' }, 404);
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', PORT: String(PORT), PUBLIC_URL: BASE,
    DATABASE_URL: process.env.DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv',
    JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', SCHEDULER: 'off', ALL_FREE: 'false',
    HOST_WELCOME: 'off', STARTER_PLANS: 'off', REVIEW_EMAILS: `guide${D}`, REVIEW_CODE: '424242', OPENAI_API_KEY: 'sk-e2e-fake',
    MAIL_CAPTURE_FILE: MAIL, E2E_FAKE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
  };
  const pg = await import('postgres');
  const db = pg.default(process.env.DATABASE_URL!, { max: 1 });
  await db`delete from users where email like ${'%' + D}`;
  await db`delete from otp_codes where email like ${'%' + D}`;
  await db.end();
  const out = fs.openSync(LOG, 'a');
  server = spawn(process.execPath, ['--import', 'tsx', '--import', './src/scripts/e2e-preload.ts', 'src/main.ts'], { cwd: API_DIR, env: env as any, stdio: ['ignore', out, out] });
  await waitFor(async () => (await fetch(BASE + '/health').then(r => r.ok).catch(() => false)), 'server /health', 60_000);
});

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  fake?.close();
  const pg = await import('postgres');
  const db = pg.default(process.env.DATABASE_URL!, { max: 1 });
  const ids = (await db`select id from users where email like ${'%' + D}`).map(r => r.id);
  if (ids.length) {
    await db`delete from messages where sender_id = any(${ids}::uuid[])`;
    await db`delete from chats where kind = 'dm' and (split_part(dm_key, ':', 1) = any(${ids}::text[]) or split_part(dm_key, ':', 2) = any(${ids}::text[]))`;
  }
  await db`delete from users where email like ${'%' + D}`;
  await db.end();
  if (process.env.E2E_ARTIFACTS) { fs.mkdirSync(process.env.E2E_ARTIFACTS, { recursive: true }); fs.copyFileSync(LOG, path.join(process.env.E2E_ARTIFACTS, 'server-process.log')); }
});

describe('the server process', () => {
  let nia: { token: string; id: string; ip: string };
  let guide: { token: string; id: string; ip: string };
  let plan: { id: string; chatId: string };

  it('boots like production: /health with the database, /meta, CORS for a browser, 404 JSON for unknown paths', async () => {
    expect((await call('GET', '/health')).json).toEqual({ ok: true, db: 'ok' });
    expect((await call('GET', '/meta')).json.allFree).toBe(false);
    const pre = await fetch(BASE + '/meta', { method: 'OPTIONS', headers: { origin: 'http://localhost:8081', 'access-control-request-method': 'GET' } });
    expect(pre.status).toBe(204);
    expect((await call('GET', '/nope')).status).toBe(404);
    expect(fs.readFileSync(LOG, 'utf8')).toContain(`api on :${PORT}`);
  });

  it('a new traveller signs in with the code from her email and onboards (under 18 refused)', async () => {
    const ip = '10.151.0.1';
    const t = await signInWithEmailedCode(`nia${D}`, ip);
    expect(t.isNew).toBe(true);
    expect((await call('PATCH', '/me', { token: t.accessToken, ip, body: { birthdate: '2012-01-01' } })).json.error).toBe('under_18');
    const me = await call('PATCH', '/me', { token: t.accessToken, ip, body: { name: 'Nia', birthdate: '1995-03-03', gender: 'woman', homeCountry: 'KE', interests: ['food', 'coffee'] } });
    expect(me.json.onboarded).toBe(true);
    expect((await call('POST', '/me/location', { token: t.accessToken, ip, body: { lat: 13.7466, lng: 100.5346 } })).status).toBe(200);
    nia = { token: t.accessToken, id: (await call('GET', '/me', { token: t.accessToken, ip })).json.id, ip };
    await call('POST', '/auth/email/start', { body: { email: `guide${D}` }, ip: '10.151.0.2' });
    expect(mails().some((m: any) => m.to === `guide${D}`)).toBe(false);   // a review account gets no email
    const g = await call('POST', '/auth/email/verify', { body: { email: `guide${D}`, code: '424242' }, ip: '10.151.0.2' });
    expect(g.status).toBe(200);
    const gp = await call('PATCH', '/me', { token: g.json.accessToken, ip: '10.151.0.2', body: { name: 'Gita', birthdate: '1990-07-07', gender: 'woman', homeCountry: 'IN' } });
    expect(gp.json.onboarded).toBe(true);
    guide = { token: g.json.accessToken, id: (await call('GET', '/me', { token: g.json.accessToken, ip: '10.151.0.2' })).json.id, ip: '10.151.0.2' };
    expect(guide.id).toMatch(/^[0-9a-f-]{36}$/);
    await call('POST', '/me/location', { token: guide.token, ip: guide.ip, body: { lat: 13.75, lng: 100.53 } });
  });

  it('she finds a plan near her on the map and joins it; the group chat opens', async () => {
    const r = await call('POST', '/activities', { token: guide.token, ip: guide.ip, body: { title: 'Proc e2e noodles', emoji: '🍜', category: 'food', placeName: 'Yaowarat Road', lat: 13.7398, lng: 100.51, startsAt: new Date(Date.now() + 5 * 3600_000).toISOString(), maxPeople: 4 } });
    expect(r.status).toBe(200);
    plan = { id: r.json.id, chatId: r.json.chatId };
    const near = await call('GET', '/activities?lat=13.7466&lng=100.5346', { token: nia.token, ip: nia.ip });
    const found = near.json.activities.find((a: any) => a.id === plan.id);
    expect(found).toMatchObject({ going: 1, joined: false, host: expect.objectContaining({ name: 'Gita' }) });
    expect((await call('POST', `/activities/${plan.id}/join`, { token: nia.token, ip: nia.ip })).json.chatId).toBe(plan.chatId);
    const chats = (await call('GET', '/chats', { token: nia.token, ip: nia.ip })).json.chats;
    expect(chats.map((c: any) => c.id)).toContain(plan.chatId);
  });

  it('messages, poll votes and typing arrive live over the socket; an abusive message is refused', async () => {
    const s = socket(nia.token);
    await s.ready;
    try {
      const sent = await call('POST', `/chats/${plan.chatId}/messages`, { token: guide.token, ip: guide.ip, body: { body: 'Meet at the gate at 7?' } });
      expect(sent.status).toBe(200);
      const live = await waitFor(() => s.events.find(e => e.event === 'message:new' && e.data?.id === sent.json.id), 'message:new on the socket');
      expect(live.data).toMatchObject({ chatId: plan.chatId, body: 'Meet at the gate at 7?' });
      const poll = await call('POST', `/chats/${plan.chatId}/polls`, { token: guide.token, ip: guide.ip, body: { question: 'Spicy?', options: ['yes', 'very'] } });
      expect(poll.status).toBe(200);
      await call('POST', `/chats/${plan.chatId}/polls/${poll.json.id}/vote`, { token: guide.token, ip: guide.ip, body: { option: 1 } });
      const upd = await waitFor(() => s.events.find(e => e.event === 'message:update' && e.data?.id === poll.json.id), 'poll update on the socket');
      expect(upd.data.poll.counts).toEqual([0, 1]);
      const abuse = await call('POST', `/chats/${plan.chatId}/messages`, { token: guide.token, ip: guide.ip, body: { body: 'QA-ABUSE you are an idiot' } });
      expect(abuse.status).toBe(400);
      expect(abuse.json.error).toBe('message_blocked');
      expect(fakeCalls).toContain('/openai/v1/moderations');
    } finally { s.close(); }
  });

  it('a socket with a bad token is refused', async () => {
    await expect(socket('not-a-token').ready).rejects.toThrow(/refused/);
  });

  it('she reports a message (gets a ticket ref by email) and blocks the host: the plan leaves her map', async () => {
    const msgs = (await call('GET', `/chats/${plan.chatId}/messages`, { token: nia.token, ip: nia.ip })).json.messages;
    const target = msgs.find((m: any) => m.body === 'Meet at the gate at 7?');
    const before = mails().length;
    const rep = await call('POST', '/reports', { token: nia.token, ip: nia.ip, body: { targetType: 'message', targetId: String(target.id), reason: 'spam', details: 'e2e' } });
    expect(rep.status, JSON.stringify(rep.json)).toBe(200);
    expect(rep.json.ref).toMatch(/^TM-/);
    await waitFor(() => mails().slice(before).find((m: any) => m.to === `nia${D}` && String(m.subject).includes(rep.json.ref)), 'report ticket email');
    const blocked = await call('POST', `/blocks/${guide.id}`, { token: nia.token, ip: nia.ip });
    expect(blocked.status, JSON.stringify(blocked.json)).toBe(200);
    const near = await call('GET', '/activities?lat=13.7466&lng=100.5346', { token: nia.token, ip: nia.ip });
    expect(near.json.activities.map((a: any) => a.id)).not.toContain(plan.id);
  });

  it('a free account hits the 2-plans-a-day limit with a 402 the app turns into a paywall', async () => {
    const mk = (title: string) => call('POST', '/activities', { token: nia.token, ip: nia.ip, body: { title, category: 'food', placeName: 'Lumpini Park', lat: 13.73, lng: 100.54, startsAt: new Date(Date.now() + 6 * 3600_000).toISOString() } });
    expect((await mk('Proc e2e one')).status).toBe(200);
    expect((await mk('Proc e2e two')).status).toBe(200);
    const third = await mk('Proc e2e three');
    expect(third.status).toBe(402);
    expect(third.json).toMatchObject({ error: 'plus_required', feature: expect.any(String) });
  });

  it('the per-IP sign-in limit holds on the real server (X-Forwarded-For from the local proxy)', async () => {
    const ip = '10.152.0.9';
    for (let i = 0; i < 5; i++) expect((await call('POST', '/auth/email/start', { body: { email: `limit${i}${D}` }, ip })).status).toBe(200);
    expect((await call('POST', '/auth/email/start', { body: { email: `limit5${D}` }, ip })).status).toBe(429);
    expect((await call('POST', '/auth/email/start', { body: { email: `limit5${D}` }, ip: '10.152.0.10' })).status).toBe(200);
  });

  it('she deletes her account: the session dies, her plans are cancelled, a goodbye email; signing in again starts fresh', async () => {
    const before = mails().length;
    expect((await call('DELETE', '/me', { token: nia.token, ip: nia.ip })).status).toBe(200);
    expect((await call('GET', '/me', { token: nia.token, ip: nia.ip })).status).toBe(401);
    await waitFor(() => mails().slice(before).find((m: any) => m.to === `nia${D}` && /deleted/i.test(m.subject)), 'deletion email');
    const again = await signInWithEmailedCode(`nia${D}`, '10.151.0.5');
    expect(again.isNew).toBe(true);
    expect((await call('GET', '/me', { token: again.accessToken, ip: '10.151.0.5' })).json.name ?? null).toBeNull();
  });

  it('stops on SIGTERM (PM2 reload) within 5 seconds', async () => {
    const t0 = Date.now();
    server.kill('SIGTERM');
    await new Promise(r => server.once('exit', r));
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(server.exitCode === 0 || server.signalCode === 'SIGTERM').toBe(true);
  });
});
