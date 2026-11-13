// Which store badges each device gets (build.py OS_JS + style.css "Store buttons"), run from the BUILT page's <head> script in a
// small fake browser, so what is tested is what ships. Owner's rule (4 Nov 2026, "like Google, OpenAI"): a phone or tablet sees
// only its own platform (iPhone and iPad: the iPhone / web app badge; Android: Google Play); every computer, Mac included, sees both.
//   node --test apps/web/tests/os-detect.test.mjs      (after python3 apps/web/build.py)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const DIST = new URL('../dist/', import.meta.url);
const CSS = fs.readFileSync(new URL('../style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const page = fs.readFileSync(new URL('download.html', DIST), 'utf8');
const head = page.split('</head>')[0];
const OS_JS = [...head.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes('os-ios'));

/** The classes the head script puts on <html> for this navigator. */
function classesFor(nav) {
  const list = new Set();
  const documentElement = { classList: { add: (...c) => c.forEach(x => list.add(x)) } };
  vm.runInNewContext(OS_JS, { navigator: { maxTouchPoints: 0, platform: '', ...nav }, document: { documentElement } });
  return [...list].sort();
}

/** Which badges style.css shows for those classes (the rules the test below pins). */
function badges(classes) {
  const shown = sel => [...CSS.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, sels, body]) => /display:\s*inline-(block|flex)/.test(body) && sels.split(',').some(s => s.trim().endsWith(sel) && classes.includes(s.trim().split(' ')[0].slice(1))))
    .length > 0;
  return { play: shown('.play-badge'), iphone: shown('.ios-badge') };
}

const UA = {
  macChrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
  // iPadOS Safari asks for the desktop site by default: its UA says Macintosh; only the touch points give it away.
  ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
};

const BOTH = { play: true, iphone: true }, IPHONE = { play: false, iphone: true }, PLAY = { play: true, iphone: false };
const CASES = [
  ['Mac, Chrome (the owner, 4 Nov)', { userAgent: UA.macChrome, platform: 'MacIntel', userAgentData: { platform: 'macOS' } }, ['os-desktop'], BOTH],
  ['Mac, Chrome with a reduced UA (only userAgentData says macOS)', { userAgent: UA.linux, platform: '', userAgentData: { platform: 'macOS' } }, ['os-desktop'], BOTH],
  ['Mac, Safari', { userAgent: UA.macSafari, platform: 'MacIntel' }, ['os-desktop'], BOTH],
  ['iPhone, Safari', { userAgent: UA.iphone, platform: 'iPhone', maxTouchPoints: 5 }, ['os-ios'], IPHONE],
  ['iPhone, Chrome', { userAgent: UA.iphoneChrome, platform: 'iPhone', maxTouchPoints: 5 }, ['os-ios'], IPHONE],
  ['iPad, desktop-mode UA ("Macintosh" + touch)', { userAgent: UA.ipadDesktop, platform: 'MacIntel', maxTouchPoints: 5 }, ['os-ios'], IPHONE],
  ['Android, Chrome', { userAgent: UA.android, platform: 'Linux armv81', maxTouchPoints: 5, userAgentData: { platform: 'Android' } }, ['os-android'], PLAY],
  ['Windows, Chrome', { userAgent: UA.windows, platform: 'Win32', userAgentData: { platform: 'Windows' } }, ['os-desktop'], BOTH],
  ['Linux, Chrome', { userAgent: UA.linux, platform: 'Linux x86_64', userAgentData: { platform: 'Linux' } }, ['os-desktop'], BOTH],
];

for (const [name, nav, classes, want] of CASES) {
  test(`${name}: ${want.play ? 'Google Play' : 'no Google Play'}, ${want.iphone ? 'iPhone badge' : 'no iPhone badge'}`, () => {
    const got = classesFor(nav);
    assert.deepEqual(got, classes);
    assert.deepEqual(badges(got), want);
  });
}

test('a navigator that throws still gets a class (desktop: both badges), never a page with no badge at all', () => {
  const list = [];
  vm.runInNewContext(OS_JS, { navigator: { get userAgent() { throw new Error('x'); } }, document: { documentElement: { classList: { add: c => list.push(c) } } } });
  assert.deepEqual(list, ['os-desktop']);
});

test('no class yet (the script has not run): neither badge, so the wrong one never flashes; <noscript> shows both', () => {
  assert.deepEqual(badges([]), { play: false, iphone: false });
  assert.match(head, /<noscript><style>\.play-badge\{display:inline-block!important\}\.ios-badge\{display:inline-flex!important\}<\/style><\/noscript>/);
  assert.ok(head.indexOf('os-ios') < head.indexOf('<style>'), 'the device script must run before the CSS');
});

test('copy per device: the CSS hides Play wording on iPhone/iPad, iPhone wording on Android, and desktop-only copy on both phones', () => {
  const hidden = (cls, el) => [...CSS.matchAll(/([^{}]+)\{([^}]*display:\s*none[^}]*)\}/g)]
    .some(([, sels]) => sels.split(',').some(x => x.trim() === `.${cls} .${el}`));
  for (const el of ['play-cta', 'not-ios', 'desktop-only']) assert.ok(hidden('os-ios', el), `.os-ios .${el}`);
  for (const el of ['not-android', 'desktop-only']) assert.ok(hidden('os-android', el), `.os-android .${el}`);
  assert.doesNotMatch(CSS, /os-apple|os-mac/);
});
