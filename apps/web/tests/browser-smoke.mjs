// The built website in real headless Chromium, served the way nginx serves it (clean URLs, hashed assets, 404 page). Every
// sitemap page plus the 404 and /admin at phone and desktop width: no JavaScript error, no failed same-site request, one h1,
// nothing wider than the screen on a phone, and the Meta-ad redirect on /download really navigates to Google Play.
// Outside requests (fonts, Google, Cloudflare) are blocked, so the run is offline and never touches production.
//   python3 apps/web/build.py && PLAYWRIGHT_FROM=<dir with node_modules/playwright> node apps/web/tests/browser-smoke.mjs
// Writes apps/web/tests/out/browser-smoke.json (+ screenshots of failures) and exits 1 on any failure.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require = createRequire((process.env.PLAYWRIGHT_FROM ?? process.cwd()) + '/package.json');
const { chromium } = require('playwright');
const WEB = new URL('..', import.meta.url).pathname;
const OUT = new URL('./out/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });

// A stand-in for infra/nginx/tablamigo's website server block: try_files $uri $uri.html $uri/, hashed asset names
// (name.<10 hex>.ext) fall back to the plain file, /admin is admin.html, and anything else is 404.html with status 404.
// (serve.py does the same for previews but answers the 404 page with 200 and drops connections under parallel loads.)
const DIST = WEB + 'dist';
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain', '.xml': 'application/xml' };
const file = p => { try { return fs.statSync(p).isFile() ? p : null; } catch { return null; } };
const site = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u.includes('..')) { res.writeHead(400); return res.end(); }
  const hashed = u.match(/^(.+)\.[0-9a-f]{10}(\.(?:png|svg|webp|woff2))$/i);
  const found = u === '/admin' ? file(DIST + '/admin.html')
    : file(DIST + u) ?? file(DIST + u + '.html') ?? file(DIST + u + '/index.html') ?? (hashed ? file(DIST + hashed[1] + hashed[2]) : null);
  const f = u === '/' ? DIST + '/index.html' : found;
  const served = f ?? DIST + '/404.html';
  res.writeHead(f ? 200 : 404, { 'content-type': TYPES[path.extname(served)] ?? 'application/octet-stream' });
  fs.createReadStream(served).pipe(res);
});
await new Promise(r => site.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${site.address().port}`;

const SITE = 'https://tablamigo.hookstep.in';
const sitemap = fs.readFileSync(WEB + 'dist/sitemap.xml', 'utf8');
const paths = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(m => m[1].slice(SITE.length) || '/');
const results = [];
const fail = (page, size, what) => results.push({ page, size, ok: false, what });

const browser = await chromium.launch(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {});  // CHROME_CHANNEL=chrome: the installed Google Chrome
for (const [size, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1440, height: 900 }]]) {
  const ctx = await browser.newContext({ viewport, isMobile: size === 'phone', hasTouch: size === 'phone', serviceWorkers: 'block' });
  await ctx.route('**/*', r => (r.request().url().startsWith(BASE) ? r.continue() : r.abort('blockedbyclient')));
  for (const p of [...paths, '/this-page-does-not-exist', '/admin']) {
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
    page.on('console', m => { if (m.type() === 'error' && !/ERR_BLOCKED_BY_CLIENT|net::ERR_FAILED|Failed to load resource/.test(m.text())) problems.push(`console: ${m.text()}`); });
    // ERR_ABORTED: a lazy image still loading when the page is closed, not a broken file.
    page.on('requestfailed', r => { if (r.url().startsWith(BASE) && !/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) problems.push(`failed: ${r.url()} ${r.failure()?.errorText}`); });
    page.on('response', r => { if (r.url().startsWith(BASE) && r.status() >= 400 && r.url() !== BASE + p) problems.push(`HTTP ${r.status()}: ${r.url()}`); });
    const res = await page.goto(BASE + p, { waitUntil: 'load' });
    const expected = p === '/this-page-does-not-exist' ? 404 : 200;
    if (res.status() !== expected) problems.push(`status ${res.status()} (want ${expected})`);
    if (expected === 404 && !/noindex/.test((await page.locator('meta[name=robots]').getAttribute('content').catch(() => '')) ?? '')) problems.push('unknown path did not get the noindex 404 page');
    if (p !== '/admin') {
      const h1 = await page.locator('h1').count();
      if (h1 !== 1) problems.push(`${h1} h1 elements`);
    }
    if (size === 'phone') {
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (over > 1) problems.push(`page is ${over}px wider than the phone screen`);
    }
    if (problems.length) {
      fail(p, size, problems.join(' | '));
      await page.screenshot({ path: `${OUT}${size}-${p.replace(/\W+/g, '_') || 'home'}.png`, fullPage: false }).catch(() => {});
    } else results.push({ page: p, size, ok: true });
    await page.close();
  }

  // A visitor from a Meta ad lands on /download and is sent on to Google Play (location.replace), with the campaign.
  const page = await ctx.newPage();
  const navs = [];
  page.on('request', r => { if (r.isNavigationRequest()) navs.push(r.url()); });
  await page.goto(BASE + '/download?utm_source=instagram&utm_medium=paid&utm_campaign=qa', { waitUntil: 'load' }).catch(() => {});
  await page.waitForTimeout(300);
  const play = navs.find(u => u.startsWith('https://play.google.com/store/apps/details?id=com.tablamigo.app'));
  if (!play || !decodeURIComponent(play).includes('utm_source=instagram') || !decodeURIComponent(play).includes('utm_content=ad_redirect')) fail('/download?utm_source=instagram', size, `no redirect to Play with the campaign (navigations: ${navs.join(', ')})`);
  else results.push({ page: '/download?utm_source=instagram', size, ok: true });
  await page.close();

  // A friend's invite link (API GET /me/referral): the Play button carries the code in the install referrer, the web-app button in ?ref=.
  const inv = await ctx.newPage();
  await inv.goto(BASE + '/invite?code=ab12cd34', { waitUntil: 'load' });
  const playHref = await inv.getAttribute('#invite-play', 'href');
  const webHref = await inv.getAttribute('#invite-web', 'href');
  const shown = await inv.textContent('#invite-code');
  const ir = new URL(playHref).searchParams.get('referrer') ?? '';
  if (new URLSearchParams(ir).get('ref') !== 'AB12CD34' || new URLSearchParams(ir).get('utm_source') !== 'invite'
    || webHref !== '/app/?ref=AB12CD34&utm_source=invite&utm_medium=referral' || shown !== 'AB12CD34') fail('/invite?code=', size, `invite links not personalised: ${playHref} | ${webHref} | ${shown}`);
  else results.push({ page: '/invite?code=', size, ok: true });
  await inv.goto(BASE + '/invite?code=%3Cscript%3E', { waitUntil: 'load' });
  if (!(await inv.isHidden('#invite-code-line')) || (await inv.getAttribute('#invite-web', 'href')) !== '/app/') fail('/invite?code=<junk>', size, 'a junk code was used');
  else results.push({ page: '/invite?code=<junk>', size, ok: true });
  await inv.close();
  await ctx.close();
}
await browser.close();
site.close();

const failed = results.filter(r => !r.ok);
fs.writeFileSync(OUT + 'browser-smoke.json', JSON.stringify({ at: new Date().toISOString(), total: results.length, failed: failed.length, results }, null, 1));
for (const r of failed) console.log(`FAIL ${r.size} ${r.page}: ${r.what}`);
console.log(`website browser smoke: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
