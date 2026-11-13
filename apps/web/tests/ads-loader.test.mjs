// The AdSense loader (build.py adsense_js), run in a small fake browser in BOTH consent states, plus a check that the built pages
// carry exactly the state build.py ships (ADSENSE_CMP):
//  - either state: nothing is requested before the visitor's first scroll, tap, click or key press, only on the production host,
//    Google's script at most once, async;
//  - consent message live (ADSENSE_CMP True): the script loads for every country and Google's message asks in the EEA, the UK and
//    Switzerland; no country lookup is made;
//  - no consent message (False): Cloudflare's /cdn-cgi/trace decides, and visitors in the EEA, the UK and Switzerland, or whose
//    country can't be told, get no ad script at all.
//   node --test apps/web/tests/ads-loader.test.mjs      (after python3 apps/web/build.py)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';

const WEB = new URL('../', import.meta.url).pathname;
const DIST = new URL('../dist/', import.meta.url);
const B = JSON.parse(spawnSync('python3', ['-c',
  'import sys,json; sys.path.insert(0, sys.argv[1]); import build as b; print(json.dumps({"on": b.adsense_js(True), "off": b.adsense_js(False), "cmp": b.ADSENSE_CMP, "client": b.ADSENSE_CLIENT, "src": b.ADSENSE_SRC}))',
  WEB], { encoding: 'utf8' }).stdout);
const LOADER = { on: B.on, off: B.off };
const SRC = `https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=${B.client}`;
const GUIDE = 'solo-travel/goa.html';
const EEA_UK_CH = ['DE', 'FR', 'IE', 'IT', 'ES', 'NL', 'PL', 'SE', 'AT', 'NO', 'IS', 'LI', 'GB', 'CH', 'RE', 'GP', 'AX', 'GI', 'JE'];

/** The AdSense inline script of a built page. */
function loaderOf(page) {
  const html = fs.readFileSync(new URL(page, DIST), 'utf8');
  const s = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(x => x.includes('adsbygoogle.js'));
  assert.ok(s, `${page} carries the AdSense loader`);
  return s;
}

const flush = () => new Promise(r => setImmediate(r));

/** Runs a loader; returns handles to fire events and to see what it fetched and appended. */
function visit({ script, hostname = 'tablamigo.hookstep.in', trace = 'fl=1\nh=tablamigo.hookstep.in\nloc=IN\ntls=TLSv1.3\n',
  traceStatus = 200, traceThrows = false, existing = false, idle = true } = {}) {
  const listeners = new Map(), fetched = [], appended = [];
  const ctx = vm.createContext({
    location: { hostname },
    addEventListener: (type, fn, opts) => { listeners.set(type, { fn, opts }); },
    removeEventListener: type => { listeners.delete(type); },
    fetch: (url, opts) => {
      fetched.push({ url, opts });
      if (traceThrows) return Promise.reject(new TypeError('Failed to fetch'));
      return Promise.resolve({ ok: traceStatus === 200, status: traceStatus, text: () => Promise.resolve(trace) });
    },
    setTimeout: (fn) => { fn(); return 1; },
    document: {
      querySelector: sel => { assert.match(sel, /adsbygoogle\.js/); return existing || appended.length ? {} : null; },
      createElement: tag => { assert.equal(tag, 'script'); return {}; },
      head: { appendChild: el => { appended.push(el); } },
    },
  });
  if (idle) ctx.requestIdleCallback = (fn) => { fn(); return 1; };
  ctx.window = ctx;
  vm.runInContext(script, ctx);
  const fire = async type => { const l = listeners.get(type); if (l) l.fn({ type }); await flush(); await flush(); };
  return { listeners, fetched, appended, fire };
}

test('the built pages carry the loader for the consent state build.py ships, the same on every ad page', () => {
  const shipped = loaderOf(GUIDE);
  assert.equal(shipped, B.cmp ? B.on : B.off);
  assert.ok(shipped.includes(`var CMP=${B.cmp},`));
  for (const p of ['how-to-meet-people-in-hostels.html', 'eating-alone-while-traveling.html', 'solo-travel/rishikesh.html']) {
    assert.equal(loaderOf(p), shipped, p);
  }
  assert.equal(B.src, SRC);
});

for (const state of ['on', 'off']) {
  const script = LOADER[state];
  const label = `consent message ${state}`;

  test(`${label}: nothing is requested before the first interaction`, async () => {
    const v = visit({ script });
    await flush();
    assert.deepEqual(v.fetched, []);
    assert.deepEqual(v.appended, []);
    assert.deepEqual([...v.listeners.keys()].sort(), ['keydown', 'pointerdown', 'scroll', 'touchstart']);
    for (const { opts } of v.listeners.values()) assert.deepEqual({ ...opts }, { capture: true, passive: true }); // copied out of the vm realm
  });

  test(`${label}: a visitor in India scrolls: Google's script, async, crossorigin, once; later interactions add nothing`, async () => {
    const v = visit({ script });
    await v.fire('scroll');
    assert.equal(v.appended.length, 1);
    assert.equal(v.appended[0].src, SRC);
    assert.equal(v.appended[0].async, true);
    assert.equal(v.appended[0].crossOrigin, 'anonymous');
    assert.equal(v.listeners.size, 0);
    const fetchedBefore = v.fetched.length;
    await v.fire('pointerdown');
    await v.fire('scroll');
    assert.equal(v.fetched.length, fetchedBefore);
    assert.equal(v.appended.length, 1);
  });

  test(`${label}: a tap, a key press or a touch starts it the same way; it also works without requestIdleCallback (Safari)`, async () => {
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
      const v = visit({ script, idle: ev !== 'keydown' });
      await v.fire(ev);
      assert.equal(v.appended.length, 1, ev);
    }
  });

  test(`${label}: local builds, previews and other hosts never request anything`, async () => {
    for (const hostname of ['127.0.0.1', 'localhost', 'www.tablamigo.hookstep.in', 'hookstep.in', 'tablamigo.hookstep.in.evil.test', 'evil.test']) {
      const v = visit({ script, hostname });
      assert.equal(v.listeners.size, 0, hostname);
      await v.fire('scroll');
      assert.deepEqual(v.fetched, [], hostname);
      assert.deepEqual(v.appended, [], hostname);
    }
  });

  test(`${label}: if the script is already on the page it is not added twice`, async () => {
    const v = visit({ script, existing: true });
    await v.fire('scroll');
    assert.equal(v.appended.length, 0);
  });
}

test('consent message on: no country lookup; every country gets the script and Google\'s message asks where the law needs it', async () => {
  for (const cc of [...EEA_UK_CH, 'IN', 'US', 'XX', 'T1']) {
    const v = visit({ script: LOADER.on, trace: `loc=${cc}\n` });
    await v.fire('scroll');
    assert.deepEqual(v.fetched, [], `${cc}: no /cdn-cgi/trace with the consent message on`);
    assert.equal(v.appended.length, 1, cc);
  }
  // Nothing about Cloudflare can stop or start it either.
  for (const opts of [{ traceThrows: true }, { traceStatus: 500 }]) {
    const v = visit({ script: LOADER.on, ...opts });
    await v.fire('scroll');
    assert.equal(v.appended.length, 1, JSON.stringify(opts));
  }
});

test('consent message off: one country check per visit, made only after the interaction', async () => {
  const v = visit({ script: LOADER.off });
  await flush();
  assert.equal(v.fetched.length, 0);
  await v.fire('scroll');
  assert.equal(v.fetched.length, 1);
  assert.equal(v.fetched[0].url, '/cdn-cgi/trace');
  assert.equal(v.fetched[0].opts.cache, 'no-store');
});

test('consent message off: the EEA, the UK and Switzerland get no ad script', async () => {
  for (const cc of EEA_UK_CH) {
    const v = visit({ script: LOADER.off, trace: `h=tablamigo.hookstep.in\nloc=${cc}\n` });
    await v.fire('scroll');
    assert.equal(v.fetched.length, 1, cc);
    assert.equal(v.appended.length, 0, `${cc} must not load ads without a certified consent tool`);
  }
});

test('consent message off: other countries load it', async () => {
  for (const cc of ['IN', 'US', 'TH', 'ID', 'AE', 'BR', 'AU', 'SG']) {
    const v = visit({ script: LOADER.off, trace: `loc=${cc}\n` });
    await v.fire('scroll');
    assert.equal(v.appended.length, 1, cc);
  }
});

test('consent message off: when the country can\'t be told, no ads (unknown, Tor, missing, malformed, an error page, a failed request)', async () => {
  for (const opts of [{ trace: 'loc=XX\n' }, { trace: 'loc=T1\n' }, { trace: 'h=x\nip=1.2.3.4\n' }, { trace: 'loc=in\n' }, { trace: 'loc=IND\n' },
    { trace: 'xloc=IN\n' }, { trace: '' }, { trace: 'loc=DE\nloc=IN\n' }, { traceStatus: 403, trace: 'loc=IN\n' }, { traceThrows: true }]) {
    const v = visit({ script: LOADER.off, ...opts });
    await v.fire('scroll');
    assert.equal(v.appended.length, 0, JSON.stringify(opts));
  }
});
