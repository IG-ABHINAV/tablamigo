// The Play-link script every marketing page carries (build.py PLAY_JS), run from the BUILT page in a small fake browser, so
// what is tested is exactly what ships. Meta ads send their traffic to /download, so this is the money path:
//  - a visitor's utm_* go into Play's install referrer (Play Console attributes the install to the campaign), and stay for
//    the rest of the visit (sessionStorage);
//  - on Android every Play link becomes an intent:// link (opens the Play Store app from in-app browsers);
//  - a visitor from a Meta ad landing on /download goes straight on to Play (owner's call, 14 Oct 2026), and nowhere else.
//   node --test apps/web/tests/play-links.test.mjs      (after python3 apps/web/build.py)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const DIST = new URL('../dist/', import.meta.url);
const html = name => fs.readFileSync(new URL(name, DIST), 'utf8');
const unescape = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"');
const PLAY = 'https://play.google.com/store/apps/details?id=com.tablamigo.app';

/** The PLAY_JS inline script of a built page. */
function playScript(page) {
  const s = [...html(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes("'tm_utm'"));
  assert.ok(s, `${page} carries the Play-link script`);
  return s;
}

/** Runs a page's script; returns its Play links after the run, where it redirected to, and sessionStorage. */
function visit(page, { path = '/' + page.replace(/\.html$/, '').replace(/^index$/, ''), search = '', android = false, storage = new Map(), storageThrows = false, cookie = '' } = {}) {
  const anchors = [...html(page).matchAll(/<a\b[^>]*href="([^"]*play\.google\.com\/store\/apps\/details\?id=com\.tablamigo\.app[^"]*)"[^>]*>/g)].map(m => {
    const placement = m[0].match(/data-placement="([^"]*)"/)?.[1] ?? null;
    return { href: unescape(m[1]), getAttribute: n => (n === 'data-placement' ? placement : null) };
  });
  let replacedTo = null;
  const sessionStorage = {
    getItem: k => { if (storageThrows) throw new Error('SecurityError'); return storage.has(k) ? storage.get(k) : null; },
    setItem: (k, v) => { if (storageThrows) throw new Error('SecurityError'); storage.set(k, String(v)); },
  };
  const ctx = vm.createContext({
    URL, URLSearchParams, sessionStorage,
    location: { search, pathname: path, hostname: 'tablamigo.hookstep.in', replace: u => { replacedTo = u; } },
    navigator: { userAgent: android ? 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141 Mobile Safari/537.36 Instagram 350.0' : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 Safari/605.1.15' },
    document: { cookie, querySelectorAll: sel => { assert.match(sel, /play\.google\.com\/store\/apps\/details\?id=com\.tablamigo\.app/); return anchors; } },
  });
  vm.runInContext(playScript(page), ctx);
  return { links: anchors.map(a => a.href), replacedTo, storage, cookie: ctx.document.cookie };
}
const referrerOf = href => new URLSearchParams(new URL(href).searchParams.get('referrer') ?? '');

test('every marketing page with a Play link carries the script', () => {
  for (const f of fs.readdirSync(DIST).filter(f => f.endsWith('.html'))) {
    const body = html(f);
    if (body.includes(PLAY) && !['admin.html'].includes(f)) assert.ok(body.includes("'tm_utm'"), `${f} has Play links but no Play-link script`);
  }
});

test('no utm, desktop: links keep the website referrer and stay https', () => {
  const { links, replacedTo } = visit('download.html');
  assert.ok(links.length >= 2);
  for (const l of links) {
    assert.ok(l.startsWith(PLAY), l);
    const r = referrerOf(l);
    assert.equal(r.get('utm_source'), 'website');
    assert.equal(r.get('utm_campaign'), 'play_badge');
  }
  assert.equal(replacedTo, null);
});

test('a campaign visit: utm_* go into every link\'s install referrer with the link\'s placement, and are remembered', () => {
  const storage = new Map();
  const { links } = visit('index.html', { search: '?utm_source=newsletter&utm_medium=email&utm_campaign=oct_drop&fbclid=x', storage });
  for (const l of links) {
    const r = referrerOf(l);
    assert.equal(r.get('utm_source'), 'newsletter');
    assert.equal(r.get('utm_medium'), 'email');
    assert.equal(r.get('utm_campaign'), 'oct_drop');
    assert.ok(r.get('utm_content'), 'placement recorded');
    assert.equal(r.get('fbclid'), null);
  }
  assert.deepEqual(JSON.parse(storage.get('tm_utm')), { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: 'oct_drop' });
  // The next page in the same visit, without utm in its URL, still credits the campaign.
  const next = visit('about.html', { storage });
  for (const l of next.links) assert.equal(referrerOf(l).get('utm_source'), 'newsletter');
});

test('Android: Play links open the Play Store app (intent://) with the https link as the fallback', () => {
  const { links } = visit('download.html', { android: true, search: '?utm_source=google&utm_medium=cpc&utm_campaign=search' });
  for (const l of links) {
    assert.match(l, /^intent:\/\/details\?id=com\.tablamigo\.app&referrer=/);
    assert.match(l, /#Intent;scheme=market;package=com\.android\.vending;S\.browser_fallback_url=/);
    assert.match(l, /;end$/);
    const fallback = decodeURIComponent(l.match(/S\.browser_fallback_url=([^;]+)/)[1]);
    assert.ok(fallback.startsWith(PLAY));
    assert.equal(referrerOf(fallback).get('utm_source'), 'google');
    assert.equal(new URLSearchParams(decodeURIComponent(l.match(/referrer=([^#]+)#/)[1])).get('utm_campaign'), 'search');
  }
});

for (const source of ['meta', 'facebook', 'fb', 'instagram', 'ig', 'Meta_Ads', 'facebook-feed', 'ig.story', 'meta reels']) {
  test(`a Meta ad visit (utm_source=${source}) on /download goes straight on to Play with the campaign`, () => {
    for (const path of ['/download', '/download.html', '/download/']) {
      const { replacedTo } = visit('download.html', { path, search: `?utm_source=${encodeURIComponent(source)}&utm_medium=paid&utm_campaign=c1` });
      assert.ok(replacedTo, `${path}: redirected`);
      assert.ok(replacedTo.startsWith(PLAY + '&referrer='), replacedTo);
      const r = referrerOf(replacedTo);
      assert.equal(r.get('utm_source'), source);
      assert.equal(r.get('utm_campaign'), 'c1');
      assert.equal(r.get('utm_content'), 'ad_redirect');
    }
  });
}

test('no redirect: a Meta visit on any other page, a non-Meta source on /download, or look-alike sources', () => {
  assert.equal(visit('index.html', { search: '?utm_source=meta' }).replacedTo, null);
  assert.equal(visit('about.html', { search: '?utm_source=instagram' }).replacedTo, null);
  for (const s of ['google', 'metaverse', 'figma', 'big', 'newsletter_ig']) assert.equal(visit('download.html', { search: `?utm_source=${s}` }).replacedTo, null, s);
  // A remembered Meta visit does not redirect later pages: only the ad's own landing does.
  const storage = new Map([['tm_utm', JSON.stringify({ utm_source: 'meta' })]]);
  assert.equal(visit('download.html', { storage }).replacedTo, null);
});

test('private mode (sessionStorage throws): links still work and the Meta redirect still happens', () => {
  const plain = visit('download.html', { storageThrows: true, search: '?utm_source=reddit' });
  for (const l of plain.links) assert.equal(referrerOf(l).get('utm_source'), 'reddit');
  assert.ok(visit('download.html', { storageThrows: true, search: '?utm_source=meta' }).replacedTo);
});

// Creator partners (apps/api/src/lib/affiliate-ledger.ts): ?ref=CODE is remembered in the tm_aff cookie and carried into Play's
// install referrer as ref=CODE, so the app's sign-up is attributed to the partner.
test('partner link: ?ref= sets the tm_aff cookie for 60 days and every Play link carries ref + utm_source=affiliate', () => {
  const { links, cookie } = visit('index.html', { search: '?ref=raj1' });
  assert.match(cookie, /^tm_aff=RAJ1;max-age=5184000;path=\/;SameSite=Lax;Secure$/);
  assert.ok(links.length >= 1);
  for (const l of links) {
    const r = referrerOf(l);
    assert.equal(r.get('ref'), 'RAJ1');
    assert.equal(r.get('utm_source'), 'affiliate');
    assert.equal(r.get('utm_campaign'), 'RAJ1');
  }
});

test('partner cookie from an earlier visit still tags the Play links; an ad\'s own utm is kept', () => {
  const later = visit('download.html', { cookie: 'x=1; tm_aff=LOSTLEBLANC' });
  for (const l of later.links) { const r = referrerOf(l); assert.equal(r.get('ref'), 'LOSTLEBLANC'); assert.equal(r.get('utm_source'), 'affiliate'); }
  const ad = visit('download.html', { search: '?utm_source=youtube&utm_campaign=fabian', cookie: 'tm_aff=FABIAN1' });
  for (const l of ad.links) { const r = referrerOf(l); assert.equal(r.get('ref'), 'FABIAN1'); assert.equal(r.get('utm_source'), 'youtube'); }
});

test('a malformed ?ref= sets no cookie and adds no ref', () => {
  for (const search of ['?ref=a', '?ref=%3Cscript%3E', '?ref=TOO_LONG_CODE_12345', '?ref=RAJ%26ref%3DX']) {
    const { links, cookie } = visit('index.html', { search });
    assert.equal(cookie, '', search);
    for (const l of links) assert.equal(referrerOf(l).get('ref'), null, search);
  }
});
