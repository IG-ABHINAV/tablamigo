// The escalation ladder in the real server process (src/main.ts with its scheduler, ticking every second here): a person links
// Telegram through the bot's webhook over HTTP, has opted out of activity emails, and leaves a DM unread past its delay; the
// server's own scheduler escalates it to Telegram (the Bot API is the fake below, via src/scripts/e2e-preload.ts), once.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { signAccess } from '../../lib/auth.js';

const API_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const D = '@ladder-e2e.tablamigo';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tablamigo-ladder-e2e-'));
const MAIL = path.join(TMP, 'mail.jsonl');
const LOG = path.join(TMP, 'server.log');
fs.writeFileSync(MAIL, '');
const SECRET = 'e2e-telegram-secret';

let server: ChildProcess;
let fake: http.Server;
let BASE = '';
const telegram: { path: string; body: any }[] = [];
let db: any;
const id: Record<string, string> = {};

const freePort = () => new Promise<number>(res => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
const waitFor = async (ok: () => Promise<boolean>, what: string, ms = 30_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return; await new Promise(r => setTimeout(r, 250)); }
  throw new Error(`timed out waiting for ${what}; server log:\n${fs.readFileSync(LOG, 'utf8').slice(-3000)}`);
};

// A city where it is daytime now (the ladder never writes at night), so the run doesn't depend on the hour it starts.
const CITIES = [
  { zone: 'Pacific/Kiritimati', lat: 1.87, lng: -157.4 }, { zone: 'Pacific/Auckland', lat: -36.85, lng: 174.76 },
  { zone: 'Asia/Tokyo', lat: 35.68, lng: 139.69 }, { zone: 'Asia/Kolkata', lat: 19.08, lng: 72.88 },
  { zone: 'Europe/London', lat: 51.51, lng: -0.13 }, { zone: 'America/New_York', lat: 40.71, lng: -74.0 },
  { zone: 'Pacific/Honolulu', lat: 21.31, lng: -157.86 },
];
const hourIn = (zone: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
const day = CITIES.find(c => hourIn(c.zone) >= 10 && hourIn(c.zone) < 20)!;

beforeAll(async () => {
  fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname.startsWith('/telegram/')) { telegram.push({ path: u.pathname, body: JSON.parse(raw || '{}') }); res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  const port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  const pg = await import('postgres');
  db = pg.default(process.env.DATABASE_URL!, { max: 2, transform: pg.default.camel });
  await db`delete from chats where kind = 'dm' and dm_key like '%ladder-e2e%'`;
  await db`delete from users where email like ${'%' + D}`;
  for (const [tag, prefs] of [['to', { activity: false }], ['from', {}]] as const) {
    const [u] = await db`insert into users (email, name, birthdate, gender, home_country, onboarded, email_prefs, location, location_at)
      values (${tag + D}, ${tag === 'to' ? 'Mira' : 'Kofi'}, '1994-02-02', 'woman', 'GB', true, ${db.json(prefs)},
        ST_SetSRID(ST_MakePoint(${day.lng}, ${day.lat}), 4326)::geography, now()) returning id`;
    id[tag] = u.id;
  }
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'development', PORT: String(port), PUBLIC_URL: BASE,
    DATABASE_URL: process.env.DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv',
    JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', ALL_FREE: 'false',
    SCHEDULER: 'on', SCHEDULER_INTERVAL_MS: '1000', EMAIL_LADDER: 'on',
    HOST_WELCOME: 'off', STARTER_PLANS: 'off', TRIP_MATCH: 'off', PLUS_WELCOME: 'off', CITY_NUDGE: 'off', ENGAGEMENT: 'off',
    TELEGRAM_BOT_TOKEN: 'e2e-bot-token', TELEGRAM_BOT_USERNAME: 'tablamigo_e2e_bot', TELEGRAM_WEBHOOK_SECRET: SECRET,
    MAIL_CAPTURE_FILE: MAIL, E2E_FAKE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
  };
  const out = fs.openSync(LOG, 'a');
  server = spawn(process.execPath, ['--import', 'tsx', '--import', './src/scripts/e2e-preload.ts', 'src/main.ts'], { cwd: API_DIR, env: env as any, stdio: ['ignore', out, out] });
  await waitFor(async () => (await fetch(BASE + '/health').then(r => r.ok).catch(() => false)), 'server /health', 60_000);
});

afterAll(async () => {
  if (server && server.exitCode === null && server.signalCode === null) { server.kill('SIGTERM'); await new Promise(r => server.once('exit', r)); }
  fake?.close();
  await db`delete from chats where kind = 'dm' and dm_key like ${'%' + (id.to ?? 'none') + '%'}`;
  await db`delete from users where email like ${'%' + D}`;
  await db.end();
});

describe('escalation in the server process', () => {
  it('links Telegram through the bot webhook, then escalates an unread DM there (email opted out), once', async () => {
    const auth = { authorization: `Bearer ${signAccess(id.to)}` };
    const link = await (await fetch(BASE + '/me/telegram-link', { headers: auth })).json();
    expect(link.url).toMatch(/^https:\/\/t\.me\/tablamigo_e2e_bot\?start=[0-9a-f]{32}_[A-Za-z0-9_-]{20}$/);
    const start = new URL(link.url).searchParams.get('start')!;
    const update = { update_id: 1, message: { message_id: 1, chat: { id: 777001, type: 'private' }, text: `/start ${start}` } };
    const post = (secret: string) => fetch(BASE + '/telegram/webhook', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(update) });
    expect((await post('wrong')).status).toBe(401);
    expect(await (await post(SECRET)).json()).toEqual({ ok: true, result: 'linked' });
    expect((await db`select telegram_chat_id from users where id = ${id.to}`)[0].telegramChatId).toBe('777001');

    // Kofi's DM to Mira, two hours ago and unread (the DM delay is 60 minutes; Mira has no push token).
    const [c] = await db`insert into chats (kind, dm_key, last_message_at) values ('dm', ${[id.to, id.from].sort().join(':')}, now()) returning id`;
    await db`insert into chat_members (chat_id, user_id, request_status) values (${c.id}, ${id.to}, 'accepted'), (${c.id}, ${id.from}, 'accepted')`;
    await db`insert into messages (chat_id, sender_id, body, created_at) values (${c.id}, ${id.from}, 'are you free tonight?', now() - interval '2 hours')`;

    await waitFor(async () => telegram.some(t => t.path.endsWith('/sendMessage')), 'the Telegram message');
    // The fake answers before the server records the outcome: wait for that too.
    await waitFor(async () => (await db`select 1 from notification_log where user_id = ${id.to} and kind = 'dm' and channel = 'telegram' and status = 'sent'`).length > 0, 'the logged send');
    const sent = telegram.filter(t => t.path === '/telegram/bote2e-bot-token/sendMessage');
    expect(sent).toHaveLength(1);
    expect(sent[0].body.chat_id).toBe(777001);
    expect(sent[0].body.text).toContain('New message from Kofi');
    expect(sent[0].body.text).not.toContain('free tonight');            // never the message itself
    const log = await db`select channel, status, reason from notification_log where user_id = ${id.to} and kind = 'dm' order by channel`;
    expect(log.find((l: any) => l.channel === 'email')).toMatchObject({ status: 'skipped', reason: 'opted_out' });
    expect(log.find((l: any) => l.channel === 'telegram')).toMatchObject({ status: 'sent' });
    // Several more ticks: still one message, and no email went out.
    await new Promise(r => setTimeout(r, 3500));
    expect(telegram.filter(t => t.path.endsWith('/sendMessage'))).toHaveLength(1);
    expect(fs.readFileSync(MAIL, 'utf8').includes('to' + D)).toBe(false);
  });
});
