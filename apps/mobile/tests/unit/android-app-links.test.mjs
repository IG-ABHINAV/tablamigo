// Android App Links (website -> app) and the R8 settings Play's Android vitals asked for (1 Nov 2026).
//  - app.json: one autoVerify https intent filter for this site's /app/<plan|chat|user|trip|city|m>/ links;
//  - src/app/+native-intent.tsx -> inAppPath (src/lib/app-links.ts): strips the web app's /app base before expo-router routes;
//  - app.config.js: proguard-android-optimize.txt and optimised resource shrinking in release builds.
// The website half (/.well-known/assetlinks.json) is tested in apps/web/tests/test_site.py.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { inAppPath, APP_LINK_PREFIXES } from '../../src/lib/app-links.ts';

const SITE = 'https://tablamigo.hookstep.in';
const MOBILE = new URL('../../', import.meta.url).pathname;
const require = createRequire(import.meta.url);

test('a shared plan, chat, profile, trip, city chat or moment link opens that screen', () => {
  assert.equal(inAppPath(`${SITE}/app/activity/3f2a`), '/activity/3f2a');
  assert.equal(inAppPath(`${SITE}/app/chat/c1`), '/chat/c1');
  assert.equal(inAppPath(`${SITE}/app/user/u1/`), '/user/u1');
  assert.equal(inAppPath(`${SITE}/app/trip/t1`), '/trip/t1');
  assert.equal(inAppPath(`${SITE}/app/city/lisbon`), '/city/lisbon');
  assert.equal(inAppPath(`${SITE}/app/m/abc#top`), '/m/abc');
});

test('the query survives (template plan links prefill the new-plan form)', () => {
  assert.equal(inAppPath(`${SITE}/app/activity/new?title=Coffee+meetup&date=2035-03-19`), '/activity/new?title=Coffee+meetup&date=2035-03-19');
  assert.equal(inAppPath('/app/activity/a1?ref=share'), '/activity/a1?ref=share');
  assert.equal(inAppPath(`${SITE}/app`), '/');
  assert.equal(inAppPath(`${SITE}/app/`), '/');
});

test('app paths, custom-scheme paths and other hosts pass through untouched', () => {
  for (const p of ['/activity/a1', '/chat/c1', '/', 'tablamigo://activity/a1', 'https://evil.example/app/activity/a1',
    `${SITE}.evil.com/app/user/1`, '/apple/x', '/application']) {
    assert.equal(inAppPath(p), p, p);
  }
  // This host, but not the web app: the site's own pages map to themselves (no such route; expo-router shows its fallback).
  assert.equal(inAppPath(`${SITE}/privacy`), '/privacy');
});

test('app.json claims exactly the APP_LINK_PREFIXES under /app on this host, with autoVerify', () => {
  const android = JSON.parse(fs.readFileSync(MOBILE + 'app.json', 'utf8')).expo.android;
  const verified = android.intentFilters.filter(f => f.autoVerify);
  assert.equal(verified.length, 1);
  const f = verified[0];
  assert.equal(f.action, 'VIEW');
  assert.deepEqual([...f.category].sort(), ['BROWSABLE', 'DEFAULT']);
  assert.deepEqual(f.data.map(d => d.pathPrefix), APP_LINK_PREFIXES.map(p => '/app' + p));
  for (const d of f.data) { assert.equal(d.scheme, 'https'); assert.equal(d.host, 'tablamigo.hookstep.in'); }
  // Every claimed prefix maps to a real screen file.
  for (const p of APP_LINK_PREFIXES) {
    const dir = MOBILE + 'src/app' + p;
    assert.ok(fs.existsSync(dir) && fs.readdirSync(dir).some(n => n.startsWith('[')), `no screen for ${p}`);
  }
});

test('+native-intent hands every path to inAppPath', () => {
  const src = fs.readFileSync(MOBILE + 'src/app/+native-intent.tsx', 'utf8');
  assert.match(src, /export function redirectSystemPath/);
  assert.match(src, /inAppPath\(path\)/);
});

test('release builds use R8 optimisation, once, whatever the template says', () => {
  const { optimizeR8 } = require('../../app.config.js');
  const tpl = 'proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"';
  const out = optimizeR8(tpl);
  assert.equal(out, 'proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"');
  assert.equal(optimizeR8(out), out);
  const app = JSON.parse(fs.readFileSync(MOBILE + 'app.json', 'utf8')).expo;
  const bp = app.plugins.find(p => Array.isArray(p) && p[0] === 'expo-build-properties')[1].android;
  assert.equal(bp.enableMinifyInReleaseBuilds, true);
  assert.equal(bp.enableShrinkResourcesInReleaseBuilds, true);
});
