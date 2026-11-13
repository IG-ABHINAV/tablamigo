// Seeds the browser-pass personas (<name>@qa.test, fixed review code) through the local API and writes their ids to
// out/tokens.json. Also runs the API's demo seed first (Bangkok and Lisbon plans, @demo.tablamigo accounts).
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const API = 'http://127.0.0.1:4199';
// The database: E2E_DATABASE_URL, a throwaway local test database (db.mjs refuses anything else).
import { DATABASE_URL, psql } from './db.mjs';
execFileSync('npm', ['run', 'seed', '--silent'], { cwd: new URL('../../api', import.meta.url).pathname, stdio: 'ignore', env: { ...process.env, DATABASE_URL, DOTENV_CONFIG_PATH: '/nonexistent/tablamigo-tests-never-load-dotenv' } });
let ipn = 0;
async function call(method, p, { token, body, ip }) {
  const h = { 'x-forwarded-for': ip }; if (token) h.authorization = `Bearer ${token}`; if (body) h['content-type'] = 'application/json';
  const r = await fetch(API + p, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${JSON.stringify(j)}`); return j;
}
psql(`delete from messages where sender_id in (select id from users where email like '%@qa.test'); delete from users where email like '%@qa.test'; delete from otp_codes where email like '%@qa.test'`);
const BKK = { lat: 13.7466, lng: 100.5346 }, PTK = { lat: 32.32, lng: 75.60 };
// Profile photos must be the account's own upload since 13 Oct (7742068: PATCH /me refuses any other URL with bad_photo),
// so each persona uploads the test face first; a dicebear URL here made the seed, and so the whole browser pass, fail.
const FACE = fs.readFileSync(new URL('../../api/src/test-fixtures/faces/profile.jpg', import.meta.url));
async function upload(token, ip) {
  const r = await fetch(API + '/uploads/image/direct?kind=avatar', { method: 'POST', headers: { 'x-forwarded-for': ip, authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' }, body: FACE });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`upload: ${r.status} ${JSON.stringify(j)}`); return j.publicUrl;
}
const P = {
  bkk: { name: 'Rahul', gender: 'man', homeCountry: 'IN', at: BKK }, host: { name: 'Hana', gender: 'woman', homeCountry: 'JP', at: BKK },
  empty: { name: 'Pawan', gender: 'man', homeCountry: 'IN', at: PTK }, woman: { name: 'Wendy', gender: 'woman', homeCountry: 'GB', at: BKK },
  plus: { name: 'Priti', gender: 'woman', homeCountry: 'IN', at: BKK }, free1: { name: 'Farid', gender: 'man', homeCountry: 'AE', at: BKK },
  free2: { name: 'Greta', gender: 'woman', homeCountry: 'DE', at: BKK }, banned: { name: 'Boris', gender: 'man', homeCountry: 'RU', at: BKK },
  // Never shares a location (drive.mjs noLocation).
  nogeo: { name: 'Nil', gender: 'woman', homeCountry: 'TR', at: null },
};
const T = {};
for (const [k, p] of Object.entries(P)) {
  const ip = `10.${60 + Math.floor(Math.random() * 30)}.${Math.floor(Math.random() * 250)}.${++ipn}`, email = `${k}@qa.test`;
  await call('POST', '/auth/email/start', { body: { email }, ip });
  const t = await call('POST', '/auth/email/verify', { body: { email, code: '424242' }, ip });
  await call('PATCH', '/me', { token: t.accessToken, ip, body: { name: p.name, birthdate: '1994-05-06', gender: p.gender, homeCountry: p.homeCountry, interests: ['food', 'coffee', 'hiking'], languages: ['English', 'Hindi'], photoUrl: await upload(t.accessToken, ip), bio: `QA persona ${k}` } });
  if (p.at) await call('POST', '/me/location', { token: t.accessToken, ip, body: p.at });
  const me = await call('GET', '/me', { token: t.accessToken, ip });
  T[k] = { ...t, id: me.id, ip, email };
}
// Host: a normal plan and a women-only plan in Bangkok, soon.
const soon = h => new Date(Date.now() + h * 3600_000).toISOString();
const plan = await call('POST', '/activities', { token: T.host.accessToken, ip: T.host.ip, body: { title: 'QA noodle night', emoji: '🍜', category: 'food', placeName: 'Yaowarat Road', lat: 13.7398, lng: 100.51, startsAt: soon(5), maxPeople: 6 } });
const wo = await call('POST', '/activities', { token: T.host.accessToken, ip: T.host.ip, body: { title: 'QA women-only yoga', emoji: '🧘', category: 'sports', placeName: 'Lumpini Park', lat: 13.7310, lng: 100.5410, startsAt: soon(20), maxPeople: 5, womenOnly: true } });
await call('POST', `/activities/${plan.id}/join`, { token: T.woman.accessToken, ip: T.woman.ip });
// Four people in Lisbon next week, so a free account adding a Lisbon trip gets the Trip Pass prompt.
const day = n => { const d = new Date(Date.now() + n * 86400_000); return d.toISOString().slice(0, 10); };
for (const k of ['host', 'woman', 'plus', 'free2', 'free1']) {
  const trip = await call('POST', '/trips', { token: T[k].accessToken, ip: T[k].ip, body: { city: 'Lisbon', countryCode: 'PT', lat: 38.711, lng: -9.14, startDate: day(6), endDate: day(14) } });
  if (k === 'host') T.hostTrip = trip.id ?? trip.trip?.id;
}
// One moment by the host (a photo uploaded the way the app does), for the feed's and the moment page's layout checks.
{
  const r = await fetch(API + '/uploads/image/direct?kind=chat', { method: 'POST', headers: { 'x-forwarded-for': T.host.ip, authorization: `Bearer ${T.host.accessToken}`, 'content-type': 'image/jpeg' }, body: FACE });
  const up = await r.json(); if (!r.ok) throw new Error(`moment photo: ${r.status} ${JSON.stringify(up)}`);
  T.moment = (await call('POST', '/moments', { token: T.host.accessToken, ip: T.host.ip, body: { imageUrl: up.publicUrl, caption: 'QA seeded moment', city: 'Bangkok', countryCode: 'TH' } })).id;
}
// A plan hosted by bkk, so he can close/reopen/cancel it.
const own = await call('POST', '/activities', { token: T.bkk.accessToken, ip: T.bkk.ip, body: { title: 'QA rooftop beers', emoji: '🍻', category: 'drinks', placeName: 'Octave Rooftop', lat: 13.7236, lng: 100.581, startsAt: soon(8), maxPeople: 8 } });
T.ownPlan = own.id;
// Plus persona: 30 days of comp; banned persona: banned after its session was issued.
psql(`update users set plus_until = now() + interval '30 days', comp_until = now() + interval '30 days' where email = 'plus@qa.test'`);
psql(`update users set banned_at = now() where email = 'banned@qa.test'`);
fs.writeFileSync(new URL('./out/tokens.json', import.meta.url), JSON.stringify({ ...T, plan: plan.id, womenPlan: wo.id, planChat: plan.chatId }, null, 1));
console.log('seeded', Object.keys(T).join(' '), 'plan', plan.id, 'women', wo.id);
