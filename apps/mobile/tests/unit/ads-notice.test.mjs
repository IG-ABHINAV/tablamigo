// The one-time notice before the first ad (src/lib/ads-notice.ts). The privacy policy promises to tell people in the app
// before a meaningful change takes effect, so ads must never start before it was shown once, and it shows only where ads would.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { needsAdsNotice, markAdsNoticeSeen, ADS_NOTICE, ADS_NOTICE_KEY } from '../../src/lib/ads-notice.ts';

const mem = () => { const m = new Map(); return { m, get: async k => m.get(k) ?? null, set: async (k, v) => { m.set(k, v); } }; };

test('shown once to a free account in a build with ads, then never again', async () => {
  const s = mem();
  assert.equal(await needsAdsNotice(s, true, true), true);
  await markAdsNoticeSeen(s);
  assert.equal(s.m.get(ADS_NOTICE_KEY), 'seen');
  assert.equal(await needsAdsNotice(s, true, true), false);
});

test('never in a build without ads, never to Plus, and storage is not even read then', async () => {
  const s = { get: async () => { throw new Error('read'); }, set: async () => {} };
  assert.equal(await needsAdsNotice(s, false, true), false);
  assert.equal(await needsAdsNotice(s, true, false), false);
});

test('unreadable storage shows it (better twice than ads before anyone was told); a failed save does not throw', async () => {
  const broken = { get: async () => { throw new Error('keystore'); }, set: async () => { throw new Error('keystore'); } };
  assert.equal(await needsAdsNotice(broken, true, true), true);
  await markAdsNoticeSeen(broken);
});

test('the copy says where the ad is, that Plus has none, and points at the privacy policy', () => {
  assert.match(ADS_NOTICE.body, /Explore/); assert.match(ADS_NOTICE.body, /Plus/); assert.match(ADS_NOTICE.privacy, /Privacy Policy/);
});

test('the tab layout starts ads only after the notice is settled', () => {
  const src = readFileSync(new URL('../../src/app/(tabs)/_layout.tsx', import.meta.url), 'utf8');
  const start = src.indexOf('startAds();');
  assert.ok(start > 0, 'startAds is called');
  const guard = src.lastIndexOf("notice !== 'done'", start);
  assert.ok(guard > 0 && start - guard < 200, "startAds runs only in the effect that waits for notice === 'done'");
  assert.equal((src.match(/startAds\(\)/g) ?? []).length, 2, 'no other startAds call (the one on resume is in the same effect)');
});

test('the tab bar and the bottom action bars make room for the system navigation bar (edge to edge)', () => {
  const read = p => readFileSync(new URL(`../../src/${p}`, import.meta.url), 'utf8');
  assert.match(read('app/(tabs)/_layout.tsx'), /height: tabBarHeight\(insets\.bottom\), paddingTop: 8, paddingBottom: 12 \+ insets\.bottom/);
  for (const p of ['app/activity/[id].tsx', 'app/user/[id].tsx']) {
    const s = read(p);
    assert.match(s, /bottom: 0,[^}]*paddingBottom: \d+ \+ insets\.bottom/, `${p}: bottom bar pads for the inset`);
    assert.match(s, /edges=\{\['top'\]\}/, `${p}: the screen does not pad the bottom twice`);
  }
  assert.doesNotMatch(read('app/(tabs)/index.tsx'), /TAB_BAR_HEIGHT/, 'Explore pads with tabBarHeight(insets.bottom), not the bare constant');
});
