// Google AdSense end to end, in real headless Chromium, on the PRODUCTION builds: the website from apps/web/dist (build.py) and
// the web app from an Expo web export, both served under https://tablamigo.hookstep.in through Playwright's request routing
// (the same paths nginx serves: clean URLs, /app/ as a single-page app). Nothing reaches the internet: Google's ad script is
// answered with a stub that records it ran, Cloudflare's /cdn-cgi/trace answers the country each case needs, and every other
// outside request is blocked.
//   - a full city guide and a how-to guide load Google's ad script after the first interaction, never during the page load;
//   - both consent states (build.py ADSENSE_CMP): with AdSense's consent message on, every country gets the script and no country
//     lookup is made (Google's message asks in the EEA, the UK and Switzerland); with it off, those countries and an unknown one get none;
//   - the home, download, privacy, safety, comparison and hub pages, a thin guide and the web app at /app/ never load it, and the
//     web app's own code carries no AdSense at all.
//   python3 apps/web/build.py
//   (cd apps/mobile && env -u EXPO_PUBLIC_API_URL npx expo export -p web --output-dir web-build)   # what infra/deploy.sh app ships
//   PLAYWRIGHT_FROM=<dir with node_modules/playwright> [APP_DIR=<export dir>] node apps/web/tests/ads-browser.mjs
// Writes apps/web/tests/out/ads-browser.json (+ screenshots of failures) and exits 1 on any failure.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const require = createRequire((process.env.PLAYWRIGHT_FROM ?? process.cwd()) + '/package.json');
const { chromium } = require('playwright');
const WEB = new URL('..', import.meta.url).pathname;
const DIST = WEB + 'dist';
const APP = path.resolve(process.env.APP_DIR ?? WEB + '../mobile/web-build');
const OUT = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
for (const [dir, how] of [[DIST, 'python3 apps/web/build.py'], [APP, 'the Expo web export (see the header of this file), or set APP_DIR']]) {
  if (!fs.existsSync(path.join(dir, 'index.html'))) { console.error(`missing ${dir}/index.html: run ${how}`); process.exit(1); }
}

const SITE = 'https://tablamigo.hookstep.in';
const BUILD = fs.readFileSync(WEB + 'build.py', 'utf8');
const CLIENT = BUILD.match(/^ADSENSE_CLIENT = "([^"]+)"/m)[1];
// Both consent states run: the shipped one (build.py ADSENSE_CMP) as built, and the other by swapping the loader in the served HTML
// for build.py's adsense_js() of that state, so a flip of the switch is already tested.
const LOADERS = JSON.parse(spawnSync('python3', ['-c',
  'import sys,json; sys.path.insert(0, sys.argv[1]); import build as b; print(json.dumps({"true": b.adsense_js(True), "false": b.adsense_js(False), "cmp": b.ADSENSE_CMP}))',
  WEB], { encoding: 'utf8' }).stdout);
const SHIPPED = LOADERS.cmp;
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json' };
const file = p => { try { return fs.statSync(p).isFile() ? p : null; } catch { return null; } };

/** What nginx (infra/nginx/tablamigo) would answer for a path on the site: [file, status]. */
function resolve(u) {
  if (u === '/app') return [null, 301];
  if (u.startsWith('/app/')) {
    const rest = u.slice('/app/'.length);
    return [file(path.join(APP, rest)) ?? file(path.join(APP, rest, 'index.html')) ?? path.join(APP, 'index.html'), 200];
  }
  const hashed = u.match(/^(.+)\.[0-9a-f]{10}(\.(?:png|svg|webp|woff2))$/i);
  const f = u === '/' ? DIST + '/index.html'
    : file(DIST + u) ?? file(DIST + u + '.html') ?? file(DIST + u + '/index.html') ?? (hashed ? file(DIST + hashed[1] + hashed[2]) : null);
  return f ? [f, 200] : [DIST + '/404.html', 404];
}

const results = [];
const browser = await chromium.launch();

/**
 * Opens a page as a visitor from `country`, does `act` (interactions), and reports what ad traffic happened.
 * adScript: requests for Google's ad script; trace: country checks; ranAds: the stub's own count of runs on the page.
 */
async function visit(p, { country = 'IN', act = 'scroll', size = 'phone', cmp = SHIPPED } = {}) {
  const viewport = size === 'phone' ? { width: 390, height: 844 } : { width: 1440, height: 900 };
  const ctx = await browser.newContext({ viewport, isMobile: size === 'phone', hasTouch: size === 'phone', serviceWorkers: 'block' });
  const seen = { adScript: [], trace: 0, otherAds: [], scripts: [] };
  const problems = [];
  await ctx.route('**/*', async r => {
    const url = new URL(r.request().url());
    if (url.origin === SITE) {
      if (url.pathname === '/cdn-cgi/trace') { seen.trace++; return r.fulfill({ status: 200, contentType: 'text/plain', body: `fl=1\nh=tablamigo.hookstep.in\nloc=${country}\nvisit_scheme=https\n` }); }
      const [f, status] = resolve(decodeURIComponent(url.pathname));
      if (status === 301) return r.fulfill({ status, headers: { location: SITE + '/app/' } });
      let body = fs.readFileSync(f);
      if (cmp !== SHIPPED && f.endsWith('.html') && f.startsWith(DIST)) {
        const html = body.toString('utf8');
        const swapped = html.replace(LOADERS[String(SHIPPED)], LOADERS[String(cmp)]);
        if (html.includes('adsbygoogle.js') && swapped === html) problems.push('could not swap the loader for the other consent state');
        body = swapped;
      }
      return r.fulfill({ status, contentType: TYPES[path.extname(f)] ?? 'application/octet-stream', body });
    }
    if (url.hostname === 'pagead2.googlesyndication.com' && url.pathname === '/pagead/js/adsbygoogle.js') {
      seen.adScript.push(url.href);
      return r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.__adsenseRuns=(window.__adsenseRuns||0)+1;' });
    }
    if (/googlesyndication|doubleclick|adservice\.google|googleadservices|adtrafficquality/.test(url.hostname)) seen.otherAds.push(url.href);
    return r.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  page.on('response', async res => {
    if (res.url().startsWith(SITE) && /javascript/.test(res.headers()['content-type'] ?? '')) seen.scripts.push(await res.text().catch(() => ''));
  });
  page.on('pageerror', e => { if (!p.startsWith('/app')) problems.push(`pageerror: ${e.message}`); });
  const res = await page.goto(SITE + p, { waitUntil: 'load' });
  if (res.status() !== 200) problems.push(`HTTP ${res.status()}`);
  // A page load with no interaction: nothing ad-related may happen (Core Web Vitals, and no ads for a visitor who never engages).
  await page.waitForTimeout(1500);
  const beforeInteraction = { adScript: seen.adScript.length, trace: seen.trace };
  // Taps land on the heading (never a link, so the visit stays on this page); the web app has none, so it gets a pointerdown.
  const tap = async () => {
    const h1 = page.locator('h1').first();
    if (await h1.count()) await h1.click({ position: { x: 4, y: 4 } });
    else await page.evaluate(() => document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
  };
  if (act === 'scroll') await page.mouse.wheel(0, 600);
  if (act === 'tap') await tap();
  if (act === 'all') {
    await page.mouse.wheel(0, 600);
    await tap();
    await page.keyboard.press('Shift');
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  }
  await page.waitForTimeout(2500);
  // The web app routes a signed-out visitor to /app/welcome by itself; anywhere else, the page must not have changed.
  const now = new URL(page.url()).pathname;
  if (p.startsWith('/app') ? !now.startsWith('/app/') : now !== new URL(SITE + p).pathname) problems.push(`the interaction navigated away, to ${page.url()}`);
  const ranAds = await page.evaluate(() => window.__adsenseRuns ?? 0).catch(() => 0);
  const tag = await page.evaluate(() => {
    const s = document.querySelector('script[src*="adsbygoogle.js"]');
    return s && { async: s.async, crossOrigin: s.crossOrigin, inHead: s.parentNode === document.head };
  }).catch(() => null);
  await ctx.close().catch(() => {});
  return { ...seen, beforeInteraction, ranAds, tag, problems };
}

async function expect(name, p, opts, check) {
  const v = await visit(p, opts);
  const why = [...v.problems, ...check(v)].filter(Boolean);
  results.push({ name, page: p, ...opts, ok: !why.length, what: why.join(' | ') || undefined });
}
const loadsAds = v => [
  v.beforeInteraction.adScript || v.beforeInteraction.trace ? 'an ad request or country check happened before any interaction' : '',
  v.adScript.length !== 1 ? `${v.adScript.length} requests for Google's ad script after the interaction (want 1)` : '',
  v.adScript[0] && new URL(v.adScript[0]).searchParams.get('client') !== CLIENT ? `wrong client: ${v.adScript[0]}` : '',
  v.ranAds !== 1 ? `the ad script ran ${v.ranAds} times (want 1)` : '',
  !v.tag?.async || v.tag?.crossOrigin !== 'anonymous' || !v.tag?.inHead ? `the script tag is not async, crossorigin=anonymous, in <head>: ${JSON.stringify(v.tag)}` : '',
  v.otherAds.length ? `other ad requests: ${v.otherAds.slice(0, 3).join(', ')}` : '',
];
const noAds = v => [
  v.adScript.length ? `requested Google's ad script: ${v.adScript[0]}` : '',
  v.ranAds ? 'an ad script ran' : '',
  v.tag ? 'an AdSense script tag is on the page' : '',
  v.otherAds.length ? `other ad requests: ${v.otherAds.slice(0, 3).join(', ')}` : '',
];

const noTrace = v => (v.trace ? [`${v.trace} country checks (want none with the consent message on)`] : []);
for (const [size, cmp] of [['phone', SHIPPED], ['desktop', SHIPPED], ['phone', !SHIPPED]]) {
  const state = cmp ? 'consent message on' : 'consent message off';
  // Content pages: the ad script loads after the first interaction.
  await expect(`${state}: full city guide, India, scroll`, '/solo-travel/goa', { size, cmp, country: 'IN', act: 'scroll' },
    v => [...loadsAds(v), ...(cmp ? noTrace(v) : v.trace !== 1 ? [`${v.trace} country checks (want 1)`] : [])]);
  await expect(`${state}: how-to guide, US, tap`, '/how-to-meet-people-in-hostels', { size, cmp, country: 'US', act: 'tap' },
    v => [...loadsAds(v), ...(cmp ? noTrace(v) : [])]);
  // Consent. Message on: the script loads everywhere and Google's message asks in the EEA, the UK and Switzerland, with no country
  // lookup. Message off: those countries, and an unknown one, get nothing.
  for (const country of ['DE', 'GB', 'CH', 'XX']) {
    await expect(`${state}: full city guide, ${country}`, '/solo-travel/rishikesh', { size, cmp, country, act: 'all' },
      cmp ? v => [...loadsAds(v), ...noTrace(v)] : v => [...noAds(v), v.trace !== 1 ? `${v.trace} country checks (want 1)` : '']);
  }
  // Never: the app, the money and trust pages, a thin guide, the hub.
  for (const p of ['/', '/download', '/privacy', '/terms', '/safety', '/about', '/partnerships', '/nomadtable-alternative', '/travel-buddy-app',
    '/solo-female-travel-india', '/solo-travel', '/solo-travel/paris', '/app/']) {
    await expect(`${state}: no ads`, p, { size, cmp, country: 'IN', act: 'all' }, v => [...noAds(v), v.trace ? 'asked Cloudflare for the country' : '',
      p.startsWith('/app') && v.scripts.some(s => /adsbygoogle|googlesyndication|ca-pub-\d/.test(s)) ? 'the web app bundle carries AdSense code' : '',
      p.startsWith('/app') && !v.scripts.length ? 'the web app loaded no JavaScript (is APP_DIR an Expo web export?)' : '']);
  }
}
// The web app's deep routes are the same single page: a signed-out visitor on a chat or plan link sees no ads either.
for (const p of ['/app/chat/123', '/app/activity/abc', '/app/sign-in']) await expect('no ads in the web app', p, { country: 'IN', act: 'all' }, noAds);

await browser.close();
const failed = results.filter(r => !r.ok);
fs.writeFileSync(OUT + 'ads-browser.json', JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 1));
for (const r of failed) console.log(`FAIL ${r.size ?? 'phone'} ${r.page} (${r.name}): ${r.what}`);
console.log(`ads browser e2e: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
