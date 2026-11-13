// Browser pass over the web app (local export on :8099/app, local API on :4199) in real headless Chrome, one
// scenario per persona, at 1440x900 and 390x844. Records every console.error, pageerror, failed request and
// error-boundary or blank screen. Start it with ./run.sh; directly:  node drive.mjs [desktop|mobile|both] [scenario,...]
// Playwright comes from PLAYWRIGHT_FROM (a folder with node_modules/playwright), default ~/Desktop/hookpost.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const require = createRequire((process.env.PLAYWRIGHT_FROM ?? process.env.HOME + '/Desktop/hookpost') + '/package.json');
const { chromium } = require('playwright');

const DIR = new URL('./out/', import.meta.url).pathname;
const APP = 'http://127.0.0.1:8099/app';
const API = 'http://127.0.0.1:4199';
const FIX = new URL('../../api/src/test-fixtures/faces/', import.meta.url).pathname;
const SHOTS = DIR + 'shots/'; fs.mkdirSync(SHOTS, { recursive: true });
import { psql } from './db.mjs';   // E2E_DATABASE_URL, a throwaway local test DB (required)
const sleep = ms => new Promise(r => setTimeout(r, ms));
const argSizes = process.argv[2] ?? 'both';
const only = process.argv[3]?.split(',');
const SIZES = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
const BKK = { latitude: 13.7466, longitude: 100.5346 }, PTK = { latitude: 32.32, longitude: 75.60 };

// Served in place of https://accounts.google.com/gsi/client: initialize, renderButton, prompt and cancel, as the app calls them.
const GIS_STUB = `window.google = window.google || {};
window.google.accounts = { id: {
  initialize: function () {},
  renderButton: function (el) { var b = document.createElement('div'); b.setAttribute('role', 'button'); b.setAttribute('data-gis-stub', '1'); b.textContent = 'Continue with Google'; el.appendChild(b); },
  prompt: function () {}, cancel: function () {}, disableAutoSelect: function () {},
} };`;

const results = []; // { size, persona, flow, ok, note }
const issues = [];  // { size, persona, kind, text }
let ipn = 0;

async function login(email) {
  psql(`delete from otp_codes where email = '${email}'`);
  const ip = `10.${100 + Math.floor(Math.random() * 100)}.${Math.floor(Math.random() * 250)}.${++ipn % 250 + 1}`;
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  await fetch(API + '/auth/email/start', { method: 'POST', headers: h, body: JSON.stringify({ email }) });
  const r = await fetch(API + '/auth/email/verify', { method: 'POST', headers: h, body: JSON.stringify({ email, code: '424242' }) });
  const j = await r.json(); if (!r.ok) throw new Error('login ' + email + ' ' + JSON.stringify(j));
  return { tokens: { accessToken: j.accessToken, refreshToken: j.refreshToken }, ip };
}

async function open(browser, size, persona, { email, tokens: given, ua, geo = BKK, mobile = size === 'mobile' } = {}) {
  // geo: null is a browser that never gives a location (the person said no).
  const ctx = await browser.newContext({
    viewport: SIZES[size], deviceScaleFactor: 1, ...(geo ? { geolocation: geo } : {}), permissions: [...(geo ? ['geolocation'] : []), 'clipboard-read', 'clipboard-write', 'camera'],
    serviceWorkers: process.env.SW ? 'allow' : 'block', hasTouch: mobile, isMobile: mobile, locale: 'en-GB', timezoneId: 'Asia/Kolkata',
    ...(ua ? { userAgent: ua } : {}),
  });
  const ip = `10.${100 + Math.floor(Math.random() * 100)}.${Math.floor(Math.random() * 250)}.${++ipn % 250 + 1}`;
  // Own rate-limit bucket per context (the API trusts X-Forwarded-For); fake place search in the browser.
  await ctx.route(API + '/**', r => r.continue({ headers: { ...r.request().headers(), 'x-forwarded-for': ip } }));
  await ctx.route('https://photon.komoot.io/**', r => {
    const u = new URL(r.request().url()); const q = u.searchParams.get('q') ?? '';
    const cities = u.searchParams.getAll('osm_tag').length > 0;
    const f = cities
      ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-9.14, 38.711] }, properties: { name: 'Lisbon', countrycode: 'PT', country: 'Portugal' } }]
      : [{ type: 'Feature', geometry: { type: 'Point', coordinates: [100.52, 13.74] }, properties: { name: q + ' Place', street: 'Test Road', city: 'Bangkok', country: 'Thailand' } }];
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: f }) });
  });
  // Google sign-in never leaves the machine. The real GIS client (GoogleButton.web.tsx) talks to accounts.google.com and,
  // with use_fedcm_for_prompt, makes Chrome log FedCM errors ("Error retrieving a token.") that vary with Google's side,
  // which made the run's exit code flaky. The stub below has the calls the app makes and draws a stand-in button.
  await ctx.route('https://accounts.google.com/**', r => new URL(r.request().url()).pathname === '/gsi/client'
    ? r.fulfill({ contentType: 'text/javascript', body: GIS_STUB })
    : r.abort('aborted'));
  if (email || given) {
    const tokens = given ?? (await login(email)).tokens;
    await ctx.addInitScript(t => { if (!sessionStorage.getItem('qa')) { sessionStorage.setItem('qa', '1'); localStorage.setItem('tablamigo.tokens', t); } }, JSON.stringify(tokens));
  }
  const page = await ctx.newPage();
  const tag = (kind, text) => issues.push({ size, persona, kind, text: String(text).slice(0, 400), url: page.url().replace(APP, '') });
  page.on('console', m => { if (m.type() === 'error') tag('console.error', m.text()); if (m.type() === 'warning' && /Warning:|deprecated/i.test(m.text())) tag('console.warn', m.text()); });
  page.on('pageerror', e => tag('pageerror', e.stack || e.message));
  page.on('requestfailed', r => { const u = r.url(); if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? '') || u.startsWith(API)) tag('requestfailed', `${r.method()} ${u} ${r.failure()?.errorText}`); });
  page.on('response', r => { if (r.status() >= 400) tag(r.status() >= 500 ? 'http5xx' : 'http4xx', `${r.status()} ${r.request().method()} ${r.url()}`); });
  page.on('dialog', d => { tag('dialog', `${d.type()}: ${d.message().slice(0, 80)}`); d.accept().catch(() => {}); });
  return { ctx, page, size, persona };
}

async function crashCheck(page) {
  const body = await page.locator('body').innerText().catch(() => '');
  if (/Something went wrong/.test(body)) throw new Error('error boundary shown');
  const root = await page.evaluate(() => ((document.getElementById('root') ?? document.body)?.innerText ?? '').trim().length).catch(() => 0);
  if (!root) throw new Error('blank page (empty #root)');
}

async function step(s, flow, fn) {
  const t0 = Date.now();
  try {
    await fn();
    await sleep(300);
    await crashCheck(s.page);
    results.push({ size: s.size, persona: s.persona, flow, ok: true, note: `${Date.now() - t0}ms` });
  } catch (e) {
    const f = `${s.size}-${s.persona}-${flow}`.replace(/[^a-z0-9-]+/gi, '_');
    await s.page.screenshot({ path: SHOTS + f + '.png' }).catch(() => {});
    results.push({ size: s.size, persona: s.persona, flow, ok: false, note: String(e.message).split('\n')[0].slice(0, 200) });
  }
}
const go = (page, path) => page.goto(APP + path, { waitUntil: 'domcontentloaded' });
// Not inside #splash: the static first paint copies the welcome screen's text.
const app = page => page.locator('#root, body > div:not(#splash)');
const see = (page, text, timeout = 10000) => app(page).getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
const tap = async (page, text, opts = {}) => { const l = app(page).getByText(text, { exact: opts.exact ?? false }).filter({ visible: true }).last(); await l.waitFor({ state: 'visible', timeout: opts.timeout ?? 10000 }); await l.click(); };
const role = (page, r, name) => page.getByRole(r, { name }).first();
async function longPress(page, loc) {
  const b = await loc.boundingBox(); if (!b) throw new Error('no box for long press');
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await page.mouse.down(); await sleep(700); await page.mouse.up();
}
/** The text's element lies fully inside the viewport (not cut off by a sheet's max height or the screen's bottom). */
async function onScreen(page, text) {
  // Sheets slide up: allow the animation to finish, then the element must be fully inside the viewport.
  const vh = page.viewportSize().height; let b = null;
  for (let i = 0; i < 20; i++) {
    b = await app(page).getByText(text, { exact: true }).filter({ visible: true }).last().boundingBox();
    if (b && b.y >= 0 && b.y + b.height <= vh) return;
    await sleep(150);
  }
  throw new Error(`"${text}" is off screen (${b ? Math.round(b.y) + '+' + Math.round(b.height) : 'no box'} of ${vh})`);
}
async function typeInto(page, placeholder, text) { const l = page.getByPlaceholder(placeholder).first(); await l.waitFor({ timeout: 10000 }); await l.click(); await l.fill(text); }

// ---------------------------------------------------------------------------------------------------------------
const SCEN = {};

SCEN.welcome = async (browser, size) => {
  const s = await open(browser, size, 'anon');
  await step(s, 'welcome renders', async () => { await go(s.page, '/'); await see(s.page, 'Never eat alone'); await see(s.page, 'Use email instead'); await see(s.page, 'Surf on Saturday', 5000);
    // The (stubbed) Google client loaded and drew its button, i.e. the path production takes, not the offline look-alike.
    await s.page.locator('[data-gis-stub]').filter({ visible: true }).first().waitFor({ state: 'visible', timeout: 10000 }); });
  await step(s, '/welcome direct', async () => { await go(s.page, '/welcome'); await see(s.page, 'Never eat alone'); });
  await step(s, 'deep link while signed out -> welcome', async () => { await go(s.page, '/activity/00000000-0000-4000-8000-000000000000'); await see(s.page, 'Never eat alone'); });
  await step(s, 'email screen validation', async () => { await tap(s.page, 'Use email instead'); await see(s.page, "What's your email?"); await typeInto(s.page, 'you@example.com', 'not-an-email'); if (await role(s.page, 'button', 'Send code').isEnabled().catch(() => true)) { /* RN web renders disabled via aria-disabled */ } });
  await s.ctx.close();
};

// Click something that opens a file picker and give it a file. The wait and the click settle together (Promise.all), so a
// click that fails (wrong screen) fails this step only: a bare waitForEvent left pending rejected 10 s later as an unhandled
// rejection and killed the whole pass (nightly 1 Nov 2026, after onboarding grew to 8 steps).
const chooseFile = async (p, click, file) => {
  const [fc] = await Promise.all([p.waitForEvent('filechooser', { timeout: 10000 }), click()]);
  await fc.setFiles(file);
};

// Leaving the "what now" screen shows the soft Plus screen once per account (/paywall?intro=1, #72): see it, say "Not now",
// land on the map. A second visit goes straight to the map.
const pastPlusIntro = async p => {
  await see(p, /plans nearby|Want more from every trip/, 25000);
  if (await app(p).getByText('Want more from every trip', { exact: false }).first().isVisible().catch(() => false)) await tap(p, 'Not now', { exact: true });
  await see(p, 'plans nearby', 25000);
};

SCEN.newUser = async (browser, size) => {
  psql(`delete from users where email = 'new@qa.test'`); psql(`delete from otp_codes where email = 'new@qa.test'`);
  const s = await open(browser, size, 'new');
  const p = s.page;
  await step(s, 'sign in with email code', async () => {
    await go(p, '/'); await tap(p, 'Use email instead');
    await typeInto(p, 'you@example.com', 'new@qa.test'); await tap(p, 'Send code');
    await see(p, 'Check your email');
    await p.keyboard.type('111111'); await see(p, 'That code is not right');
    await p.keyboard.type('424242'); await see(p, 'What should travelers call you?', 15000);
  });
  await step(s, 'onboarding: name + languages', async () => {
    await typeInto(p, 'First name', 'Nina'); await tap(p, 'Spanish', { exact: true }); await tap(p, 'Continue'); await see(p, "When's your birthday?"); await see(p, 'Step 2 of 8');
  });
  await step(s, 'onboarding: back keeps the name', async () => {
    await role(p, 'button', 'Back').click().catch(async () => { await p.getByLabel('Back').click(); });
    await see(p, 'What should travelers call you?');
    if (await p.getByPlaceholder('First name').inputValue() !== 'Nina') throw new Error('name lost after Back');
    await tap(p, 'Continue');
  });
  await step(s, 'onboarding: under-18 refused, then valid birthday', async () => {
    const y = new Date().getFullYear() - 16;
    await typeInto(p, 'DD', '05'); await typeInto(p, 'MM', '06'); await typeInto(p, 'YYYY', String(y));
    // Under 18: Continue is disabled (aria-disabled since the 1 Nov QA fixes, so a normal click waits 30 s for it) and the
    // screen says why. A forced click must change nothing.
    await see(p, /18 or older/);
    await app(p).getByText('Continue', { exact: true }).last().click({ force: true, timeout: 3000 }).catch(() => {});
    await sleep(300); await see(p, "When's your birthday?");
    await typeInto(p, 'YYYY', '1995'); await tap(p, 'Continue'); await see(p, 'How do you identify?');
  });
  await step(s, 'onboarding: gender', async () => { await tap(p, 'Woman', { exact: true }); await tap(p, 'Continue'); await see(p, 'Where are you from?'); });
  await step(s, 'onboarding: country search', async () => { await typeInto(p, 'Search countries', 'Ind'); await tap(p, 'India', { exact: true }); await tap(p, 'Continue'); await see(p, 'Add a photo'); });
  await step(s, 'onboarding: photo upload', async () => {
    await chooseFile(p, () => p.getByText('+', { exact: true }).last().click(), FIX + 'profile.jpg');
    await see(p, 'Continue', 15000); // button text switches from "Skip for now"
    await p.getByText('Continue', { exact: true }).last().click(); await see(p, 'What are you into?');
  });
  await step(s, 'onboarding: interests (3 needed)', async () => {
    await p.waitForTimeout(800);
    const chips = p.locator('[role="button"]').filter({ hasText: /\S/ });
    const labels = ['Food', 'Coffee', 'Hiking', 'Nightlife', 'Museums'];
    let n = 0; for (const l of labels) { const c = p.getByText(new RegExp(l, 'i')).first(); if (await c.isVisible().catch(() => false)) { await c.click(); n++; } if (n >= 3) break; }
    if (n < 3) throw new Error('could not find 3 interest chips; count=' + (await chips.count()));
    await tap(p, 'Continue'); await see(p, 'How did you hear about us?');
  });
  await step(s, 'onboarding: how did you hear about us (one tap, saved)', async () => {
    await tap(p, 'Instagram', { exact: true }); await see(p, 'See plans around you');
    for (let i = 0; i < 20 && psql(`select heard_from from users where email = 'new@qa.test'`) !== 'instagram'; i++) await sleep(250);
    const got = psql(`select heard_from from users where email = 'new@qa.test'`);
    if (got !== 'instagram') throw new Error('heard_from not saved: ' + got);
  });
  // Onboarding ends on the "what now" screen (app/start.tsx); SCEN.nextStep covers it.
  await step(s, 'onboarding: location -> what now -> map', async () => {
    await tap(p, 'Enable location'); await see(p, "You're in, Nina.", 25000); await tap(p, 'Take me to Explore'); await pastPlusIntro(p);
  });
  await step(s, 'verification selfie (fixture upload)', async () => {
    await go(p, '/verify'); await see(p, 'Get verified');
    await sleep(500);
    if (size === 'mobile') {
      await chooseFile(p, () => tap(p, 'Take selfie'), FIX + 'same-person-turned.jpg');
    } else {
      await tap(p, 'Take selfie');
      await see(p, 'Take photo', 10000); await sleep(1200); await tap(p, 'Take photo', { exact: true });
    }
    await p.getByText(/Checking your selfie|You're verified|didn't pass|doesn't|couldn't|tries left/i).first().waitFor({ timeout: 20000 });
    await sleep(6000);
    const txt = await p.locator('body').innerText();
    if (/Couldn't upload/.test(txt)) throw new Error('upload failed');
  });
  await step(s, 'profile edit: bio, interests, languages', async () => {
    await go(p, '/profile'); await see(p, 'About you');
    await tap(p, 'Edit', { exact: true });
    await typeInto(p, 'A line about how you travel', 'Slow traveller, big on street food.');
    await tap(p, 'French', { exact: true });
    await tap(p, 'Save', { exact: true }); await see(p, 'Slow traveller, big on street food.');
    await see(p, 'French');
  });
  await step(s, 'snooze on and undo', async () => {
    await p.locator('input[type="checkbox"], [role="switch"]').first().click();
    await tap(p, '24 hours'); await see(p, "You're snoozed until"); await tap(p, 'Undo', { exact: true });
    await p.getByText("You're snoozed until").waitFor({ state: 'detached', timeout: 8000 });
  });
  await step(s, 'safety tips alert', async () => { await tap(p, 'Safety tips'); });
  await step(s, 'delete account', async () => {
    const before = Number(psql(`select count(*) from account_deletion_reasons where reason = 'no_one_near'`));
    // Profile row, then 2 taps: Delete anyway, Delete my account (the reason is optional).
    await tap(p, 'Delete account'); await see(p, 'Why are you leaving?'); await tap(p, 'No one near me'); await tap(p, 'Delete anyway');
    await see(p, 'Delete your account?'); await tap(p, 'Delete my account');
    await see(p, 'Never eat alone', 15000);
    const n = psql(`select count(*) from users where email = 'new@qa.test' and deleted_at is null`);
    if (n !== '0') throw new Error('account still active');
    if (Number(psql(`select count(*) from account_deletion_reasons where reason = 'no_one_near'`)) !== before + 1) throw new Error('the reason was not kept');
  });
  await s.ctx.close();
};

// The "what now" screen right after onboarding (app/start.tsx): a fresh account onboards (photo skipped), lands there, not on
// the map; a plan near you and "Add your next trip" open on top of it and come back to it; "Take me to Explore" leaves it.
SCEN.nextStep = async (browser, size) => {
  const email = 'next@qa.test';
  psql(`delete from users where email = '${email}'`);
  const s = await open(browser, size, 'next', { email });
  const p = s.page;
  await step(s, 'onboarding without a photo', async () => {
    await go(p, '/'); await see(p, 'What should travelers call you?', 15000);
    await typeInto(p, 'First name', 'Ravi'); await tap(p, 'Continue'); await see(p, "When's your birthday?");
    await typeInto(p, 'DD', '05'); await typeInto(p, 'MM', '06'); await typeInto(p, 'YYYY', '1994'); await tap(p, 'Continue');
    await tap(p, 'Man', { exact: true }); await tap(p, 'Continue');
    await typeInto(p, 'Search countries', 'Ind'); await tap(p, 'India', { exact: true }); await tap(p, 'Continue');
    await tap(p, 'Skip for now'); await see(p, 'What are you into?'); await p.waitForTimeout(800);
    let n = 0; for (const l of ['Food', 'Coffee', 'Hiking', 'Nightlife', 'Museums']) { const c = p.getByText(new RegExp(l, 'i')).first(); if (await c.isVisible().catch(() => false)) { await c.click(); n++; } if (n >= 3) break; }
    await tap(p, 'Continue'); await see(p, 'How did you hear about us?');
    await tap(p, 'Skip', { exact: true }); await see(p, 'See plans around you');
    for (let i = 0; i < 20 && psql(`select heard_from from users where email = '${email}'`) !== 'skipped'; i++) await sleep(250);
    if (psql(`select heard_from from users where email = '${email}'`) !== 'skipped') throw new Error('Skip was not recorded');
  });
  await step(s, 'location -> what now, not the map', async () => {
    await tap(p, 'Enable location'); await see(p, "You're in, Ravi.", 25000);
    await see(p, 'Add your next trip'); await see(p, 'Join a plan near you');
    if (!/\/app\/start$/.test(p.url())) throw new Error('not on /app/start: ' + p.url());
    if (await p.getByText('plans nearby').filter({ visible: true }).count()) throw new Error('the map is showing');
    await p.getByText(/ wants to /).first().waitFor({ timeout: 15000 });
    await p.screenshot({ path: `${SHOTS}${size}-start.png` });   // for a look at the layout (out/shots)
  });
  await step(s, 'a plan near you opens it, back returns here', async () => {
    await p.getByText(/ wants to /).first().waitFor({ timeout: 15000 });
    await p.getByText(/ wants to /).first().click(); await p.waitForURL(/\/activity\//, { timeout: 10000 }); await see(p, 'going');
    await p.goBack(); await see(p, 'Add your next trip');
  });
  await step(s, 'Add your next trip opens the trip form, back returns here', async () => {
    await tap(p, 'Add your next trip'); await p.waitForURL(/\/trip\/new/, { timeout: 10000 });
    await p.goBack(); await see(p, 'Take me to Explore');
  });
  await step(s, 'Take me to Explore -> the map', async () => { await tap(p, 'Take me to Explore'); await pastPlusIntro(p); });
  await step(s, 'a returning visit opens the map, not this screen', async () => { await go(p, '/'); await see(p, 'plans nearby', 25000); if (/\/start$/.test(p.url())) throw new Error('start again'); });
  await s.ctx.close();
  psql(`delete from users where email = '${email}'`);
};

// Profile > Delete account (components/LeaveSheet.tsx): "Before you go" (optional reason; for "No one near me", a trip alert and
// the nearest plan), then the confirm. Taking an offer or "Keep my account" keeps the account; deleting stays 2 taps after the
// Profile row, with or without a reason.
SCEN.leave = async (browser, size) => {
  const email = 'leave@qa.test';
  psql(`delete from users where email = '${email}'`);
  const { tokens, ip } = await login(email);
  const h = { 'content-type': 'application/json', authorization: `Bearer ${tokens.accessToken}`, 'x-forwarded-for': ip };
  const r = await fetch(API + '/me', { method: 'PATCH', headers: h, body: JSON.stringify({ name: 'Lena', birthdate: '1992-03-04', gender: 'woman', homeCountry: 'IN', interests: ['food', 'coffee', 'hiking'] }) });
  if (!r.ok) throw new Error('onboard ' + await r.text());
  await fetch(API + '/me/location', { method: 'POST', headers: h, body: JSON.stringify({ lat: BKK.latitude, lng: BKK.longitude }) });
  const s = await open(browser, size, 'leave', { tokens });
  const p = s.page;
  const active = () => psql(`select count(*) from users where email = '${email}' and deleted_at is null`) === '1';
  await step(s, '"No one near me" offers a trip alert and the nearest plan', async () => {
    await go(p, '/profile'); await see(p, 'About you', 15000);
    await tap(p, 'Delete account'); await see(p, 'Before you go');
    if (await p.getByText('Tell me when a traveller is here').filter({ visible: true }).count()) throw new Error('offer shown before a reason');
    await tap(p, 'No one near me'); await see(p, 'Tell me when a traveller is here');
    await p.getByText(/ wants to /).first().waitFor({ timeout: 15000 });
    await p.screenshot({ path: `${SHOTS}${size}-leave.png` });   // for a look at the layout (out/shots)
    await onScreen(p, 'Delete anyway'); await onScreen(p, 'Keep my account');
    await tap(p, 'Keep my account');
  });
  await step(s, 'taking the trip offer opens the trip form and keeps the account', async () => {
    await tap(p, 'Delete account'); await tap(p, 'No one near me');
    await tap(p, 'Tell me when a traveller is here'); await p.waitForURL(/\/trip\/new/, { timeout: 10000 });
    if (!active()) throw new Error('account gone');
  });
  await step(s, 'the nearest plan opens it, sheet closed, account kept', async () => {
    await go(p, '/profile'); await see(p, 'About you'); await tap(p, 'Delete account'); await tap(p, 'No one near me');
    await p.getByText(/ wants to /).first().waitFor({ timeout: 15000 }); await p.getByText(/ wants to /).first().click();
    await p.waitForURL(/\/activity\//, { timeout: 10000 }); await see(p, 'going');
    if (await p.getByText('Before you go').filter({ visible: true }).count()) throw new Error('sheet still open');
    if (!active()) throw new Error('account gone');
  });
  await step(s, 'Keep my account keeps it (both screens)', async () => {
    await go(p, '/profile'); await see(p, 'About you');
    await tap(p, 'Delete account'); await onScreen(p, 'Delete anyway'); await tap(p, 'Keep my account'); await p.getByText('Before you go').waitFor({ state: 'detached', timeout: 8000 });
    await tap(p, 'Delete account'); await tap(p, 'Delete anyway'); await see(p, 'Delete your account?');
    await tap(p, 'Keep my account'); await p.getByText('Delete your account?').waitFor({ state: 'detached', timeout: 8000 });
    if (!active()) throw new Error('account gone');
  });
  await step(s, 'with the offer showing: Delete anyway, Delete my account (2 taps), reason kept', async () => {
    const before = Number(psql(`select count(*) from account_deletion_reasons where reason = 'no_one_near'`));
    await tap(p, 'Delete account'); await tap(p, 'No one near me'); await see(p, 'Tell me when a traveller is here');
    await tap(p, 'Delete anyway'); await see(p, 'Delete your account?'); await onScreen(p, 'Delete my account'); await tap(p, 'Delete my account');
    await see(p, 'Never eat alone', 15000);
    if (active()) throw new Error('account still active');
    if (Number(psql(`select count(*) from account_deletion_reasons where reason = 'no_one_near'`)) !== before + 1) throw new Error('reason not kept');
  });
  await s.ctx.close();
  psql(`delete from users where email = '${email}'`);
};

SCEN.bangkok = async (browser, size, ids) => {
  const s = await open(browser, size, 'bkk', { email: 'bkk@qa.test' });
  const p = s.page;
  await step(s, 'map: plans, day groups, pins', async () => {
    await go(p, '/'); await see(p, 'plans nearby', 20000);
    await p.locator('.maplibregl-marker').first().waitFor({ timeout: 20000 });
    const txt = await p.locator('body').innerText();
    if (!/(TODAY|TOMORROW|Today|Tomorrow)\s*·\s*\d+/.test(txt)) throw new Error('no day group header');
    if (/Ideas ·/.test(txt)) throw new Error('idea toggle shown on a busy map');
  });
  await step(s, 'map: category chip filter', async () => { await tap(p, 'Drinks', { exact: true }); await sleep(1500); await tap(p, 'All', { exact: true }); await sleep(800); });
  await step(s, 'map: tap a pin opens the plan', async () => { await p.locator('.maplibregl-marker').first().dispatchEvent('click'); await p.waitForURL(/activity\//, { timeout: 8000 }); await see(p, 'going'); });
  await step(s, 'plan detail: join -> group chat', async () => {
    await go(p, `/activity/${ids.plan}`); await see(p, 'QA noodle night');
    await tap(p, 'Join chat', { exact: true }); await p.waitForURL(/chat\//, { timeout: 10000 }); await see(p, 'Rahul joined');
  });
  await step(s, 'group chat: send', async () => {
    await sendMsg(p, 'Hello from QA'); await see(p, 'Hello from QA');
  });
  await step(s, 'group chat: react + reply via long-press menu', async () => {
    const msg = p.getByText('Hello from QA').last();
    await longPress(p, msg);
    await p.getByLabel(/^React /).filter({ visible: true }).first().click();
    await p.getByLabel(/, including you/).filter({ visible: true }).first().waitFor({ timeout: 8000 }).catch(async e => { throw new Error('no own reaction chip; labels: ' + await p.evaluate(() => [...document.querySelectorAll('[aria-label]')].map(x => x.getAttribute('aria-label')).join(' | '))); });
    await sleep(1200); await longPress(p, p.getByText('Hello from QA').last()); await tap(p, 'Reply', { exact: true });
    await sendMsg(p, 'Replying to myself');
    await see(p, 'Replying to myself');
  });
  await step(s, 'group chat: poll create + vote', async () => {
    await openAttach(p); await tap(p, 'Poll', { exact: true });
    await typeInto(p, 'Where should we meet?', 'Meet where?'); await typeInto(p, 'Option 1', 'Pier'); await typeInto(p, 'Option 2', 'Market');
    await tap(p, 'Post poll'); await see(p, 'Meet where?'); await tap(p, 'Market', { exact: true }); await sleep(1000);
  });
  await step(s, 'group chat: photo upload', async () => {
    await openAttach(p); await chooseFile(p, () => tap(p, 'Photo', { exact: true }), FIX + 'two-faces.jpg');
    await p.locator('img[src*="/uploads/"], img[src*="chat"]').last().waitFor({ timeout: 15000 }).catch(async () => {
      const n = psql(`select count(*) from messages m join users u on u.id = m.sender_id where u.email = 'bkk@qa.test' and m.kind = 'image'`);
      if (n === '0') throw new Error('no image message stored');
    });
  });
  await step(s, 'group chat: live location', async () => {
    await openAttach(p); await tap(p, 'Live location', { exact: true });
    await see(p, 'sees your exact position');   // the sheet says who sees it, before anything is shared
    await tap(p, '15 minutes'); await see(p, /Stop sharing|Live location|sharing/i, 10000);
  });
  await step(s, 'group chat: the live card says who sees it, and Stop sharing ends it with no map or Open in Maps', async () => {
    await see(p, 'Everyone in this chat can see your exact position', 10000); await see(p, 'Open in Maps');
    await tap(p, 'Stop sharing', { exact: true });
    await see(p, 'Ended', 10000);
    await sleep(500);
    if (await p.getByText('Open in Maps').filter({ visible: true }).count()) throw new Error('an ended share still offers Open in Maps');
    if (await p.getByText('Stop sharing', { exact: true }).filter({ visible: true }).count()) throw new Error('an ended share still offers Stop sharing');
  });
  await step(s, 'plan detail: share (clipboard)', async () => {
    await go(p, `/activity/${ids.plan}`); await see(p, 'QA noodle night'); await p.getByLabel('Share this plan').click(); await see(p, /Link copied/, 5000).catch(() => {});
  });
  await step(s, 'plan detail: leave', async () => {
    await tap(p, 'Leave plan'); await see(p, 'Join chat', 10000);
  });
  await step(s, 'host: close and reopen', async () => {
    await go(p, `/activity/${ids.ownPlan}`); await see(p, 'QA rooftop beers');
    await tap(p, 'Close to new people'); await see(p, 'Reopen to new people', 8000); await see(p, 'Closed to new people');
    await tap(p, 'Reopen to new people'); await see(p, 'Close to new people', 8000);
  });
  await step(s, 'host: cancel plan', async () => {
    await tap(p, 'Cancel plan'); await sleep(1500);
    const st = psql(`select status from activities where id = '${ids.ownPlan}'`); if (st !== 'cancelled') throw new Error('status ' + st);
  });
  await step(s, 'women-only plan hidden from a man', async () => {
    await go(p, `/activity/${ids.womenPlan}`); await see(p, "isn't available", 10000);
    const t = await p.locator('body').innerText(); if (/QA women-only yoga/.test(t)) throw new Error('man can see the women-only plan');
  });
  await step(s, 'create plan (manual)', async () => {
    await go(p, '/activity/new'); await see(p, "What's the plan?");
    await typeInto(p, 'Grab street food in Chinatown', 'QA manual plan'); await typeInto(p, 'Search a café, bar, park…', 'Lumpini');
    await tap(p, 'Lumpini Place'); await p.getByText(/Tomorrow 1 PM/).first().click(); await tap(p, 'Post plan'); await p.waitForURL(/chat\//, { timeout: 10000 });
  });
  await step(s, 'chats list + filters', async () => {
    await go(p, '/chats'); await see(p, 'Chats'); await see(p, 'QA manual plan');
    const hasPlans = await p.getByText(/^Plans/).first().isVisible().catch(() => false);
    if (hasPlans) { await p.getByText(/^Plans/).first().click(); await sleep(400); await p.getByText(/^All/).first().click(); }
  });
  await step(s, 'trips: add Lisbon -> Trip Pass prompt', async () => {
    await go(p, '/trips'); await see(p, 'Trips'); await go(p, '/trip/new'); await see(p, 'Where to next?');
    await typeInto(p, 'Search a city', 'Lisb'); await tap(p, 'Lisbon', { exact: true }); await tap(p, 'Add trip');
    await see(p, /travelers will be in|Trip Pass/i, 15000);
  });
  await step(s, 'trip detail: see all -> paywall', async () => { await tap(p, 'Not now'); await sleep(500); await see(p, 'Lisbon'); });
  await step(s, 'travelers list + age filter', async () => {
    await go(p, '/travelers'); await see(p, 'travelers in the area', 15000); await tap(p, '26-35'); await sleep(1200); await tap(p, 'Any age'); await sleep(600);
  });
  await step(s, 'someone else\'s profile', async () => { await go(p, `/user/${ids.host.id}`); await see(p, 'Hana'); await see(p, 'Message'); });
  await step(s, 'notifications inbox', async () => { await go(p, '/inbox'); await see(p, /Notifications|Nothing here|inbox/i); });
  await step(s, 'paywall screen', async () => { await go(p, '/paywall'); await see(p, 'TABLAMIGO PLUS'); await see(p, /Trip Pass|launching soon/); });
  await step(s, 'profile views screen', async () => { await go(p, '/viewers'); await sleep(1500); });
  await step(s, 'countries screen', async () => { await go(p, '/countries'); await sleep(1500); });
  await step(s, 'logout', async () => { await go(p, '/profile'); await see(p, 'Log out'); await tap(p, 'Log out'); await see(p, 'Never eat alone', 10000); });
  await s.ctx.close();
};

async function sendMsg(p, text, ph = /^(Message|Reply)$/) {
  const input = p.getByPlaceholder(ph).filter({ visible: true }).first(); await input.click(); await input.fill(text);
  const box = await input.boundingBox(); await p.mouse.click(box.x + box.width + 30, box.y + box.height - 22);
}
async function openAttach(p) {
  // The composer's "+" is the first button in its row (left of the input).
  const input = p.getByPlaceholder(/^(Message|Reply)$/).filter({ visible: true }).first();
  await input.waitFor({ timeout: 10000 }); await sleep(600);
  for (let i = 0; ; i++) {
    const box = await input.boundingBox();
    await p.mouse.click(box.x - 30, box.y + box.height - 22);
    try { await see(p, 'Photo', 3000); return; } catch (e) { if (i >= 2) throw e; }
  }
}

SCEN.empty = async (browser, size) => {
  const s = await open(browser, size, 'empty', { email: 'empty@qa.test', geo: PTK });
  const p = s.page;
  await step(s, 'empty city: starter + idea pins', async () => {
    await go(p, '/'); await see(p, /Post the first plan|Create a plan in|No plans here yet/, 25000);
    await see(p, /Ideas · \d/, 25000);
    await p.locator('.maplibregl-marker').first().waitFor({ timeout: 15000 });
  });
  await step(s, 'empty city: nothing within 50 km offers a prefilled plan for the city and the new-plan alerts switch', async () => {
    await go(p, '/'); await see(p, 'Create a plan in Pathankot', 25000); await see(p, 'Notify me when someone near me posts');
    await tap(p, 'Create a plan in Pathankot'); await see(p, "What's the plan?", 10000);
    // The title field is prefilled for the time of day and the city (lib/empty-nearby.ts suggestedPlan).
    await p.waitForFunction(() => [...document.querySelectorAll('input, textarea')].some(i => / in Pathankot$/.test(i.value)), null, { timeout: 5000 });
    await p.goBack();
  });
  await step(s, 'empty city: Invite a friend shares my invite link', async () => {
    await go(p, '/'); await see(p, /Post the first plan here|Create a plan in/, 25000); await see(p, 'Invite a friend');
    // Headless Chrome has no share sheet: record what would be handed to it.
    await p.evaluate(() => { window.__shared = []; Object.defineProperty(navigator, 'share', { configurable: true, value: async d => { window.__shared.push(d); } }); });
    await tap(p, 'Invite a friend');
    await p.waitForFunction(() => window.__shared.length === 1, null, { timeout: 5000 });
    const text = await p.evaluate(() => window.__shared[0].text);
    // Since #64 (1 Nov 2026) a signed-in invite carries the person's own link (GET /me/referral -> the website's /invite?code=
    // page, which hands Android to Play with the code in the install referrer), not the generic Play + website pair.
    if (!/\/invite\?code=[A-Za-z0-9]+/.test(text) || !/\d+ days of Tablamigo Plus/.test(text)) throw new Error('the invite does not carry a personal /invite?code= link: ' + text);
  });
  await step(s, 'Ideas toggle off/on', async () => { await p.getByText(/Ideas · \d/).first().click(); await see(p, 'Ideas off'); await p.getByText('Ideas off').click(); await see(p, /Ideas · \d/); });
  await step(s, 'idea pin -> prefilled create plan', async () => {
    await p.locator('.maplibregl-marker').first().dispatchEvent('click'); await p.waitForURL(/activity\/new/, { timeout: 8000 });
    await see(p, "What's the plan?"); const v = await p.getByPlaceholder('Grab street food in Chinatown').inputValue(); if (!v) throw new Error('title not prefilled');
    const w = await p.getByPlaceholder('Search a café, bar, park…').inputValue(); if (!w) throw new Error('place not prefilled');
  });
  await step(s, 'starter idea card -> prefilled', async () => { await go(p, '/'); await tap(p, 'Grab dinner tonight', { timeout: 20000 }); await see(p, "What's the plan?"); if (!(await p.getByPlaceholder('Grab street food in Chinatown').inputValue())) throw new Error('not prefilled'); });
  await step(s, 'city chat from the empty map', async () => { await go(p, '/'); await tap(p, /Say hi in the/, { timeout: 20000 }); await p.waitForURL(/chat\//, { timeout: 10000 }); });
  await step(s, 'city chat: no live location offered', async () => { await openAttach(p); const t = await p.locator('body').innerText(); if (/Live location/.test(t)) throw new Error('live location offered in city chat'); });
  await s.ctx.close();
};

SCEN.woman = async (browser, size, ids) => {
  const s = await open(browser, size, 'woman', { email: 'woman@qa.test' });
  const p = s.page;
  await step(s, 'women-only plan visible to a woman', async () => { await go(p, '/'); await see(p, 'plans nearby', 20000); await go(p, `/activity/${ids.womenPlan}`); await see(p, 'QA women-only yoga'); await see(p, 'Women only'); });
  await step(s, 'join women-only plan', async () => { await tap(p, 'Join chat', { exact: true }); await p.waitForURL(/chat\//, { timeout: 10000 }); });
  await step(s, 'create women-only plan', async () => {
    await go(p, '/activity/new'); await see(p, 'Women only'); await typeInto(p, 'Grab street food in Chinatown', 'QA ladies brunch');
    await typeInto(p, 'Search a café, bar, park…', 'Cafe'); await tap(p, 'Cafe Place'); await p.getByText(/Tomorrow 10 AM/).first().click();
    await p.locator('input[type="checkbox"], [role="switch"]').last().click(); await tap(p, 'Post plan'); await p.waitForURL(/chat\//, { timeout: 10000 });
    const w = psql(`select women_only from activities where title = 'QA ladies brunch' order by created_at desc limit 1`); if (w !== 't') throw new Error('not women-only: ' + w);
  });
  await s.ctx.close();
};

SCEN.plus = async (browser, size, ids) => {
  const s = await open(browser, size, 'plus', { email: 'plus@qa.test' });
  const p = s.page;
  await step(s, 'profile shows Plus', async () => { await go(p, '/profile'); await see(p, "You're on Plus", 15000); });
  await step(s, 'paywall shows current Plus', async () => { await go(p, '/paywall'); await see(p, 'You have Plus until'); });
  await step(s, 'profile views unlocked', async () => { await go(p, '/viewers'); await sleep(1500); const t = await p.locator('body').innerText(); if (/Get Plus to see/i.test(t)) throw new Error('viewers locked for Plus'); });
  await step(s, 'DM without limits + contact details allowed', async () => {
    await go(p, `/user/${ids.free1.id}`); await tap(p, 'Message', { exact: true }); await p.waitForURL(/chat\//, { timeout: 10000 });
    for (const m of ['hi 1', 'hi 2', 'hi 3', 'hi 4 call me on 9876543210']) { await sendMsg(p, m); await see(p, m); }
  });
  await step(s, 'Plus tag on travelers', async () => { await go(p, '/travelers'); await see(p, 'travelers in the area', 15000); });
  await s.ctx.close();
};

SCEN.free = async (browser, size, ids) => {
  const s = await open(browser, size, 'free1', { email: 'free1@qa.test' });
  const p = s.page;
  await step(s, 'DM: 3 messages then wait-for-reply sheet', async () => {
    await go(p, `/user/${ids.free2.id}`); await tap(p, 'Message', { exact: true }); await p.waitForURL(/chat\//, { timeout: 10000 });
    for (const m of ['hey 1', 'hey 2', 'hey 3']) { await sendMsg(p, m); await see(p, m); }
    await sendMsg(p, 'hey 4');
    await see(p, /Give Greta a moment|moment to reply|Waiting for Greta/i, 8000);
    await tap(p, 'Not now');
  });
  await step(s, 'contact shield in a DM', async () => {
    psql(`insert into messages (chat_id, sender_id, kind, body) select c.id, (select id from users where email='free2@qa.test'), 'text', 'reply from greta' from chats c where c.kind='dm' and c.dm_key like '%${ids.free2.id}%' and c.dm_key like '%${ids.free1.id}%'`);
    await p.reload(); await see(p, 'reply from greta', 10000);
    await sendMsg(p, 'text me on 98765 43210');
    await see(p, /For your safety|contact details/i, 8000);
    await tap(p, 'Not now');
  });
  await step(s, 'second new DM same day -> daily limit sheet', async () => {
    await go(p, `/user/${ids.woman.id}`); await tap(p, 'Message', { exact: true }); await see(p, /free new chat|used today/i, 8000); await tap(p, 'Not now');
  });
  await step(s, 'free profile views locked', async () => { await go(p, '/viewers'); await sleep(1500); });
  await s.ctx.close();
};

SCEN.banned = async (browser, size) => {
  const s = await open(browser, size, 'banned');
  const p = s.page;
  // A session issued before the ban.
  psql(`update users set banned_at = null where email = 'banned@qa.test'`);
  const { tokens } = await login('banned@qa.test');
  psql(`update users set banned_at = now() where email = 'banned@qa.test'`);
  await p.addInitScript(t => { if (!sessionStorage.getItem('qa')) { sessionStorage.setItem('qa', '1'); localStorage.setItem('tablamigo.tokens', t); } }, JSON.stringify(tokens));
  await step(s, 'banned: existing session opens the app', async () => {
    await go(p, '/'); await sleep(6000);
    const t = await p.locator('body').innerText();
    if (!/This account is suspended/.test(t) || !/Use email instead/.test(t)) throw new Error('banned user is not signed out to the welcome screen with a suspended notice: ' + JSON.stringify(t.slice(0, 120)));
  });
  await step(s, 'banned: signing in again is refused', async () => {
    await go(p, '/email'); await typeInto(p, 'you@example.com', 'banned@qa.test'); await tap(p, 'Send code'); await see(p, 'Check your email');
    await p.keyboard.type('424242'); await see(p, /suspended/i, 10000);
  });
  await s.ctx.close();
};

SCEN.admin = async (browser, size) => {
  const s = await open(browser, size, 'admin');
  const p = s.page;
  await p.route('http://localhost:4100/**', async r => {
    const u = r.request().url().replace('http://localhost:4100', API);
    const resp = await fetch(u, { method: r.request().method(), headers: { ...r.request().headers(), 'x-forwarded-for': '10.99.9.9' }, body: r.request().postDataBuffer() ?? undefined });
    const body = Buffer.from(await resp.arrayBuffer());
    await r.fulfill({ status: resp.status, headers: Object.fromEntries(resp.headers), body });
  });
  await step(s, 'admin panel: sign in and tabs', async () => {
    await p.goto('http://127.0.0.1:8099/admin', { waitUntil: 'domcontentloaded' });
    await p.locator('input[type="email"]').first().fill('admin@qa.test');
    await p.locator('button').filter({ hasText: /code|Send|Continue/i }).first().click();
    let code = null; for (let i = 0; i < 40 && !code; i++) { await sleep(250); code = fs.readFileSync(DIR + 'mail.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.to === 'admin@qa.test').at(-1)?.subject.match(/(\d{6})/)?.[1]; }
    if (!code) throw new Error('no admin code email');
    await p.locator('input').filter({ hasNot: p.locator('[type="email"]') }).last().fill(code);
    await p.locator('button').filter({ hasText: /Sign in|Verify|Continue/i }).first().click();
    await sleep(2500);
    for (const tab of ['Users', 'Plans', 'Trips', 'Reports', 'Verifications', 'Tickets', 'Subscriptions', 'Emails', 'Overview']) {
      // The tab bar's own link: a table header on the page before can carry the same word (Plans has a Reports column).
      const t = p.locator('nav.tabs a', { hasText: new RegExp('^' + tab) }).first(); if (await t.isVisible().catch(() => false)) { await t.click(); await sleep(900); } else throw new Error('admin tab missing: ' + tab);
    }
    await p.screenshot({ path: SHOTS + size + '-admin-final.png' });
  });
  await step(s, 'admin overview: every number drills down to its list', async () => {
    await p.goto('http://127.0.0.1:8099/admin#overview'); await sleep(1500);
    // No bare number left: each KPI value and each "Queues and activity" count is a link.
    const bare = await p.evaluate(() => [...document.querySelectorAll('.kpi .v, .split .row b')].filter(el => !el.querySelector('a.drill')).map(el => el.textContent.trim()));
    if (bare.length) throw new Error('numbers without a drill-down: ' + bare.join(', '));
    await p.locator('.split .row', { hasText: 'Plans posted, 7 days' }).locator('b a.drill').click(); await sleep(1200);
    if (!/created=7d/.test(p.url()) || await p.locator('#p-c').inputValue() !== '7d') throw new Error('plans posted link did not filter to 7 days: ' + p.url());
    await p.locator('#p-table').waitFor();
    await p.goto('http://127.0.0.1:8099/admin#overview'); await sleep(1200);
    await p.locator('.split .row', { hasText: 'Upcoming trips' }).locator('b a.drill').click(); await sleep(1200);
    await p.getByRole('heading', { name: 'Trips' }).waitFor({ timeout: 5000 });
    const shown = await p.locator('#t-count').textContent();
    if (!/\d+ trips?/.test(shown)) throw new Error('trips list did not load: ' + shown);
  });
  await step(s, 'admin: a deleted account shows Deleted and cannot be impersonated', async () => {
    const id = psql(`insert into users (email, name, onboarded, created_at, deleted_at) values ('deleted-e2e-' || gen_random_uuid() || '@deleted.tablamigo', 'Deleted user', true, now() - interval '12 minutes', now()) returning id`).split('\n')[0];
    await p.goto('http://127.0.0.1:8099/admin#users?filter=deleted'); await sleep(1500);
    if (await p.locator(`tr[data-id="${id}"] [data-quick-imp]`).count()) throw new Error('deleted row offers Impersonate');
    await p.locator(`tr[data-id="${id}"]`).click(); await sleep(1500);
    if (await p.locator('#imp-btn').count()) throw new Error('deleted drawer offers Login as User');
    const kv = await p.locator('.drawer dl.kv').first().textContent();
    if (!/Deleted/.test(kv) || /\bActive\b/.test(kv)) throw new Error('drawer status: ' + kv.slice(0, 120));
    const advice = await p.locator('.drawer .note').first().textContent();
    if (!/Deleted after 12 min/.test(advice)) throw new Error('suggested action: ' + advice);
    await p.keyboard.press('Escape');
  });
  await s.ctx.close();
};

SCEN.realtime = async (browser, size, ids) => {
  // Realtime must survive the 30-minute access-token refresh. Start with a token that expires in 15 s.
  const jwt = createRequire(new URL('../../api/package.json', import.meta.url).pathname)('jsonwebtoken');
  const { tokens, ip } = await login('bkk@qa.test');
  await fetch(API + `/activities/${ids.plan}/join`, { method: 'POST', headers: { authorization: `Bearer ${tokens.accessToken}`, 'x-forwarded-for': ip } });
  const short = jwt.sign({ sub: ids.bkk.id }, 'dev-only-secret-change-me', { expiresIn: 15 });
  const w = await login('woman@qa.test');
  const post = body => fetch(API + `/chats/${ids.planChat}/messages`, { method: 'POST', headers: { authorization: `Bearer ${w.tokens.accessToken}`, 'content-type': 'application/json', 'x-forwarded-for': w.ip }, body: JSON.stringify({ body }) });
  const s = await open(browser, size, 'rt');
  const p = s.page;
  await p.addInitScript(t => { if (!sessionStorage.getItem('qa')) { sessionStorage.setItem('qa', '1'); localStorage.setItem('tablamigo.tokens', t); } }, JSON.stringify({ accessToken: short, refreshToken: tokens.refreshToken }));
  await step(s, 'live message before token refresh', async () => {
    await go(p, `/chat/${ids.planChat}`); await see(p, 'Rahul joined', 15000); await sleep(1500);
    await post('live one'); await see(p, 'live one', 8000);
  });
  await step(s, 'live message after token refresh', async () => {
    await sleep(17000);
    await sendMsg(p, 'sent after expiry'); await see(p, 'sent after expiry', 10000); await sleep(2500);
    await p.getByPlaceholder('Message').filter({ visible: true }).first().type('x'); await sleep(1500);
    await post('live two'); await see(p, 'live two', 8000);
  });
  await step(s, 'live messages after a reconnect with an expired token', async () => {
    // A fresh page load with an expired access token: the socket's first connect is refused, then recovers.
    const expired = jwt.sign({ sub: ids.bkk.id, exp: Math.floor(Date.now() / 1000) - 60 }, 'dev-only-secret-change-me');
    const fresh = await login('bkk@qa.test');
    await p.evaluate(t => localStorage.setItem('tablamigo.tokens', t), JSON.stringify({ accessToken: expired, refreshToken: fresh.tokens.refreshToken }));
    await go(p, `/chat/${ids.planChat}`); await see(p, 'live two', 15000); await sleep(4000);
    await post('live three'); await see(p, 'live three', 10000);
  });
  await s.ctx.close();
};

// Links in a chat message: this site's /app/ links open the screen in the web app (same tab, router), any other http(s)
// link is a real <a target=_blank rel="noopener noreferrer">, and javascript: text stays text (src/lib/app-links.ts).
SCEN.chatLinks = async (browser, size, ids) => {
  const { tokens, ip } = await login('bkk@qa.test');
  await fetch(API + `/activities/${ids.plan}/join`, { method: 'POST', headers: { authorization: `Bearer ${tokens.accessToken}`, 'x-forwarded-for': ip } });
  const w = await login('woman@qa.test');
  const body = `QA links: ${'https://tablamigo.hookstep.in'}/app/activity/${ids.plan}. Menu https://example.com/menu?x=1, and javascript:alert(1) stays text`;
  const r = await fetch(API + `/chats/${ids.planChat}/messages`, { method: 'POST', headers: { authorization: `Bearer ${w.tokens.accessToken}`, 'content-type': 'application/json', 'x-forwarded-for': w.ip }, body: JSON.stringify({ body }) });
  if (r.status !== 200 && r.status !== 201) throw new Error('posting the message: ' + r.status);
  const s = await open(browser, size, 'links', { email: 'bkk@qa.test' });
  const p = s.page;
  await step(s, 'an outside link is a new-tab anchor with noopener noreferrer', async () => {
    await go(p, `/chat/${ids.planChat}`); await see(p, 'QA links:', 15000);
    const a = app(p).locator('a[href="https://example.com/menu?x=1"]').filter({ visible: true }).first();
    await a.waitFor({ timeout: 8000 });
    if (await a.innerText() !== 'https://example.com/menu?x=1') throw new Error('anchor text: ' + await a.innerText());
    if (await a.getAttribute('target') !== '_blank') throw new Error('target: ' + await a.getAttribute('target'));
    const rel = await a.getAttribute('rel') ?? '';
    if (!/noopener/.test(rel) || !/noreferrer/.test(rel)) throw new Error('rel: ' + rel);
  });
  await step(s, 'javascript: text is never a link', async () => {
    if (await app(p).locator('a[href^="javascript:" i]').count()) throw new Error('a javascript: anchor');
    await see(p, 'javascript:alert(1) stays text');
  });
  await step(s, 'this site\'s plan link opens the plan in the web app, same tab', async () => {
    const pages = s.ctx.pages().length;
    await app(p).getByText(`https://tablamigo.hookstep.in/app/activity/${ids.plan}`, { exact: true }).filter({ visible: true }).first().click();
    await p.waitForURL(new RegExp(`/app/activity/${ids.plan}`), { timeout: 10000 });
    if (!p.url().startsWith(APP)) throw new Error('left the local web app: ' + p.url());
    if (s.ctx.pages().length !== pages) throw new Error('opened a new tab');
    await see(p, 'QA noodle night', 10000);
  });
  await s.ctx.close();
};

SCEN.resilience = async (browser, size, ids) => {
  const s = await open(browser, size, 'bkk2', { email: 'bkk@qa.test' });
  const p = s.page;
  await step(s, 'bad deep links show a message, not a blank page', async () => {
    for (const [path, text] of [['/activity/00000000-0000-4000-8000-000000000000', "isn't available"], ['/user/00000000-0000-4000-8000-000000000000', "isn't available"],
      ['/trip/00000000-0000-4000-8000-000000000000', 'Trip not found'], ['/chat/00000000-0000-4000-8000-000000000000', "Can't load this chat"], ['/activity/not-a-uuid', "isn't available"]]) {
      await go(p, path); await see(p, text, 12000).catch(e => { throw new Error(`${path}: ${e.message.split('\n')[0]}`); });
    }
  });
  await step(s, 'API down at start: retry screen, then recovers', async () => {
    await p.route(API + '/me', r => r.abort('connectionrefused'));
    await go(p, '/'); await see(p, "Can't reach Tablamigo", 15000);
    await p.unroute(API + '/me'); await tap(p, 'Try again'); await see(p, 'plans nearby', 15000);
  });
  await s.ctx.close();
  const s2 = await open(browser, size, 'expired');
  const p2 = s2.page;
  await step(s2, 'expired session (bad refresh token) -> welcome', async () => {
    await p2.addInitScript(() => { if (!sessionStorage.getItem('qa')) { sessionStorage.setItem('qa', '1'); localStorage.setItem('tablamigo.tokens', JSON.stringify({ accessToken: 'x.y.z', refreshToken: 'not-a-real-refresh-token-000000000000' })); } });
    await go(p2, '/'); await see(p2, 'Use email instead', 15000);
  });
  await s2.ctx.close();
};

SCEN.sparse = async (browser, size) => {
  // An old or minimal account: no photo, no languages, no interests, no location, and location permission denied.
  psql(`update users set photo_url = null, languages = '{}', interests = '{}', bio = null, location = null, location_at = null, city = null, countries_visited = '{}' where email = 'empty@qa.test'`);
  const s = await open(browser, size, 'sparse', { email: 'empty@qa.test' });
  await s.ctx.clearPermissions();
  const p = s.page;
  for (const path of ['/', '/trips', '/chats', '/profile', '/travelers', '/inbox', '/viewers', '/verify', '/paywall', '/countries', '/activity/new', '/trip/new']) {
    await step(s, `route ${path}`, async () => { await go(p, path); await sleep(3500); });
  }
  await step(s, 'verify without a profile photo explains why', async () => {
    await go(p, '/verify'); await see(p, 'Get verified', 10000);
    if (size === 'mobile') { await chooseFile(p, () => tap(p, 'Take selfie'), FIX + 'same-person-frontal.jpg'); }
    else { await tap(p, 'Take selfie'); await see(p, 'Take photo', 10000); await sleep(1200); await tap(p, 'Take photo', { exact: true }); }
    await see(p, /profile photo first|Add a profile photo/i, 15000);
  });
  await s.ctx.close();
};

// A call to the local API as one of the personas (a login for `email`), for setting up what a page then shows.
async function as(email) {
  const { tokens, ip } = await login(email);
  return async (method, path, body, contentType) => {
    const raw = body instanceof Buffer;
    const r = await fetch(API + path, { method, headers: { authorization: `Bearer ${tokens.accessToken}`, 'x-forwarded-for': ip, ...(body !== undefined ? { 'content-type': contentType ?? 'application/json' } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
}
// A moment by `email`, posted through the API with a photo uploaded the way the app does.
async function moment(call, caption) {
  const photo = (await call('POST', '/uploads/image/direct?kind=chat', Buffer.from('fake-jpeg'), 'image/jpeg')).json.publicUrl;
  const m = await call('POST', '/moments', { caption, imageUrl: photo, city: 'Bangkok' });
  if (m.status !== 200) throw new Error('could not post the moment: ' + JSON.stringify(m.json));
  return m.json;
}

// The two read-only pages a link can open without an account: a plan shared for safety, and a shared moment. They say
// what they are, and stop working when their owner turns them off.
SCEN.sharedLinks = async (browser, size, ids) => {
  const host = await as('host@qa.test');
  const share = (await host('POST', `/activities/${ids.plan}/share`, {})).json;
  const m = await moment(host, 'QA sunset over the river');
  const s = await open(browser, size, 'anon');
  const p = s.page;
  await step(s, 'a safety link opens with no account and says what it is', async () => {
    await go(p, `/safe/${share.token}`); await see(p, 'A plan shared with you', 15000);
    await see(p, 'QA noodle night'); await see(p, 'does not show where'); await see(p, 'The link works until');
    const t = await p.locator('body').innerText();
    if (/Never eat alone|Use email instead/.test(t)) throw new Error('a signed-out visitor was sent to the welcome screen');
    if (/live (safety )?tracking|tracking link/i.test(t)) throw new Error('the page calls itself tracking');
  });
  await step(s, 'a moment link opens with no account', async () => {
    await go(p, `/m/${m.id}`); await see(p, 'Travel Moment', 15000); await see(p, 'QA sunset over the river'); await see(p, 'Join on Tablamigo'); await see(p, 'Get App');
    if (/Never eat alone/.test(await p.locator('body').innerText())) throw new Error('a signed-out visitor was sent to the welcome screen');
  });
  await step(s, 'a link its owner turned off, and a made-up one, both say so', async () => {
    const off = await host('DELETE', `/safe/${share.token}`); if (off.status !== 200) throw new Error('turning the link off: ' + off.status);
    await go(p, `/safe/${share.token}`); await see(p, "This link isn't working", 15000);
    await go(p, '/safe/' + 'a'.repeat(32)); await see(p, "This link isn't working", 15000);
  });
  await s.ctx.close();
};

// Reporting someone else's moment and comment, from the feed and from the moment page.
SCEN.reports = async (browser, size) => {
  const host = await as('host@qa.test');
  const m = await moment(host, 'QA reportable moment');
  await host('POST', `/moments/${m.id}/comments`, { body: 'QA reportable comment' });
  const s = await open(browser, size, 'woman', { email: 'woman@qa.test' });
  const p = s.page;
  const reports = type => psql(`select count(*) from reports where target_type = '${type}' and target_id = '${type === 'moment' ? m.id : (psql(`select id from moment_comments where moment_id = '${m.id}' limit 1`))}'`);
  await step(s, 'report a moment from the feed', async () => {
    await go(p, '/feed'); await see(p, 'QA reportable moment', 20000);
    await p.getByLabel('Report').filter({ visible: true }).first().click();
    await see(p, "What's wrong with this moment?"); await tap(p, 'Spam, scam or selling'); await see(p, 'Thanks for telling us');
    if (reports('moment') !== '1') throw new Error('no report was stored for the moment');
    await tap(p, 'Done');
  });
  await step(s, 'report a comment from the moment page', async () => {
    await go(p, `/m/${m.id}`); await see(p, 'QA reportable comment', 15000);
    // the first flag is the moment's, in the top bar; the second is the comment's
    await p.getByLabel('Report').filter({ visible: true }).nth(1).click();
    await see(p, "What's wrong with this comment?"); await tap(p, 'Harassment or threats'); await see(p, 'Thanks for telling us');
    if (reports('moment_comment') !== '1') throw new Error('no report was stored for the comment');
    await tap(p, 'Done');
  });
  await step(s, 'the moment page shows the join card to nobody who is signed in', async () => {
    await go(p, `/m/${m.id}`); await see(p, 'QA reportable moment', 15000); await sleep(500);
    if (/Join on Tablamigo/.test(await p.locator('body').innerText())) throw new Error('join card shown to a signed-in person');
  });
  await s.ctx.close();
};

// The launch offer (Plus free for everyone until a date), both states, through the real paywall and profile screens. The app
// reads it from GET /billing/me; this local API serves the field only once the API change is merged, so the browser answers
// that one request itself (404 is what an API without the route says, and means "no offer").
SCEN.launchOffer = async (browser, size) => {
  const s = await open(browser, size, 'free2', { email: 'free2@qa.test' });
  const p = s.page;
  const answer = async (status, body) => {
    await p.unroute(API + '/billing/me').catch(() => {});
    await p.route(API + '/billing/me', r => r.request().method() !== 'GET' ? r.continue()
      : r.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) }));
  };
  const text = async () => (await p.locator('body').innerText());
  const absent = async (what, ...res) => { const t = await text(); for (const re of res) if (re.test(t)) throw new Error(`${what}: still showing ${re}`); };

  for (const [name, status, body] of [['an API without the field', 404, { error: 'not_found' }], ['the offer switched off', 200, { launchOffer: { active: false, until: '2026-12-31T23:59:59Z' } }]]) {
    await answer(status, body);
    await step(s, `offer off (${name}): the paywall sells, with the renewal notice`, async () => {
      await go(p, '/paywall'); await see(p, 'Continue', 20000); await see(p, 'Auto-renews until cancelled'); await see(p, 'Trip Pass');
      await absent('paywall', /Launch offer/i, /free for everyone/i);
    });
    await step(s, `offer off (${name}): the profile offers Plus`, async () => {
      await go(p, '/profile'); await see(p, 'Get Tablamigo Plus', 20000); await see(p, 'Upgrade for 6');
      await absent('profile', /Plus is free/i, /Launch offer/i);
    });
  }

  await answer(200, { launchOffer: { active: true, until: '2026-12-31T23:59:59Z' } });
  await step(s, 'offer on: the paywall says Plus is free and sells nothing', async () => {
    await go(p, '/paywall'); await see(p, 'Launch offer: Plus is free for everyone until 31 Dec 2026', 20000);
    await sleep(800);   // anything that sells would have rendered by now
    await absent('paywall', /Continue/, /Auto-renews/i, /Trip Pass ·/, /Payments by Razorpay/i, /Want Plus for free/i, /Subscribe/);
    if (await p.getByRole('button', { name: 'Continue' }).count()) throw new Error('a Continue button is on the paywall during the offer');
  });
  await step(s, 'offer on: the profile says Plus is free until the date and does not ask to pay', async () => {
    await go(p, '/profile'); await see(p, 'Plus is free until 31 Dec 2026', 20000); await see(p, 'Launch offer: nothing to buy');
    await sleep(500);
    await absent('profile', /Get Tablamigo Plus/, /Upgrade for 6/, /Unlock 6/);
  });
  await step(s, 'offer on: tapping the profile entry opens the paywall, which explains it', async () => {
    await tap(p, 'Plus is free until 31 Dec 2026'); await see(p, 'Launch offer: Plus is free for everyone until 31 Dec 2026', 15000);
  });
  await s.ctx.close();
};

// Everything free (ALL_FREE on the API, src/lib/all-free.ts in the app). The local API runs with paid plans on, so the browser
// adds allFree: true to the real /meta and /me answers; that is all the app reads to switch every purchase entry point off.
SCEN.allFree = async (browser, size) => {
  const s = await open(browser, size, 'free1', { email: 'free1@qa.test' });
  const p = s.page;
  for (const path of ['/meta', '/me']) {
    await p.route(API + path, async r => {
      if (r.request().method() !== 'GET') return r.continue();
      const res = await r.fetch(); const body = await res.json().catch(() => ({}));
      await r.fulfill({ response: res, json: { ...body, allFree: true } });
    });
  }
  const text = async () => (await p.locator('body').innerText());
  const absent = async (what, ...res) => { const t = await text(); for (const re of res) if (re.test(t)) throw new Error(`${what}: still showing ${re}`); };
  await step(s, 'all free: the paywall says everything is free and sells nothing', async () => {
    await go(p, '/paywall?reason=dm'); await see(p, 'Everything in Tablamigo is free right now', 20000);
    await sleep(800);
    await absent('paywall', /Continue/, /Auto-renews/i, /Trip Pass/, /Razorpay/i, /Want Plus for free/i, /Subscribe/, /₹/, /TABLAMIGO PLUS/, /Launch offer/i);
  });
  await step(s, 'all free: the profile says Tablamigo is free, with no upgrade, Plus or Trip Pass wording', async () => {
    await go(p, '/profile'); await see(p, 'Tablamigo is free', 20000); await see(p, 'Invite friends');
    await sleep(500);
    await absent('profile', /Get Tablamigo Plus/, /Upgrade for 6/, /Unlock 6/, /Get 7 days Plus/, /Trip Pass/, /You're on Plus/, /Launch offer/i);
  });
  await step(s, 'all free: inviting friends promises no Plus days', async () => {
    await go(p, '/referral'); await see(p, 'Bring your friends along', 20000);
    await absent('referral', /7 Days/i, /Plus/);
  });
  await s.ctx.close();
};

// Ads only for free accounts (owner, 2 Nov 2026). The one banner and its "Remove ads · Get Plus" link are Android-only
// (components/ExploreAd.tsx; ExploreAd.web.tsx renders nothing), so here: no ad and no link on the web app for anyone, and the
// link's target, /paywall?reason=remove_ads, opens the paywall with its heading and records the reason. A crafted reason
// falls back to the general heading and is recorded as 'general'. Checks look at the newest row, so a late flush can't flake them.
SCEN.removeAds = async (browser, size) => {
  const reasons = email => psql(`select coalesce(string_agg(e.properties->>'reason', ',' order by e.id), '') from analytics_events e join users u on u.id = e.user_id
    where u.email = '${email}' and e.event_name = 'paywall_viewed' and e.properties->>'surface' = 'web'`);
  const noAd = async (p, who) => {
    await go(p, '/'); await see(p, 'Explore', 25000); await sleep(1500);
    const t = await p.locator('body').innerText();
    for (const re of [/Advertisement/i, /Remove ads/i]) if (re.test(t)) throw new Error(`${who}: ${re} on the web Explore tab`);
  };
  for (const [persona, email] of [['free1', 'free1@qa.test'], ['plus', 'plus@qa.test']]) {
    const s = await open(browser, size, persona, { email });
    const p = s.page;
    await step(s, `${persona}: no ad and no Remove ads link on the web app`, () => noAd(p, persona));
    if (persona === 'free1') {
      psql(`delete from analytics_events where event_name = 'paywall_viewed' and user_id = (select id from users where email = '${email}')`);
      await step(s, 'free: the Remove ads link target opens the paywall and records remove_ads', async () => {
        await go(p, '/paywall?reason=remove_ads'); await see(p, 'Remove ads with Plus', 20000); await see(p, 'No ads');
        const last = () => reasons(email).split(',').at(-1);
        for (let i = 0; i < 20 && last() !== 'remove_ads'; i++) await sleep(250);
        if (last() !== 'remove_ads') throw new Error(`recorded reasons: ${reasons(email)}`);
      });
      await step(s, 'free: a crafted reason gets the general heading and is recorded as general', async () => {
        await go(p, '/paywall?reason=__proto__'); await see(p, 'Make every trip social', 20000);
        const last = () => reasons(email).split(',').at(-1);
        for (let i = 0; i < 20 && last() !== 'general'; i++) await sleep(250);
        // Every row is a reason the API keeps: the crafted one never reached the database as sent.
        const all = reasons(email).split(',');
        if (last() !== 'general' || all.some(r => !['remove_ads', 'general'].includes(r))) throw new Error(`recorded reasons: ${reasons(email)}`);
      });
    } else {
      await step(s, 'plus: /me says plus, so the Android banner and link would not render either', async () => {
        const me = await p.evaluate(async api => { const t = JSON.parse(localStorage.getItem('tablamigo.tokens')); return (await fetch(api + '/me', { headers: { authorization: 'Bearer ' + t.accessToken } })).json(); }, API);
        if (me.plus !== true || me.allFree === true) throw new Error(`plus account /me: plus=${me.plus} allFree=${me.allFree}`);
      });
    }
    await s.ctx.close();
  }
};

// The 6-month plan (2 Nov 2026) on the web paywall: four rows in order (1 month, 6 months, 12 months, Trip Pass), the 6-month row
// with its per-month price and saving against monthly, yearly still "Best value", and Continue asks the API for halfyearly. An API
// without RAZORPAY_PLAN_HALFYEARLY sends no halfyearly price: then the row is simply not there and the rest is unchanged.
SCEN.halfYear = async (browser, size) => {
  const s = await open(browser, size, 'free2', { email: 'free2@qa.test' });
  const p = s.page;
  const order = async () => {
    const t = await p.locator('body').innerText();
    return ['1 month', '6 months', '12 months', 'Trip Pass ·'].map(l => t.indexOf(l));
  };
  await step(s, '6 months: four plans in order, with its own per-month price and saving', async () => {
    await go(p, '/paywall'); await see(p, 'Continue', 20000); await see(p, '6 months');
    const at = await order();
    if (at.some(i => i < 0) || !at.every((v, i) => i === 0 || v > at[i - 1])) throw new Error(`plan order ${at}`);
    await see(p, '₹2,499'); await see(p, '₹417/month · save 16%'); await see(p, 'Best value · ₹334/month · save 33%');
  });
  await step(s, '6 months: Continue asks the API for the halfyearly plan', async () => {
    let body = null;
    await p.route(API + '/billing/razorpay/subscribe', r => { body = r.request().postDataJSON(); return r.fulfill({ status: 400, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: 'checkout_failed', message: 'qa: stopped before checkout' }) }); });
    await tap(p, '6 months', { exact: true }); await tap(p, 'Continue', { exact: true });
    for (let i = 0; i < 40 && !body; i++) await sleep(100);
    await p.unroute(API + '/billing/razorpay/subscribe');
    if (body?.period !== 'halfyearly') throw new Error(`subscribe body ${JSON.stringify(body)}`);
  });
  await step(s, 'no halfyearly price from the API: three plans as before', async () => {
    await p.route(API + '/billing/plans', async r => {
      const res = await r.fetch(); const j = await res.json();
      if (j.razorpay) delete j.razorpay.prices.halfyearly;
      return r.fulfill({ response: res, json: j });
    });
    await go(p, '/paywall'); await see(p, 'Continue', 20000); await see(p, '12 months');
    if (/6 months/.test(await p.locator('body').innerText())) throw new Error('6 months shown without a price');
    await p.unroute(API + '/billing/plans');
  });
  await s.ctx.close();
};

// No location at all (said no, never shared one): the app used to look at a fixed Bangkok point and showed Bangkok plans,
// Bangkok travelers and the Bangkok city chat to people in Istanbul. Now it shows the home country's main city and says so.
SCEN.noLocation = async (browser, size) => {
  const s = await open(browser, size, 'nogeo', { email: 'nogeo@qa.test', geo: null });
  const p = s.page;
  const asked = [];
  p.on('request', r => { if (r.url().startsWith(API)) asked.push(r.url()); });
  await step(s, 'no location: home-country city, labelled, and never Bangkok', async () => {
    await go(p, '/'); await see(p, 'Showing Istanbul (your home country)', 30000);
    await see(p, 'Use my location'); await see(p, 'Change');
    // The nearest cities that have plans (shown when nothing is within 50 km) may name Bangkok as a place with plans; anywhere
    // else on the screen Bangkok would mean the stale location leaked.
    let rest = await p.locator('body').innerText();
    for (const t of await p.locator('[data-testid="nearest-cities"]').allInnerTexts()) rest = rest.replace(t, '');
    if (/Bangkok/i.test(rest)) throw new Error('shows Bangkok');
    const bkk = asked.filter(u => /13\.7466|100\.5346/.test(u));
    if (bkk.length) throw new Error('asked about Bangkok: ' + bkk[0]);
    if (!asked.some(u => /\/activities\?lat=41\.0082/.test(u))) throw new Error('plans were not asked for Istanbul: ' + asked.filter(u => u.includes('/activities')).join(' '));
  });
  await step(s, 'no location: no "where you are" city chat for a guessed city', async () => {
    const t = await p.locator('body').innerText();
    if (/Say hi in the/.test(t)) throw new Error('offered the city chat for a city the person may not be in');
  });
  await step(s, 'no location: pick a city', async () => {
    await tap(p, 'Change'); await see(p, 'Pick a city'); await typeInto(p, 'Search a city', 'Lisbon'); await tap(p, 'Lisbon');
    await see(p, 'Showing Lisbon', 15000);
  });
  await s.ctx.close();
};

// The web app's rating card (lib/review-prompt.web.ts, components/ReviewCard.web.tsx): "Enjoying Tablamigo? Rate us on Google
// Play" after a person's 3rd sent chat message or right after joining a plan, never in a session's first minute, never with the
// phone keyboard up, never for test or review accounts, never on iPhone; once per 60 days (server: POST /me/review-ask).
// The @qa.test personas are test accounts and are never asked, so this scenario signs up real-looking travellers itself.
const PLAY_LISTING = 'https://play.google.com/store/apps/details?id=com.tablamigo.app';
const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
};
async function traveller(local, name, gender = 'woman') {
  const email = `${local}-${Date.now().toString(36)}@travellers-e2e.in`;
  const ip = `10.${200 + Math.floor(Math.random() * 50)}.${Math.floor(Math.random() * 250)}.${++ipn % 250 + 1}`;
  const h = { 'content-type': 'application/json', 'x-forwarded-for': ip };
  await fetch(API + '/auth/email/start', { method: 'POST', headers: h, body: JSON.stringify({ email }) });
  let code = null;
  for (let i = 0; i < 40 && !code; i++) { await sleep(250); code = fs.readFileSync(DIR + 'mail.jsonl', 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.to === email).at(-1)?.subject.match(/(\d{6})/)?.[1]; }
  if (!code) throw new Error('no sign-in code for ' + email);
  const v = await (await fetch(API + '/auth/email/verify', { method: 'POST', headers: h, body: JSON.stringify({ email, code }) })).json();
  const call = async (method, path, body) => {
    const r = await fetch(API + path, { method, headers: { ...h, authorization: `Bearer ${v.accessToken}` }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(j)}`); return j;
  };
  await call('PATCH', '/me', { name, birthdate: '1995-03-04', gender, homeCountry: 'IN', interests: ['food', 'coffee'] });
  await call('POST', '/me/location', { lat: BKK.latitude, lng: BKK.longitude });
  const me = await call('GET', '/me');
  return { email, id: me.id, call, tokens: { accessToken: v.accessToken, refreshToken: v.refreshToken } };
}
const cardShown = p => app(p).getByText('Enjoying Tablamigo?', { exact: true }).filter({ visible: true }).count();
const askedAt = id => psql(`select coalesce(review_asked_at::text, '') from users where id = '${id}'`);
function claims(page) {
  const seen = [];
  page.on('response', async r => { if (r.url().endsWith('/me/review-ask') && r.request().method() === 'POST') seen.push(await r.json().catch(() => ({}))); });
  return seen;
}
const soonPlan = (call, title) => call('POST', '/activities', { title, emoji: '☕', category: 'food', placeName: 'Yaowarat Road', lat: 13.7398, lng: 100.51, startsAt: new Date(Date.now() + 6 * 3600_000).toISOString(), maxPeople: 8 });

SCEN.reviewCard = async (browser, size) => {
  const phone = size === 'mobile';
  const host = await traveller('rc-host', 'Meera');
  const [ana, ben, cat] = await Promise.all([traveller('rc-ana', 'Ana'), traveller('rc-ben', 'Ben', 'man'), traveller('rc-cat', 'Cat')]);
  psql(`update users set plus_until = now() + interval '30 days', comp_until = now() + interval '30 days' where id = '${host.id}'`);   // free accounts post one plan a day
  const own = await soonPlan(ana.call, 'QA review chat');
  const toJoin = await soonPlan(host.call, 'QA review join');
  const toJoinIos = await soonPlan(host.call, 'QA review join iOS');
  const toJoinQa = await soonPlan(host.call, 'QA review join test account');
  const ua = phone ? UA.android : undefined;
  // Everyone's session starts now: nothing may be asked in its first minute.
  const A = await open(browser, size, 'rc-ana', { tokens: ana.tokens, ua });
  const B = await open(browser, size, 'rc-ben', { tokens: ben.tokens, ua });
  const C = phone ? await open(browser, size, 'rc-ios', { tokens: cat.tokens, ua: UA.iphone }) : null;
  const D = await open(browser, size, 'rc-qa', { email: 'free2@qa.test', ua });
  const [ca, cb, cc, cd] = [claims(A.page), claims(B.page), C ? claims(C.page) : [], claims(D.page)];
  const t0 = Date.now();
  await Promise.all([go(A.page, `/chat/${own.chatId}`), go(B.page, `/activity/${toJoin.id}`), C && go(C.page, `/activity/${toJoinIos.id}`), go(D.page, `/activity/${toJoinQa.id}`)]);

  await step(A, 'review card: 3 messages in the first minute ask nothing', async () => {
    await see(A.page, 'QA review chat', 20000);
    for (const t of ['rc one', 'rc two', 'rc three']) { await sendMsg(A.page, t); await see(A.page, t); }
    await sleep(3000);
    if (await cardShown(A.page)) throw new Error('card shown in the first minute');
    if (ca.length) throw new Error('the server was asked in the first minute: ' + JSON.stringify(ca));
  });
  await sleep(Math.max(0, t0 + 62_000 - Date.now()));

  await step(A, `review card: the next message after the first minute shows it${phone ? ', once the keyboard is down' : ''}`, async () => {
    await sendMsg(A.page, 'rc four'); await see(A.page, 'rc four');
    if (phone) {
      // Typing again straight away: the phone keyboard is up, so the card waits.
      await A.page.getByPlaceholder(/^(Message|Reply)$/).filter({ visible: true }).first().focus();
      await sleep(2500);
      if (await cardShown(A.page)) throw new Error('card shown with the keyboard up');
      await A.page.evaluate(() => document.activeElement?.blur());
    }
    await see(A.page, 'Enjoying Tablamigo?', 8000);
    const link = app(A.page).getByText('Rate us on Google Play', { exact: true }).filter({ visible: true }).first();
    const tag = await link.evaluate(el => ({ tag: el.tagName, href: el.getAttribute('href'), target: el.getAttribute('target'), rel: el.getAttribute('rel') }));
    if (tag.tag !== 'A' || tag.href !== PLAY_LISTING || tag.target !== '_blank' || !/noopener/.test(tag.rel ?? '')) throw new Error('link: ' + JSON.stringify(tag));
    const text = await A.page.locator('body').innerText();
    if (/★|5[- ]star|five stars|reward|free (month|plus)/i.test(text)) throw new Error('the card asks for stars or offers something');
    if (ca.filter(c => c.ask === true).length !== 1) throw new Error('claims: ' + JSON.stringify(ca));
    if (!askedAt(ana.id)) throw new Error('review_asked_at not set on the server');
    await A.page.screenshot({ path: `${SHOTS}review-card-${size}.png` });   // for a look at the card itself
  });
  await step(A, 'review card: dismissed, and not shown again for the next messages', async () => {
    await A.page.getByTestId('review-card').getByRole('button', { name: 'Dismiss' }).click();
    await sleep(500);
    if (await cardShown(A.page)) throw new Error('still shown after Dismiss');
    await sendMsg(A.page, 'rc five'); await see(A.page, 'rc five'); await sleep(3000);
    if (await cardShown(A.page)) throw new Error('shown again');
    if (ca.length !== 1) throw new Error('the server was asked again: ' + JSON.stringify(ca));
    // Another device or a cleared browser: nothing stored here, but the server's 60 days hold.
    await A.page.evaluate(id => localStorage.removeItem(`tablamigo.review.v2.${id}`), ana.id);
    await A.page.reload({ waitUntil: 'domcontentloaded' }); await see(A.page, 'rc five', 20000);
    await A.page.evaluate(() => { const n = Date.now; Date.now = () => n() + 61_000; });   // past the reloaded page's first minute
    for (const t of ['rc six', 'rc seven', 'rc eight']) { await sendMsg(A.page, t); await see(A.page, t); }
    await sleep(3000);
    if (await cardShown(A.page)) throw new Error('shown again after the local state was cleared');
    if (!ca.some(c => c.ask === false && c.reason === 'cooldown')) throw new Error('expected the server to refuse with cooldown: ' + JSON.stringify(ca));
  });
  await step(B, 'review card: joining a plan shows it once the chat has opened', async () => {
    await tap(B.page, 'Join chat', { exact: true }); await B.page.waitForURL(/chat\//, { timeout: 10000 });
    await sleep(1500);
    if (await cardShown(B.page)) throw new Error('shown before the chat settled');
    await see(B.page, 'Enjoying Tablamigo?', 8000);
    if (cb.filter(c => c.ask === true).length !== 1) throw new Error('claims: ' + JSON.stringify(cb));
    await sleep(31_000);
    if (await cardShown(B.page)) throw new Error('the card did not go away on its own after 30 s');
  });
  if (C) await step(C, 'review card: never on an iPhone (nothing to rate on Google Play)', async () => {
    await tap(C.page, 'Join chat', { exact: true }); await C.page.waitForURL(/chat\//, { timeout: 10000 }); await sleep(4500);
    if (await cardShown(C.page)) throw new Error('shown on an iPhone');
    if (cc.length) throw new Error('the server was asked from an iPhone');
    if (askedAt(cat.id)) throw new Error('an iPhone used up the ask');
  });
  await step(D, 'review card: never for a test account', async () => {
    await tap(D.page, 'Join chat', { exact: true }); await D.page.waitForURL(/chat\//, { timeout: 10000 }); await sleep(4500);
    if (await cardShown(D.page)) throw new Error('shown to free2@qa.test');
    if (cd.length) throw new Error('the server was asked for a test account');
  });
  for (const s of [A, B, C, D]) await s?.ctx.close();
  psql(`delete from users where email like '%@travellers-e2e.in'`);
};

// Photo viewer (components/PhotoViewer.tsx) and the first-meet shortcuts (2 Nov 2026): a feed photo opens full screen with its
// caption and author, swipes with the arrows, closes with Escape or the close button; the author and the place open their
// pages; the city page's "Show me in Who's here now" switch; one-tap Join on a plan card; Message on a plan's host; a place with no guide.
SCEN.photoViewer = async (browser, size, ids) => {
  const host = await as('host@qa.test');
  const face = fs.readFileSync(FIX + 'profile.jpg');
  const photo = async () => (await host('POST', '/uploads/image/direct?kind=chat', face, 'image/jpeg')).json.publicUrl;
  for (const caption of ['QA viewer one', 'QA viewer two']) {
    const m = await host('POST', '/moments', { caption, imageUrl: await photo(), city: 'Bangkok' });
    if (m.status !== 200) throw new Error('moment: ' + JSON.stringify(m.json));
  }
  // Hosted by the Plus persona: a free host's 2 plans a day are already used by the seed.
  const priti = await as('plus@qa.test');
  const made = await priti('POST', '/activities', { title: 'QA viewer breakfast', emoji: '🥐', category: 'food', placeName: 'Siam Paragon', lat: 13.7462, lng: 100.5347, startsAt: new Date(Date.now() + 6 * 3600e3).toISOString(), maxPeople: 6 });
  if (made.status !== 200) throw new Error('plan: ' + JSON.stringify(made.json));
  const plan = made.json;
  psql(`update users set here_now_opt_in = false where email = 'free1@qa.test'`);
  const s = await open(browser, size, 'free1', { email: 'free1@qa.test' });
  const p = s.page;
  const closeBtn = () => p.getByRole('button', { name: 'Close photo' }).filter({ visible: true });
  const openPhoto = async () => {
    await p.getByLabel("Open Hana's photo").filter({ visible: true }).first().click();
    await closeBtn().first().waitFor({ timeout: 8000 });
  };
  await step(s, 'a feed photo opens full screen with its caption and author', async () => {
    await go(p, '/feed'); await see(p, 'QA viewer two', 20000);
    await openPhoto();
    const dlg = await p.locator('body').innerText();
    if (!/1 \/ \d+/.test(dlg)) throw new Error('no "1 / N" counter: the viewer should swipe through the feed photos');
    if ((dlg.match(/QA viewer two/g) ?? []).length < 2) throw new Error('the caption is not shown in the viewer');
    await p.getByRole('link', { name: "Open Hana's profile" }).filter({ visible: true }).first().waitFor({ timeout: 5000 });
    await sleep(800); await p.screenshot({ path: `${SHOTS}${size}-photo-viewer.png` });
  });
  await step(s, 'the arrow key and the next button move; Escape closes', async () => {
    await p.keyboard.press('ArrowRight'); await see(p, '2 / ', 5000);
    await p.getByRole('button', { name: 'Previous photo' }).filter({ visible: true }).first().click(); await see(p, '1 / ', 5000);
    await p.keyboard.press('Escape'); await closeBtn().first().waitFor({ state: 'hidden', timeout: 5000 });
  });
  await step(s, 'the close button closes', async () => {
    await openPhoto(); await closeBtn().first().click(); await closeBtn().first().waitFor({ state: 'hidden', timeout: 5000 });
  });
  await step(s, "the author in the viewer opens the author's profile", async () => {
    await openPhoto();
    await p.getByRole('link', { name: "Open Hana's profile" }).filter({ visible: true }).first().click();
    await p.waitForURL(new RegExp(`/user/${ids.host.id}`), { timeout: 10000 }); await see(p, 'QA persona host', 15000);
    if (await closeBtn().count()) throw new Error('the viewer stayed open over the profile');
  });
  await step(s, "the place on a feed post opens that city's page", async () => {
    await go(p, '/feed'); await see(p, 'QA viewer two', 20000);
    await p.getByRole('link', { name: 'Open Bangkok' }).filter({ visible: true }).first().click();
    await p.waitForURL(/\/city\/bangkok/, { timeout: 10000 }); await see(p, 'Bangkok City Hub', 15000);
  });
  await step(s, "the city page's switch lists you in Who's here now, and hides you again", async () => {
    await see(p, "Show me in Who's here now", 10000);
    await p.getByRole('switch', { name: "Show me in Who's here now" }).first().click(); await see(p, "You're listed in Who's here now", 8000);
    for (let i = 0; i < 20 && psql(`select here_now_opt_in from users where email = 'free1@qa.test'`) !== 't'; i++) await sleep(250);
    if (psql(`select here_now_opt_in from users where email = 'free1@qa.test'`) !== 't') throw new Error('not saved');
    await p.getByRole('switch', { name: "Show me in Who's here now" }).first().click(); await see(p, "Show me in Who's here now", 8000);
    for (let i = 0; i < 20 && psql(`select here_now_opt_in from users where email = 'free1@qa.test'`) !== 'f'; i++) await sleep(250);
    if (psql(`select here_now_opt_in from users where email = 'free1@qa.test'`) !== 'f') throw new Error('not turned off');
  });
  await step(s, 'a place without a guide opens its plans, with no city chat', async () => {
    psql(`insert into moments (user_id, city, country_code, image_url, caption) values ('${ids.host.id}', 'Mapusa', 'IN', 'https://x.test/m.jpg', 'QA mapusa')`);
    await go(p, '/city/mapusa-in'); await see(p, 'Mapusa', 15000); await see(p, 'Upcoming Plans in Mapusa');
    const t = await p.locator('body').innerText();
    if (/City Chat|City Hub|Nothing here yet/.test(t)) throw new Error('a no-guide place shows guide parts or the empty page');
  });
  await step(s, "Message on a plan's host opens a chat with them", async () => {
    await go(p, `/activity/${plan.id}`); await see(p, 'QA viewer breakfast', 15000);
    await p.getByRole('button', { name: 'Message Priti' }).filter({ visible: true }).first().click();
    await p.waitForURL(/\/chat\//, { timeout: 10000 });
  });
  await step(s, 'one-tap Join on a plan card joins and opens the group chat', async () => {
    await go(p, '/'); await see(p, 'QA viewer breakfast', 25000);
    const card = p.getByRole('button', { name: "Join Priti's plan" }).filter({ visible: true });
    await card.first().waitFor({ timeout: 10000 });
    await p.screenshot({ path: `${SHOTS}${size}-quick-join.png` });
    // Other plans on the map have Join too; press the Join inside this plan's own card (the innermost focusable box with its title).
    await p.locator('div[tabindex="0"]', { hasText: 'QA viewer breakfast' }).last().getByRole('button', { name: "Join Priti's plan" }).click();
    await p.waitForURL(/\/chat\//, { timeout: 15000 });
    for (let i = 0; i < 20 && psql(`select count(*) from activity_members m join users u on u.id = m.user_id where u.email = 'free1@qa.test' and m.activity_id = '${plan.id}' and m.rsvp_status = 'going'`) === '0'; i++) await sleep(250);
    if (psql(`select count(*) from activity_members m join users u on u.id = m.user_id where u.email = 'free1@qa.test' and m.activity_id = '${plan.id}' and m.rsvp_status = 'going'`) === '0') throw new Error('not joined');
  });
  await s.ctx.close();
  psql(`update users set here_now_opt_in = false where email = 'free1@qa.test'`);
};

// ---------------------------------------------------------------------------------------------------------------
// Installed Google Chrome by default (GitHub's ubuntu runners have it too); E2E_BROWSER_CHANNEL=chromium uses Playwright's own.
const channel = (process.env.E2E_BROWSER_CHANNEL ?? 'chrome') === 'chromium' ? undefined : (process.env.E2E_BROWSER_CHANNEL ?? 'chrome');
const browser = await chromium.launch({ channel, headless: true, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
const sizes = argSizes === 'both' ? ['desktop', 'mobile'] : [argSizes];
for (const size of sizes) {
  execFileSync('node', [new URL('./seed.mjs', import.meta.url).pathname], { stdio: 'inherit' });
  const ids = JSON.parse(fs.readFileSync(DIR + 'tokens.json', 'utf8'));
  for (const [name, fn] of Object.entries(SCEN)) {
    if (only && !only.includes(name)) continue;
    if (name === 'admin' && !process.env.ADMIN_HTML) continue;
    const t0 = Date.now();
    try { await fn(browser, size, ids); } catch (e) { results.push({ size, persona: name, flow: 'scenario crashed', ok: false, note: e.message.slice(0, 200) }); }
    console.log(`${size} ${name} done in ${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
await browser.close();
fs.writeFileSync(DIR + 'results.json', JSON.stringify({ results, issues }, null, 1));
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.size, 8)} ${pad(r.persona, 7)} ${pad(r.flow, 48)} ${r.ok ? '' : r.note}`);
const counts = {}; for (const i of issues) { const k = `${i.kind} | ${i.text.slice(0, 160)}`; counts[k] = (counts[k] ?? 0) + 1; }
console.log('\n--- issues (deduped) ---');
for (const [k, n] of Object.entries(counts).sort()) console.log(`${n}x ${k}`);
// Console noise that is expected in this local setup; anything else fails the run.
const KNOWN = [
  [/Failed to load resource: the server responded with a status of (400|401|402|403|404)/, 'the API refusing on purpose: expired session (401, refreshed), wrong code, paywall (402), contact shield or banned (403), a hidden plan (404)'],
  [/127\.0\.0\.1:4199\/dev-files\/\S+ csp$/, "admin.html's CSP allows photos from https: and the dev API on :4100, not this pass's API on :4199 (seeded avatars are local uploads since 13 Oct)"],
  [/ERR_ABORTED/, 'requests cancelled by navigating away'],
  [/api\.dicebear\.com.*ERR_BLOCKED_BY_ORB/, 'demo-seed avatars from dicebear'],
  [/localhost:4100\/dev-files|ERR_CONNECTION_REFUSED|violates the following Content Security Policy/, 'photos of other local accounts stored under another dev API address'],
  [/(AJAXError: )?Failed to fetch/, 'map tile or resource fetch cut off when navigating away'],
  [/ERR_NETWORK_IO_SUSPENDED/, 'headless Chrome network suspend on static asset reload'],
];
const unknown = issues.filter(i => ['console.error', 'pageerror', 'requestfailed', 'http5xx'].includes(i.kind) && !KNOWN.some(([re]) => re.test(i.text)));
console.log(`\n${results.filter(r => r.ok).length} passed, ${results.filter(r => !r.ok).length} failed, ${unknown.length} unexpected console/page errors`);
for (const i of unknown) console.log(`  UNEXPECTED ${i.size} ${i.persona} ${i.url} ${i.kind}: ${i.text.slice(0, 200)}`);
process.exitCode = results.some(r => !r.ok) || unknown.length ? 1 : 0;
