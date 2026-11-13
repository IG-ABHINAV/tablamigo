// The home page demo video (build.py DEMO_CUTS) in a real browser, against the built site served the way nginx serves it
// (byte ranges, content-hashed names, the real MIME types), outside requests blocked:
//   - phone and desktop: no video byte before play, on load or on scrolling to it; one poster, the right cut's AVIF; the box
//     never shifts; a tap plays the right cut's AV1 WebM with sound, and the native controls come back
//   - no autoplay anywhere, with or without reduced motion
//   - Safari's path: a browser that cannot load the WebM plays the H.264 MP4
//   - every video file 404s: the poster stays, a line points at the transcript (and takes keyboard focus), no play button, no controls
//   - slow 3G: still nothing before play, the page and the transcript usable; after a tap, a spinner on the poster, no grey panel
//   - JavaScript off: the poster, and on top of it a link to the cut's MP4; every source; the transcript opens
//   python3 apps/web/build.py && PLAYWRIGHT_FROM=<dir with node_modules/playwright> node apps/web/tests/video-browser.mjs
// CHROME_CHANNEL=chrome uses the installed Google Chrome (Playwright's own Chromium otherwise). Exits 1 on any failure.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const require = createRequire((process.env.PLAYWRIGHT_FROM ?? process.cwd()) + '/package.json');
const { chromium } = require('playwright');
const DIST = new URL('../dist', import.meta.url).pathname;

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.webp': 'image/webp',
  '.avif': 'image/avif', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const file = (p) => { try { return fs.statSync(p).isFile() ? p : null; } catch { return null; } };
// infra/nginx/tablamigo, as far as these pages need it: clean URLs, hashed names, byte ranges.
const site = http.createServer((req, res) => {
  const u = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (u.includes('..')) { res.writeHead(400); return res.end(); }
  const f = u === '/' ? DIST + '/index.html' : file(DIST + u) ?? file(DIST + u + '.html');
  if (!f) { res.writeHead(404, { 'content-type': 'text/html' }); return fs.createReadStream(DIST + '/404.html').pipe(res); }
  const size = fs.statSync(f).size;
  const type = TYPES[path.extname(f)] ?? 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range) {
    const start = range[1] ? Number(range[1]) : size - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1, 'accept-ranges': 'bytes' });
    return fs.createReadStream(f, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${site.address().port}`;

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: ok ? '' : detail });
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 };
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const isMedia = (u) => /\.(mp4|webm)$/.test(new URL(u).pathname);

const browser = await chromium.launch(process.env.CHROME_CHANNEL ? { channel: process.env.CHROME_CHANNEL } : {});

async function open(opts = {}, { routes = [], slow = false, js = true, reduced = false } = {}) {
  const ctx = await browser.newContext({ ...opts, javaScriptEnabled: js, serviceWorkers: 'block', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.route('**/*', (r) => (r.request().url().startsWith(BASE) ? r.continue() : r.abort('blockedbyclient')));
  for (const [re, status] of routes) await ctx.route(re, (r) => r.fulfill({ status, body: 'not found' }));
  const page = await ctx.newPage();
  if (slow) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 50_000 });
  }
  const requested = [];
  page.on('request', (r) => { if (r.url().startsWith(BASE + '/video/')) requested.push(new URL(r.url()).pathname); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, requested, errors };
}
const state = (page) => page.locator('[data-demo] video').evaluate((v) => ({
  paused: v.paused, muted: v.muted, controls: v.controls, readyState: v.readyState, networkState: v.networkState,
  src: v.currentSrc ? new URL(v.currentSrc).pathname : '' }));
const poster = (page) => page.locator('[data-demo] img').last().evaluate((i) => ({ src: i.currentSrc ? new URL(i.currentSrc).pathname : '', w: i.naturalWidth, complete: i.complete }));
const box = (page) => page.locator('[data-demo]').evaluate((el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; });
const shifts = (page) => page.evaluate(() => new Promise((resolve) => {
  let sum = 0;
  const target = document.querySelector('[data-demo]');
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if ((e.sources || []).some((s) => s.node && (target.contains(s.node) || s.node.contains(target)))) sum += e.value; })
    .observe({ type: 'layout-shift', buffered: true });
  setTimeout(() => resolve(sum), 400);
}));

for (const [label, opts, cut, wantWidth] of [['phone', PHONE, '540p', 960], ['desktop', DESKTOP, '720p', 1280]]) {
  const { ctx, page, requested, errors } = await open(opts);
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.waitForTimeout(800);
  check(`${label}: no video request on load`, requested.filter((u) => /\.(mp4|webm)$/.test(u)).length === 0, requested.join(' '));
  const before = await box(page);
  check(`${label}: the box is 16:9 before any poster byte`, Math.abs(before.h - (before.w * 9) / 16) <= 1, JSON.stringify(before));
  await page.locator('[data-demo]').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => { const i = document.querySelector('[data-demo] img'); return i.complete && i.naturalWidth > 0; });
  await page.waitForTimeout(800);
  const p = await poster(page);
  check(`${label}: one poster, the ${cut} AVIF, ${wantWidth}px wide`, new RegExp(`tablamigo-demo-${cut}\\.[0-9a-f]{10}\\.avif$`).test(p.src) && p.w === wantWidth
    && requested.length === 1 && requested[0] === p.src, `${JSON.stringify(p)} ${requested.join(' ')}`);
  check(`${label}: still no video request after scrolling to it, and no autoplay`, requested.filter((u) => /\.(mp4|webm)$/.test(u)).length === 0 && (await state(page)).paused,
    requested.join(' '));
  const after = await box(page);
  check(`${label}: the box did not move or resize while the poster loaded`, JSON.stringify(after) === JSON.stringify(before) && (await shifts(page)) === 0,
    `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
  const s0 = await state(page);
  check(`${label}: no native controls (no grey panel) and the play button over the poster until play`, !s0.controls
    && await page.locator('[data-demo] video').getAttribute('controls') === null && await page.locator('[data-demo] button.demo-play').isVisible(), JSON.stringify(s0));
  await page.locator('[data-demo] button.demo-play').click();
  await page.waitForFunction(() => !document.querySelector('[data-demo] video').paused && document.querySelector('[data-demo] video').readyState > 1, null, { timeout: 15_000 }).catch(() => {});
  const s1 = await state(page);
  check(`${label}: a tap plays the ${cut} AV1 WebM with sound, with controls`, !s1.paused && !s1.muted && s1.controls && new RegExp(`tablamigo-demo-${cut}\\.[0-9a-f]{10}\\.webm$`).test(s1.src),
    JSON.stringify(s1));
  check(`${label}: the other cut was never fetched`, !requested.some((u) => u.includes(cut === '540p' ? '-720p.' : '-540p.')), requested.join(' '));
  check(`${label}: focus moved to the video`, await page.evaluate(() => document.activeElement === document.querySelector('[data-demo] video')));
  check(`${label}: no page errors`, errors.length === 0, errors.join(' | '));
  await ctx.close();
}

{ // Reduced motion changes nothing: the video never autoplays anyway.
  const { ctx, page, requested } = await open(DESKTOP, { reduced: true });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.locator('[data-demo]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1500);
  check('reduced motion: no autoplay, no video request', (await state(page)).paused && !requested.some((u) => /\.(mp4|webm)$/.test(u)), requested.join(' '));
  await ctx.close();
}

{ // Safari without AV1: the WebM does not load, so the browser takes the MP4.
  const { ctx, page } = await open(PHONE, { routes: [[/\/video\/.+\.webm$/, 404]] });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.locator('[data-demo]').scrollIntoViewIfNeeded();
  await page.locator('[data-demo] button.demo-play').click();
  await page.waitForFunction(() => { const v = document.querySelector('[data-demo] video'); return !v.paused && v.readyState > 1 && /\.mp4$/.test(v.currentSrc); },
    null, { timeout: 15_000 }).catch(() => {});
  const s = await state(page);
  check('no WebM: the 540p H.264 MP4 plays instead', !s.paused && /tablamigo-demo-540p\.[0-9a-f]{10}\.mp4$/.test(s.src) && (await page.locator('.demo-failed').textContent()) === '', JSON.stringify(s));
  await ctx.close();
}

{ // Every video file 404s.
  const { ctx, page, errors } = await open(PHONE, { routes: [[/\/video\/.+\.(mp4|webm)$/, 404]] });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.locator('[data-demo]').scrollIntoViewIfNeeded();
  const before = await box(page);
  await page.locator('[data-demo] button.demo-play').focus();
  await page.locator('[data-demo] button.demo-play').click();
  await page.waitForFunction(() => document.querySelector('.demo-failed').textContent.length > 0, null, { timeout: 15_000 }).catch(() => {});
  const s = await state(page);
  const p = await poster(page);
  check('all files 404: the failure line shows and points at the transcript', await page.locator('.demo-failed').isVisible()
    && /transcript below/.test(await page.locator('.demo-failed').textContent()), JSON.stringify(s));
  check('all files 404: the poster stays, paused, no play button, no controls, the box unchanged', p.w === 960 && !s.controls && s.paused
    && !(await page.locator('[data-demo] button.demo-play').isVisible()) && JSON.stringify(await box(page)) === JSON.stringify(before), `${JSON.stringify(p)} ${JSON.stringify(s)}`);
  check('all files 404: keyboard focus moved from the button to the status line', await page.evaluate(() => document.activeElement === document.querySelector('.demo-failed')));
  check('all files 404: no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();
}

{ // Slow 3G (400 ms, 400 kb/s).
  const { ctx, page, requested } = await open(PHONE, { slow: true });
  await page.goto(BASE + '/', { waitUntil: 'load', timeout: 120_000 });
  await page.locator('[data-demo]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(3000);
  check('slow 3G: no video request before play', !requested.some((u) => /\.(mp4|webm)$/.test(u)), requested.join(' '));
  check('slow 3G: the play button and the transcript are there', await page.locator('[data-demo] button.demo-play').isVisible() && await page.locator('.demo-transcript').isVisible());
  await page.locator('[data-demo] button.demo-play').click();
  await page.waitForTimeout(300);
  const st = await state(page);
  check('slow 3G: a tap shows a spinner on the poster, with no grey controls panel yet', await page.locator('[data-demo] button.demo-play.loading .demo-spin').isVisible()
    && !st.controls && (await poster(page)).w === 960, JSON.stringify(st));
  await ctx.close();
}

{ // JavaScript off.
  const { ctx, page, requested } = await open(PHONE, { js: false });
  await page.goto(BASE + '/', { waitUntil: 'load' });
  await page.locator('[data-demo]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  const p = await poster(page);
  // What is actually on top at the pill: the <noscript> link to the 540p MP4 (the phone cut), not a grey panel.
  const hit = await page.locator('[data-demo]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const a = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('a');
    return a ? new URL(a.href).pathname : null;
  });
  check('no JS: the poster shows, with a link to the phone cut\'s MP4 over it', p.w === 960 && hit === '/video/tablamigo-demo-540p.mp4', `${JSON.stringify(p)} ${hit}`);
  // Under the link, the top element must be the <noscript> poster, placed after the <video> (Chrome shows native controls with
  // JS off, and their grey panel covers anything behind the video).
  const stack = await page.locator('[data-demo]').evaluate((el) => {
    const r = el.getBoundingClientRect();
    const top = document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).find((e) => !e.closest('a'));
    const video = el.querySelector('video');
    return { tag: top?.tagName, afterVideo: !!(top && video.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING), w: top?.naturalWidth };
  });
  check('no JS: under the link, the poster is on top of the video (not its grey controls panel)', stack.tag === 'IMG' && stack.afterVideo && stack.w === 960, JSON.stringify(stack));
  check('no JS: no JS play button, no grey controls panel, four sources', !(await page.locator('[data-demo] button.demo-play').isVisible())
    && await page.locator('[data-demo] video').getAttribute('controls') === null && (await page.locator('[data-demo] video source').count()) === 4);
  check('no JS: no video request before play', !requested.some((u) => /\.(mp4|webm)$/.test(u)), requested.join(' '));
  await page.locator('.demo-transcript summary').click();
  check('no JS: the transcript opens', await page.locator('.demo-transcript li').first().isVisible());
  await ctx.close();
}

{ // Files are served as nginx serves them: ranges and the right type.
  for (const u of fs.readdirSync(DIST + '/video').filter((f) => /\.[0-9a-f]{10}\.(mp4|webm)$/.test(f))) {
    const r = await fetch(`${BASE}/video/${u}`, { headers: { range: 'bytes=0-1023' } });
    check(`/video/${u}: 206 with the right type`, r.status === 206 && r.headers.get('content-type') === TYPES[path.extname(u)], `${r.status} ${r.headers.get('content-type')}`);
    await r.arrayBuffer();
  }
}

await browser.close();
site.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : ` — ${r.detail}`}`);
console.log(`demo video browser checks: ${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
