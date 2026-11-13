// The live counts (build.py LIVE COUNTS): the home page's "Live on Tablamigo" block and the /popular-cities page.
//  - the built pages: the home block ships empty and hidden, /popular-cities ships held (noindex, unlinked, out of the sitemap and
//    llms files) when the build is offline;
//  - the browser script, in a small fake browser: nothing on any host but production, nothing until the page has loaded, stays
//    hidden when the API has no city (or fails), and writes the API's text as text, never as HTML;
//  - the build's own decision: held unless the API says enabled with 3 cities of 10+ trips, listed and linked when it does.
//   node --test apps/web/tests/live-counts.test.mjs      (after python3 apps/web/build.py)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import { spawnSync, spawn } from 'node:child_process';

const WEB = new URL('../', import.meta.url).pathname;
const DIST = new URL('../dist/', import.meta.url);
const read = f => fs.readFileSync(new URL(f, DIST), 'utf8');
const scriptOf = html => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(x => x.includes('/public/social-proof'));

test('home: the block ships empty and hidden, with the script; /popular-cities ships held', () => {
  const home = read('index.html');
  assert.match(home, /<section id="live-now" hidden>/);
  assert.match(home, /<div id="live-body"><\/div>/);
  assert.ok(scriptOf(home), 'the live script is on the home page');
  assert.doesNotMatch(home, /href="\/popular-cities"/, 'not linked while held');
  const pc = read('popular-cities.html');
  assert.match(pc, /<meta name="robots" content="noindex, follow">/);
  assert.match(pc, /id="pc-empty"/);
  assert.ok(scriptOf(pc));
  assert.doesNotMatch(read('sitemap.xml'), /popular-cities/);
  for (const f of ['llms.txt', 'llms-full.txt', 'llms-guides.txt']) assert.doesNotMatch(read(f), /popular-cities/, f);
  // Other pages don't carry it.
  assert.equal(scriptOf(read('about.html')), undefined);
});

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.hidden = false; this._text = ''; this.className = ''; this.id = ''; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  appendChild(c) { this.children.push(c); return c; }
  set innerHTML(_) { throw new Error('innerHTML must never be used'); }
}
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r)); };

function visit({ script, hostname = 'tablamigo.hookstep.in', answer, status = 200, fail = false, loaded = true }) {
  const els = { 'live-now': Object.assign(new El('section'), { hidden: true }), 'live-body': new El('div'), 'pc-live': new El('div') };
  const fetched = []; const listeners = {};
  const ctx = vm.createContext({
    location: { hostname },
    addEventListener: (t, fn) => { listeners[t] = fn; },
    fetch: url => { fetched.push(url); return fail ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ ok: status === 200, json: () => Promise.resolve(answer(url)) }); },
    setTimeout: fn => { fn(); return 1; },
    requestIdleCallback: fn => { fn(); return 1; },
    document: { readyState: loaded ? 'complete' : 'loading', getElementById: id => els[id] ?? null, createElement: t => new El(t), createTextNode: t => Object.assign(new El('#text'), { textContent: t }) },
    Date,
  });
  ctx.window = ctx;
  vm.runInContext(script, ctx);
  return { els, fetched, listeners };
}

const SCRIPT = scriptOf(read('index.html'));
const QUALIFYING = {
  minTrips: 10,
  cities: [{ cityKey: 'goa-in', city: 'Goa', countryCode: 'IN', upcomingTrips: 14, plansThisWeek: 3 }],
  totals: { upcomingTrips: 31, plansThisWeek: 5, cities: 6 },
  trending: [{ cityKey: 'goa-in', city: 'Goa', countryCode: 'IN', travellers: 9 }],
  today: [{ title: '<img src=x onerror=alert(1)>Beach walk', emoji: '🌊', city: 'Goa', startsAt: new Date(Date.now() + 3600_000).toISOString(), going: 3 }],
};

test('only on the production host', async () => {
  for (const hostname of ['localhost', '127.0.0.1', 'tablamigo-preview.pages.dev']) {
    const v = visit({ script: SCRIPT, hostname, answer: () => QUALIFYING });
    await flush();
    assert.equal(v.fetched.length, 0, hostname);
  }
});

test('waits for the page to load', async () => {
  const v = visit({ script: SCRIPT, loaded: false, answer: () => QUALIFYING });
  await flush();
  assert.equal(v.fetched.length, 0);
  v.listeners.load(); await flush();
  assert.ok(v.fetched.some(u => u.endsWith('/public/social-proof')));
});

test('no qualifying city, an error status or a network failure: the block stays hidden and empty', async () => {
  for (const o of [{ answer: () => ({ minTrips: 10, cities: [], totals: null, trending: [], today: [] }) }, { status: 500, answer: () => ({}) }, { fail: true, answer: () => ({}) }]) {
    const v = visit({ script: SCRIPT, ...o });
    await flush();
    assert.equal(v.els['live-now'].hidden, true);
    assert.equal(v.els['live-body'].children.length, 0);
  }
});

test('a qualifying city: totals, trending and today, as text', async () => {
  const v = visit({ script: SCRIPT, answer: () => QUALIFYING });
  await flush();
  assert.equal(v.els['live-now'].hidden, false);
  const text = v.els['live-body'].textContent;
  assert.match(text, /31 upcoming trips · 5 plans this week · 6 cities/);
  assert.match(text, /Trending trips/); assert.match(text, /Goa: 9 travelers arriving in the next 30 days/);
  assert.match(text, /Today's plans/); assert.match(text, /<img src=x onerror=alert\(1\)>Beach walk · Goa/);
});

test('popular cities: the list replaces the held text only when the API says enabled', async () => {
  // A list built in at deploy time, then the API says the cities dropped under the line: the list goes.
  const off = visit({ script: SCRIPT, answer: u => u.endsWith('/public/popular-cities') ? { enabled: false, minTrips: 10, cities: [] } : { cities: [] } });
  off.els['pc-live'].appendChild(Object.assign(new El('ol'), { textContent: 'Goa 14 upcoming trips' }));
  await flush();
  assert.doesNotMatch(off.els['pc-live'].textContent, /Goa/);
  assert.match(off.els['pc-live'].textContent, /Not enough trips yet/);
  // The API down: the page stays as built.
  const down = visit({ script: SCRIPT, fail: true, answer: () => ({}) });
  down.els['pc-live'].appendChild(Object.assign(new El('ol'), { textContent: 'Goa 14 upcoming trips' }));
  await flush();
  assert.match(down.els['pc-live'].textContent, /Goa/);
  const on = visit({ script: SCRIPT, answer: u => u.endsWith('/public/popular-cities')
    ? { enabled: true, cities: [{ city: 'Goa', upcomingTrips: 14, plansThisWeek: 3 }, { city: 'Manali', upcomingTrips: 11, plansThisWeek: 1 }, { city: 'Rishikesh', upcomingTrips: 10, plansThisWeek: 0 }] } : { cities: [] } });
  await flush();
  assert.match(on.els['pc-live'].textContent, /Goa 14 upcoming trips · 3 plans this week.*Manali 11 upcoming trips · 1 plan this week.*Rishikesh/);
});

/** build.py's decision at import, against a fake API (TABLAMIGO_LIVE_API). */
async function decide(answer, live = '1') {
  const srv = http.createServer((req, res) => { res.writeHead(answer ? 200 : 500, { 'content-type': 'application/json' }); res.end(JSON.stringify(answer ?? {})); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const env = { ...process.env, TABLAMIGO_LIVE_DATA: live, TABLAMIGO_LIVE_API: `http://127.0.0.1:${srv.address().port}` };
  const out = await new Promise(resolve => {
    const p = spawn('python3', ['-c', 'import sys,json; sys.path.insert(0, sys.argv[1]); import build as b; print(json.dumps({"p": b.POPULAR, "held": "popular-cities.html" in b.UTILITY_PAGES, "html": b.popular_cities_html(b.POPULAR["cities"] if b.POPULAR["enabled"] else [])}))', WEB], { env });
    let s = ''; p.stdout.on('data', d => { s += d; }); p.on('close', () => resolve(s));
  });
  srv.close();
  return JSON.parse(out.trim().split('\n').pop());
}
const city = (c, n) => ({ cityKey: c, city: c, upcomingTrips: n, plansThisWeek: 1 });

test('build: enabled with 3 cities of 10+ trips: listed, ranked list built in', async () => {
  const r = await decide({ enabled: true, cities: [city('Goa', 14), city('Manali', 11), city('Rishikesh', 10)] });
  assert.equal(r.held, false);
  assert.match(r.html, /<ol id="pc-list"><li><b>Goa<\/b>/);
});

test('build: held with 2 cities, an API that says not enabled, a city under 10 slipped in, the API down, or an offline build', async () => {
  assert.equal((await decide({ enabled: true, cities: [city('Goa', 14), city('Manali', 11)] })).held, true);
  assert.equal((await decide({ enabled: false, cities: [city('Goa', 14), city('Manali', 11), city('Rishikesh', 10)] })).held, true);
  assert.equal((await decide({ enabled: true, cities: [city('Goa', 14), city('Manali', 11), city('Tiny', 9)] })).held, true);
  assert.equal((await decide(null)).held, true);
  assert.equal((await decide({ enabled: true, cities: [city('Goa', 14), city('Manali', 11), city('Rishikesh', 10)] }, '')).held, true);
});
