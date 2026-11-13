// The local API for the browser pass: the API on 127.0.0.1:4199 with src/scripts/e2e-preload.ts (every outside
// request goes to the fake below or is blocked; emails go to out/mail.jsonl). Local database only, never production.
import http from 'node:http'; import fs from 'node:fs'; import { spawn } from 'node:child_process';
import { DATABASE_URL } from './db.mjs';   // E2E_DATABASE_URL, a throwaway local test DB (required)
const API_DIR = new URL('../../api', import.meta.url).pathname;
const DIR = new URL('./out/', import.meta.url).pathname; fs.mkdirSync(DIR, { recursive: true });
const MAIL = DIR + 'mail.jsonl'; fs.writeFileSync(MAIL, '');
const SA = DIR + 'sa.json'; fs.writeFileSync(SA, JSON.stringify({ project_id: 'tablamigo-qa', client_email: 'qa@tablamigo-qa.iam.gserviceaccount.com' }));
const log = (...a) => fs.appendFileSync(DIR + 'fake.log', a.join(' ') + '\n');
const fake = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString(); let body = {}; try { body = raw ? JSON.parse(raw) : {}; } catch {}
  const u = new URL(req.url, 'http://f'); log(req.method, u.pathname + u.search);
  const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (u.pathname === '/openai/v1/moderations') { const f = String(body.input ?? '').includes('QA-ABUSE'); return send({ results: [{ flagged: f, categories: { harassment: f } }] }); }
  if (u.pathname === '/openai/v1/chat/completions') {
    const txt = JSON.stringify(body.messages ?? '');
    const ideas = /Pathankot/i.test(txt) ? [
      { emoji: '🏰', title: 'Walk around Shahpurkandi Fort', category: 'explore', placeName: 'Shahpurkandi Fort', why: 'River views at sunset' },
      { emoji: '🍛', title: 'Dhaba dinner on the highway', category: 'food', placeName: 'Punjabi Dhaba Pathankot', why: 'Best dal makhani around' },
      { emoji: '☕', title: 'Coffee and cards', category: 'food', placeName: 'QA Unknown Cafe', why: 'Cosy' },
    ] : [
      { emoji: '🍜', title: 'Street food crawl on Yaowarat', category: 'food', placeName: 'Yaowarat Road', why: 'Chinatown after dark' },
      { emoji: '🌅', title: 'Sunset at Wat Arun', category: 'explore', placeName: 'Wat Arun', why: 'River view' },
    ];
    return send({ choices: [{ message: { content: JSON.stringify({ ideas }) } }] });
  }
  if (u.pathname === '/photon/api/') {
    const q = u.searchParams.get('q') ?? '', lat = Number(u.searchParams.get('lat')), lon = Number(u.searchParams.get('lon'));
    if (/Unknown/.test(q) || !Number.isFinite(lat)) return send({ type: 'FeatureCollection', features: [] });
    let h = 0; for (const ch of q) h = (h * 31 + ch.charCodeAt(0)) % 1000;
    return send({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lon + (h % 40 - 20) / 1000, lat + (h % 30 - 15) / 1000] }, properties: { name: q, city: 'X', country: 'X' } }] });
  }
  if (u.pathname === '/nominatim/reverse') {
    const lat = Number(u.searchParams.get('lat')), lng = Number(u.searchParams.get('lon'));
    const a = lat > 10 && lat < 20 ? { city: 'Bangkok', country_code: 'th' } : lat > 30 && lat < 35 && lng > 74 && lng < 77 ? { city: 'Pathankot', country_code: 'in' } : { city: 'Lisbon', country_code: 'pt' };
    return send({ address: a });
  }
  if (u.pathname.startsWith('/razorpay/')) return send({ error: { description: 'qa: razorpay not faked' } }, 400);
  if (u.pathname === '/google') return send({ name: 'x' });
  if (u.pathname === '/webpush') return send({});
  send({ error: 'unknown' }, 404);
});
await new Promise(r => fake.listen(0, '127.0.0.1', r));
const FAKE = `http://127.0.0.1:${fake.address().port}`;
const env = { ...process.env, NODE_ENV: 'development', PORT: '4199', PUBLIC_URL: 'http://127.0.0.1:4199', SITE_URL: 'http://127.0.0.1:8099',
  DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv', JWT_SECRET: 'dev-only-secret-change-me', RESEND_API_KEY: '', EMAIL_JOBS: 'off', SCHEDULER: 'off',
  REVIEW_EMAILS: ['new', 'next', 'leave', 'bkk', 'empty', 'woman', 'plus', 'free1', 'free2', 'banned', 'admin', 'host', 'nogeo'].map(k => k + '@qa.test').join(','), REVIEW_CODE: '424242',
  ADMIN_EMAILS: 'admin@qa.test', OPENAI_API_KEY: 'sk-qa-fake', RAZORPAY_KEY_ID: 'rzp_test_qa', RAZORPAY_KEY_SECRET: 'qa-secret', RAZORPAY_PLAN_MONTHLY: 'plan_qa_m', RAZORPAY_PLAN_YEARLY: 'plan_qa_y', RAZORPAY_PLAN_HALFYEARLY: 'plan_qa_h', PLAY_SERVICE_ACCOUNT_JSON: '', FIREBASE_SERVICE_ACCOUNT_JSON: '',
  WEBPUSH_PUBLIC_KEY: '', WEBPUSH_PRIVATE_KEY: '', R2_ACCOUNT_ID: '', R2_ACCESS_KEY: '', R2_BUCKET: '', MAIL_CAPTURE_FILE: MAIL, E2E_FAKE_URL: FAKE,
  // The scenarios cover the paid tiers; the allFree scenario in drive.mjs adds allFree: true to /meta and /me in the browser.
  ALL_FREE: 'false',
  // The reviewCard scenario needs the rating ask, which is off by default in production (REVIEW_ASK).
  REVIEW_ASK: 'on' };
const api = spawn(process.execPath, ['--import', 'tsx', '--import', './src/scripts/e2e-preload.ts', 'src/main.ts'], { cwd: API_DIR, env, stdio: ['ignore', 'inherit', 'inherit'] });
api.on('exit', c => { console.log('api exited', c); process.exit(1); });
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { api.kill(); process.exit(0); });
console.log('fake on', FAKE);
