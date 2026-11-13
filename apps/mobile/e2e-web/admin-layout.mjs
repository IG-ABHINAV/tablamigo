// Admin panel layout pass (apps/web/src/admin.html) at phone, tablet and desktop widths, in WebKit, against the local stack
// that drive.mjs uses (static.mjs started with ADMIN_HTML, API on :4199, admin@qa.test). Same rules as iphone.mjs
// (lib: layout-audit.mjs): no sideways page overflow, no text field under 16px on the phone, small tap targets reported.
//   node admin-layout.mjs [shots-dir]      (exit 1 when any tab breaks a rule)
// Local only, like iphone.mjs: not in CI (the self-hosted runner has no WebKit). Each size gets its own X-Forwarded-For so
// the three sign-ins don't share the API's login rate-limit bucket (the API trusts that header, as drive.mjs relies on).
// The admin page's string checks run in CI (apps/web/tests/test_site.py AdminOnPhones, AdminUserSourceFilter); this is the
// rendered check, including the Users source filter's count and the Host tab's Create plan form (opened, never submitted).
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { auditScript } from './layout-audit.mjs';
const require = createRequire((process.env.PLAYWRIGHT_FROM ?? process.env.HOME + '/Desktop/hookpost') + '/package.json');
const { webkit, devices } = require('playwright');
const OUT = process.argv[2] ?? new URL('./out/admin/', import.meta.url).pathname; fs.mkdirSync(OUT, { recursive: true });
const MAIL = new URL('./out/mail.jsonl', import.meta.url).pathname;
const API = 'http://127.0.0.1:4199';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SIZES = { phone: devices['iPhone 15 Pro'], tablet: devices['iPad Mini'], desktop: { viewport: { width: 1440, height: 900 } } };
const TABS = ['Overview', 'Users', 'Plans', 'Trips', 'Host', 'Reports', 'Verifications', 'Tickets', 'Subscriptions', 'Emails', 'Activation Funnel'];
const b = await webkit.launch();
let failed = 0;
for (const [size, dev] of Object.entries(SIZES)) {
  const ctx = await b.newContext(dev); const p = await ctx.newPage();
  // The local copy of admin.html talks to localhost:4100; send it to the test API.
  await p.route('http://localhost:4100/**', async r => {
    const resp = await fetch(r.request().url().replace('http://localhost:4100', API), { method: r.request().method(), headers: { ...r.request().headers(), 'x-forwarded-for': '10.98.' + (size.length) + '.9' }, body: r.request().postDataBuffer() ?? undefined });
    await r.fulfill({ status: resp.status, headers: Object.fromEntries(resp.headers), body: Buffer.from(await resp.arrayBuffer()) });
  });
  await p.goto('http://127.0.0.1:8099/admin');
  const before = fs.existsSync(MAIL) ? fs.readFileSync(MAIL, 'utf8').length : 0;
  await p.locator('input[type="email"]').first().fill('admin@qa.test');
  await p.locator('button').filter({ hasText: /code|Send|Continue/i }).first().click();
  let code = null; for (let i = 0; i < 40 && !code; i++) { await sleep(250); code = fs.readFileSync(MAIL, 'utf8').slice(before).split('\n').filter(Boolean).map(l => JSON.parse(l)).filter(m => m.to === 'admin@qa.test').at(-1)?.subject.match(/(\d{6})/)?.[1]; }
  if (!code) throw new Error('no admin code email');
  const codeField = p.locator('input').filter({ hasNot: p.locator('[type="email"]') }).last();
  const loginAudit = await p.evaluate(auditScript, { top: 0, bottom: 0 });
  await codeField.fill(code);
  await p.locator('button').filter({ hasText: /Sign in|Verify|Continue/i }).first().click();
  await sleep(2500);
  for (const tab of ['Sign in', ...TABS]) {
    if (tab !== 'Sign in') { await p.locator('nav.tabs').getByText(new RegExp('^' + tab)).first().click(); await sleep(1200); }
    const a = tab === 'Sign in' ? loginAudit : await p.evaluate(auditScript, { top: 0, bottom: 0 });
    // Admin is a desktop tool: the 16px rule only matters on the phone.
    const problems = a.problems.filter(x => size === 'phone' || !x.startsWith('text field'));
    // Phone: tables are stacked cards, so no table may be wider than the screen.
    if (size === 'phone') { const wide = await p.evaluate(() => [...document.querySelectorAll('table')].filter(t => t.offsetParent && t.getBoundingClientRect().width > innerWidth + 1).length); if (wide) problems.push(wide + ' table(s) wider than the screen'); }
    // Phone: every button is at least 44px tall (Sign out was 28 until 2 Nov 2026).
    if (size === 'phone') { const low = await p.evaluate(() => [...document.querySelectorAll('.btn')].filter(b => b.offsetParent && b.getBoundingClientRect().height < 43.5).map(b => b.textContent.trim().slice(0, 20))); if (low.length) problems.push('buttons under 44px: ' + low.slice(0, 4).join(', ')); }
    // Users: the acquisition source filter is the API's, so "1–N of T" counts the filtered rows (it said "1–0 of 26").
    if (tab === 'Users') {
      await p.locator('#u-src').selectOption('Direct'); await sleep(900);
      const rows = await p.locator('#u-table tr[data-id]').count(), cnt = await p.locator('#u-count').innerText();
      const m = cnt.match(/^1–(\d+) of (\d+)$/);
      if (!rows || !m || +m[1] !== rows || +m[2] !== rows) problems.push(`source=Direct shows ${rows} rows, count "${cnt}"`);
      await p.locator('#u-src').selectOption('Google Play'); await sleep(900);
      if (await p.locator('#u-count').innerText() !== '' || await p.locator('#u-table tr[data-id]').count()) problems.push('source=Google Play should be empty here');
      await p.locator('#u-src').selectOption(''); await sleep(600);
      // An old bookmark with a source the list no longer has falls back to all sources (the API would answer 400).
      await p.evaluate(() => { location.hash = '#users?source=Founder'; }); await sleep(1200);
      if (/Couldn't load/.test(await p.locator('#view').innerText()) || await p.locator('#u-src').inputValue() !== '') problems.push('#users?source=Founder did not fall back to all sources');
      await p.evaluate(() => { location.hash = '#users'; }); await sleep(800);
    }
    // Host: the "Create plan as Tablamigo team" form opens and finds a place (never submitted here).
    if (tab === 'Host') {
      await p.locator('#np-q').fill('Clear Cafe Ubud'); await p.locator('#np-search').click(); await sleep(1200);
      if (!await p.locator('#np-places').isVisible()) problems.push('Create plan: the place search shows no list');
      await p.locator('#h-np').scrollIntoViewIfNeeded();
      const f = await p.evaluate(auditScript, { top: 0, bottom: 0 });
      problems.push(...f.problems.filter(x => (size === 'phone' || !x.startsWith('text field')) && !x.startsWith('window scrolled') && !problems.includes(x)));   // the admin page scrolls; the app's rule does not apply
    }
    if (problems.length) failed++;
    if (tab !== 'Sign in') await p.screenshot({ path: `${OUT}${size}-${tab.toLowerCase().replace(/ /g, '-')}.png`, fullPage: false });
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${size} ${tab}${problems.length ? '\n   - ' + problems.join('\n   - ') : ''}`);
  }
  await ctx.close();
}
await b.close();
process.exit(failed ? 1 : 0);
