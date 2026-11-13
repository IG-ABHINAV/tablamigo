// iPhone layout pass over the web app in WebKit (Safari's engine) with Playwright's iPhone device profiles, against the
// same local stack as drive.mjs (export on :8099/app, API on :4199, seeded @qa.test personas from seed.mjs).
//   node iphone.mjs [shots-dir] [screen,...]       (exit 1 when any screen breaks a layout rule)
// Playwright's WebKit has no notch, so env(safe-area-inset-*) is 0 there. The pass fakes the insets the way an installed
// iPhone app sees them (react-native-safe-area-context measures a probe element whose padding is env(...)), and paints the
// status bar and home indicator zones on each screenshot so anything sitting under them shows.
// Rules per screen (lib/layout-audit.mjs): no horizontal page overflow, no text field under 16px (Safari zooms the page on
// focus and leaves it zoomed), nothing tappable inside the status bar or home indicator zones, and the page is not scrolled
// off its origin (iOS scrolls the window to show a focused field and leaves the app shifted), and no icon-only button under
// 44pt (since 2 Nov 2026; IconButton gives one a 44pt box on the web). Other tap targets under 44pt are reported, not failed.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { auditScript } from './layout-audit.mjs';
const require = createRequire((process.env.PLAYWRIGHT_FROM ?? process.env.HOME + '/Desktop/hookpost') + '/package.json');
const { webkit, chromium, devices } = require('playwright');
// ANDROID=1: the same screens and rules in Chromium with Pixel 7 / Galaxy S9+ profiles (Chrome on Android: no notch insets
// in the browser tab, the keyboard shrinks the visual viewport the same way).

const APP = 'http://127.0.0.1:8099/app';
const OUT = process.argv[2] ?? new URL('./out/iphone/', import.meta.url).pathname;
const only = process.argv[3]?.split(',');
fs.mkdirSync(OUT, { recursive: true });
const T = JSON.parse(fs.readFileSync(new URL('./out/tokens.json', import.meta.url)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Insets as an installed (standalone) web app sees them in portrait: status bar + home indicator.
const NONE = { top: 0, bottom: 0, left: 0, right: 0 };
const PHONES = process.env.WIDE ? {
  // WIDE=1: tablets and desktop, same rules (no insets, no keyboard). iPad in Safari, a laptop, a big monitor.
  'ipad768': { device: { ...devices['iPad Mini'] }, insets: NONE },
  'ipad-landscape': { device: { ...devices['iPad (gen 7) landscape'] }, insets: NONE },
  'desktop1024': { device: { viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 }, insets: NONE },
  'desktop1440': { device: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }, insets: NONE },
} : process.env.ANDROID ? {
  'pixel7': { device: devices['Pixel 7'], insets: NONE, kb: 300 },
  'galaxyS9': { device: devices['Galaxy S9+'], insets: NONE, kb: 280 },
} : {
  'iphone15pro': { device: devices['iPhone 15 Pro'], insets: { top: 59, bottom: 34, left: 0, right: 0 }, kb: 336 },
  'iphoneSE': { device: devices['iPhone SE'], insets: { top: 20, bottom: 0, left: 0, right: 0 }, kb: 253 },
};
if (process.env.LANDSCAPE) PHONES['iphone15pro-land'] = { device: devices['iPhone 15 Pro landscape'], insets: { top: 0, bottom: 21, left: 59, right: 59 } };

const SCREENS = [
  { name: 'welcome', path: '/welcome', who: null },
  { name: 'email', path: '/email', who: null, focus: 'input' },
  { name: 'explore', path: '/', who: 'bkk', wait: 2500 },
  { name: 'feed', path: '/feed', who: 'bkk' },
  { name: 'chats', path: '/chats', who: 'bkk' },
  { name: 'trips', path: '/trips', who: 'bkk' },
  { name: 'profile', path: '/profile', who: 'bkk' },
  { name: 'plan', path: '/activity/' + T.plan, who: 'bkk' },
  { name: 'new-plan', path: '/activity/new', who: 'bkk', focus: 'input' },
  { name: 'chat', path: '/chat/' + T.planChat, who: 'host', focus: 'textarea,input' },
  { name: 'user', path: '/user/' + T.host?.id, who: 'bkk' },
  { name: 'paywall', path: '/paywall', who: 'free1' },
  { name: 'inbox', path: '/inbox', who: 'bkk' },
  { name: 'display', path: '/display', who: 'bkk' },
  { name: 'language', path: '/language', who: 'bkk' },
  { name: 'travelers', path: '/travelers', who: 'bkk' },
  { name: 'new-trip', path: '/trip/new', who: 'bkk', focus: 'input' },
  { name: 'pick-city', path: '/pick-city', who: 'bkk' },
  { name: 'verify', path: '/verify', who: 'bkk' },
  { name: 'referral', path: '/referral', who: 'bkk' },
  { name: 'connections', path: '/connections', who: 'bkk' },
  { name: 'countries', path: '/countries', who: 'bkk' },
  { name: 'city', path: '/city/bangkok', who: 'bkk' },
  { name: 'empty-explore', path: '/', who: 'empty', wait: 2500 },
  // Added in the 2 Nov 2026 sweep: header icons here were 18-30pt on the web.
  { name: 'own-plan', path: '/activity/' + T.ownPlan, who: 'bkk' },
  { name: 'trip', path: '/trip/' + T.hostTrip, who: 'host' },
  { name: 'trip-passes', path: '/trip-passes', who: 'free1' },
  { name: 'moment', path: '/m/' + T.moment, who: 'bkk' },
].filter(s => !only || only.includes(s.name));

function insetsInit(ins) {
  // The probe from react-native-safe-area-context (NativeSafeAreaProvider.web.tsx): a fixed 0x0 div with env() paddings.
  const real = window.getComputedStyle.bind(window);
  window.getComputedStyle = (el, p) => {
    const cs = real(el, p);
    if (el && el.style && String(el.style.paddingTop).includes('safe-area-inset')) {
      return new Proxy(cs, { get: (t, k) => ({ paddingTop: ins.top + 'px', paddingBottom: ins.bottom + 'px', paddingLeft: ins.left + 'px', paddingRight: ins.right + 'px' })[k] ?? (typeof t[k] === 'function' ? t[k].bind(t) : t[k]) });
    }
    return cs;
  };
  // The iOS keyboard, as Safari reports it: the layout viewport keeps its height, the visual viewport shrinks (and may pan).
  // window.__qaKeyboard(336) opens one, __qaKeyboard(0) closes it.
  const fake = new EventTarget(); let kb = null;
  Object.defineProperties(fake, {
    height: { get: () => kb ? window.innerHeight - kb.h : window.innerHeight }, width: { get: () => window.innerWidth },
    offsetTop: { get: () => kb ? kb.top : 0 }, offsetLeft: { get: () => 0 }, pageTop: { get: () => window.scrollY + (kb ? kb.top : 0) }, pageLeft: { get: () => 0 }, scale: { get: () => 1 },
  });
  Object.defineProperty(window, 'visualViewport', { value: fake, configurable: true });
  window.__qaKeyboard = (h, top = 0) => { kb = h ? { h, top } : null; fake.dispatchEvent(new Event('resize')); };
}

// Opens the fake keyboard over a focused field and checks the field is above it and the screen's top is still on screen.
async function keyboardCheck(page, KB) {
  // Twice: keyboard over an unmoved page, and Safari's other habit, panning the visual viewport down (offsetTop > 0). Either
  // way the app must fill exactly the visible band and the focused field must be inside it.
  return page.evaluate(async KB => {
    const out = [];
    for (const top of [0, 120]) {
      window.__qaKeyboard(KB, top);
      await new Promise(r => setTimeout(r, 400));
      const el = document.activeElement;
      const visTop = top, visBottom = top + window.innerHeight - KB;
      if (el && /INPUT|TEXTAREA/.test(el.tagName)) {
        const r = el.getBoundingClientRect();
        if (r.bottom > visBottom + 1 || r.top < visTop - 1) out.push(`offset ${top}: focused field at ${Math.round(r.top)}-${Math.round(r.bottom)}, visible ${visTop}-${visBottom}`);
      }
      const body = document.body.getBoundingClientRect();
      if (Math.abs(body.top - visTop) > 2 || Math.abs(body.bottom - visBottom) > 2) out.push(`offset ${top}: app box ${Math.round(body.top)}-${Math.round(body.bottom)}, visible ${visTop}-${visBottom}`);
    }
    window.__qaKeyboard(0);
    await new Promise(r => setTimeout(r, 400));
    const after = document.body.getBoundingClientRect();
    if (Math.abs(after.height - window.innerHeight) > 2 || after.top !== 0) out.push(`after the keyboard closes the app is ${Math.round(after.height)}px at ${Math.round(after.top)}`);
    return out;
  }, KB);
}

async function paintZones(page, ins) {
  await page.evaluate(i => {
    for (const [k, h] of [['top', i.top], ['bottom', i.bottom]]) {
      if (!h) continue;
      const d = document.createElement('div'); d.className = 'qa-zone';
      Object.assign(d.style, { position: 'fixed', left: 0, right: 0, [k]: 0, height: h + 'px', background: 'rgba(255,0,0,.25)', zIndex: 99999, pointerEvents: 'none' });
      document.body.appendChild(d);
    }
  }, ins);
}

// Headless Chromium has no GPU: SwiftShader gives it WebGL, which the Explore map (MapLibre) needs, as every real Android phone has.
const browser = process.env.ANDROID ? await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] }) : await webkit.launch();
const report = [];
let failed = 0;
for (const [phone, { device, insets, kb }] of Object.entries(PHONES)) {
  for (const s of SCREENS) {
    const ctx = await browser.newContext({ ...device, locale: 'en-GB', timezoneId: 'Asia/Bangkok', geolocation: { latitude: 13.7466, longitude: 100.5346 }, permissions: ['geolocation'], colorScheme: process.env.DARK ? 'dark' : 'light' });
    const who = s.who && T[s.who];
    await ctx.route('http://127.0.0.1:4199/**', r => r.continue({ headers: { ...r.request().headers(), 'x-forwarded-for': who?.ip ?? '10.200.0.1' } }));
    await ctx.route(/^https:\/\/(accounts\.google\.com|static\.cloudflareinsights\.com|pagead2|tiles\.openfreemap\.org)/, r => r.abort());
    await ctx.addInitScript(insetsInit, insets);
    if (who) await ctx.addInitScript(t => { localStorage.setItem('tablamigo.tokens', t); localStorage.setItem('tablamigo.adsNotice', '1'); }, JSON.stringify({ accessToken: who.accessToken, refreshToken: who.refreshToken }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)));
    await page.goto(APP + s.path, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !document.getElementById('splash') && document.getElementById('root')?.textContent.trim(), null, { timeout: 20000 }).catch(() => {});
    await sleep(s.wait ?? 1200);
    const file = `${OUT}${phone}-${s.name}.png`;
    let audit = await page.evaluate(auditScript, insets);
    await paintZones(page, insets);
    await page.screenshot({ path: file });
    // Every scroll view at its end: the last thing on the screen must clear the home indicator.
    const scrolled = await page.evaluate(() => { let n = 0; for (const el of document.querySelectorAll('#root *')) { const cs = getComputedStyle(el); if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1 && !el.closest('[data-testid=inverted]')) { el.scrollTop = el.scrollHeight; n++; } } return n; });
    if (scrolled) {
      await sleep(300);
      const end = await page.evaluate(auditScript, insets);
      for (const p of end.problems) if (p.startsWith('tappable') && !audit.problems.includes(p)) audit.problems.push('scrolled to the end: ' + p);
      await page.screenshot({ path: `${OUT}${phone}-${s.name}-end.png` });
      await page.evaluate(() => { for (const el of document.querySelectorAll('#root *')) if (el.scrollTop) el.scrollTop = 0; });
      await sleep(200);
    }
    if (s.focus) {
      const el = page.locator(s.focus).first();
      if (await el.count()) {
        await el.tap().catch(() => {});
        await sleep(600);
        const after = await page.evaluate(auditScript, insets);
        audit.focusProblems = after.problems.filter(p => !audit.problems.includes(p)).map(p => 'after focus: ' + p);
        await page.screenshot({ path: `${OUT}${phone}-${s.name}-focus.png` });
        if (kb) {
          // Screenshot with the keyboard up: grey box where the keyboard would be.
          await page.evaluate(h => { window.__qaKeyboard(h); }, kb);
          await sleep(400);
          await page.evaluate(h => { const d = document.createElement('div'); d.id = 'qa-kb'; Object.assign(d.style, { position: 'fixed', left: 0, right: 0, top: (window.innerHeight - h) + 'px', height: h + 'px', background: 'rgba(60,60,60,.85)', zIndex: 99999 }); document.documentElement.appendChild(d); }, kb);
          await page.screenshot({ path: `${OUT}${phone}-${s.name}-keyboard.png` });
          await page.evaluate(() => { document.getElementById('qa-kb')?.remove(); window.__qaKeyboard(0); });
          await sleep(400);
          audit.focusProblems.push(...await keyboardCheck(page, kb));
        }
      }
    }
    const problems = [...audit.problems, ...(audit.focusProblems ?? []), ...errors.map(e => 'pageerror: ' + e)];
    if (problems.length) failed++;
    report.push({ phone, screen: s.name, url: page.url().replace(APP, ''), shot: file, problems, smallTargets: audit.smallTargets });
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${phone} ${s.name}${problems.length ? '\n   - ' + problems.join('\n   - ') : ''}${audit.smallTargets.length ? `\n   (small targets: ${audit.smallTargets.slice(0, 6).join(' | ')})` : ''}`);
    await ctx.close();
  }
}
await browser.close();
fs.writeFileSync(OUT + 'report.json', JSON.stringify(report, null, 1));
console.log(`\n${report.length - failed}/${report.length} screens clean; shots in ${OUT}`);
process.exit(failed ? 1 : 0);
