// Unit tests for the AdMob switch, with node's own test runner:  npm run test:unit
// ads-env.js turns the build's environment into the AdMob settings (and decides whether the SDK is linked at all);
// src/lib/ads-config.ts decides, from those settings and GET /me, whether this account sees the banner.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readAdsExtra, showsAds, exploreAdSlot, REMOVE_ADS_LINK } from '../src/lib/ads-config.ts';
import { paywallReason, reasonHeading } from '../src/lib/paywall-copy.ts';

const require = createRequire(import.meta.url);
const { adsEnv, TEST_APP_ID, TEST_BANNER_UNIT_ID } = require('../ads-env.js');

const REAL_APP = 'ca-app-pub-1234567890123456~1234567890';
const REAL_UNIT = 'ca-app-pub-1234567890123456/0987654321';

test('ads are off unless ADS_ENABLED says on, and unset ids fall back to Google\'s sample ids', () => {
  for (const v of [undefined, '', 'off', '0', 'false', 'no', 'yes please']) {
    assert.equal(adsEnv({ ADS_ENABLED: v }).enabled, false, String(v));
  }
  for (const v of ['on', 'ON', '1', 'true', ' on ']) assert.equal(adsEnv({ ADS_ENABLED: v }).enabled, true, v);
  assert.deepEqual(adsEnv({}), { enabled: false, androidAppId: TEST_APP_ID, bannerUnitId: TEST_BANNER_UNIT_ID, testIds: true });
  // Google's published samples: the app id from the Android quick start, the anchored adaptive banner from the test-ads page.
  assert.equal(TEST_APP_ID, 'ca-app-pub-3940256099942544~3347511713');
  assert.equal(TEST_BANNER_UNIT_ID, 'ca-app-pub-3940256099942544/9214589741');
});

test('real ids are one env change, and a malformed or mismatched id fails the build instead of shipping', () => {
  assert.deepEqual(adsEnv({ ADS_ENABLED: 'on', ADMOB_ANDROID_APP_ID: REAL_APP, ADMOB_BANNER_UNIT_ID: REAL_UNIT }),
    { enabled: true, androidAppId: REAL_APP, bannerUnitId: REAL_UNIT, testIds: false });
  // A real app id with Google's test unit is allowed (Google's way to test a real app), but still reported as test ids.
  assert.equal(adsEnv({ ADMOB_ANDROID_APP_ID: REAL_APP }).testIds, true);
  assert.throws(() => adsEnv({ ADMOB_ANDROID_APP_ID: 'ca-app-pub-1234567890123456/1234567890' }), /ADMOB_ANDROID_APP_ID/);
  assert.throws(() => adsEnv({ ADMOB_BANNER_UNIT_ID: 'ca-app-pub-1234567890123456~1234567890' }), /ADMOB_BANNER_UNIT_ID/);
  assert.throws(() => adsEnv({ ADMOB_ANDROID_APP_ID: REAL_APP, ADMOB_BANNER_UNIT_ID: 'ca-app-pub-6543210987654321/0987654321' }), /different AdMob accounts/);
});

test('every build, release included, defaults to Google\'s samples, and none turns ads on', () => {
  for (const APP_ENV of [undefined, '', 'development', 'production', 'Production']) {
    const b = adsEnv({ APP_ENV });
    assert.equal(b.enabled, false, String(APP_ENV));
    assert.equal(b.androidAppId, TEST_APP_ID, String(APP_ENV));
    assert.equal(b.bannerUnitId, TEST_BANNER_UNIT_ID, String(APP_ENV));
    assert.equal(b.testIds, true, String(APP_ENV));
  }
  // An explicit id wins in a release build.
  assert.equal(adsEnv({ APP_ENV: 'production', ADMOB_ANDROID_APP_ID: REAL_APP, ADMOB_BANNER_UNIT_ID: REAL_UNIT }).androidAppId, REAL_APP);
});

test('only an Android build made with ads on has ads; iOS, the web app and older builds have none', () => {
  const on = { enabled: true, bannerUnitId: REAL_UNIT, testIds: false };
  assert.deepEqual(readAdsExtra(on, 'android'), on);
  for (const platform of ['ios', 'web']) assert.equal(readAdsExtra(on, platform).enabled, false, platform);
  for (const extra of [undefined, null, {}, { enabled: 'true', bannerUnitId: REAL_UNIT }, { enabled: true }, { enabled: true, bannerUnitId: '' }, { enabled: false, bannerUnitId: REAL_UNIT }]) {
    assert.deepEqual(readAdsExtra(extra, 'android').enabled, false, JSON.stringify(extra));
  }
});

test('only a free account sees ads: never Plus, never while everything is free, never before /me answers', () => {
  assert.equal(showsAds({ plus: false, allFree: false }), true);
  assert.equal(showsAds({ plus: false }), true);
  for (const me of [undefined, null, 'x', {}, { plus: true }, { plus: true, allFree: false }, { plus: false, allFree: true }, { plus: 'false' }, { plus: 0 }]) {
    assert.equal(showsAds(me), false, JSON.stringify(me));
  }
});

// GET /me's answer for each way of having Plus (apps/api/src/tests/integration/remove-ads.test.ts drives the real route for these):
// plus comes from plus_until, which a subscription (also in grace or cancelled-but-paid), a Trip Pass (bought or from the wallet)
// and comped days all set; allFree is the ALL_FREE switch.
test('paid, Trip Pass and comped accounts never see the ad or the Remove ads link; a lapsed one is free again', () => {
  const me = over => ({ id: 'u1', name: 'Asha', plus: false, allFree: false, tripPassesAvailable: 0, ...over });
  for (const [who, m] of [['subscriber', me({ plus: true })], ['trip pass', me({ plus: true, tripPassesAvailable: 0 })],
    ['unused wallet pass but Plus from a comp', me({ plus: true, tripPassesAvailable: 2 })], ['comped', me({ plus: true })],
    ['everything free', me({ allFree: true })], ['everything free and Plus', me({ plus: true, allFree: true })]]) {
    assert.equal(showsAds(m), false, who);
  }
  // An unredeemed wallet pass is not Plus yet: until it is used the account is free (and is told it can skip ads).
  assert.equal(showsAds(me({ tripPassesAvailable: 1 })), true);
  assert.equal(showsAds(me({ plus: false })), true, 'Plus ended');
  // /me loading, failed, or an old API without the field: no ad, no link.
  for (const m of [undefined, null, { error: 'unauthorized' }, me({ plus: undefined }), me({ plus: null })]) assert.equal(showsAds(m), false, JSON.stringify(m));
});

test('the Remove ads link: honest wording, its own paywall reason, and never an invitation to click the ad', () => {
  assert.equal(REMOVE_ADS_LINK.label, 'Remove ads · Get Plus');
  assert.doesNotMatch(REMOVE_ADS_LINK.label, /click|tap|support us|sponsor|visit/i);
  const reason = new URL(REMOVE_ADS_LINK.href, 'https://x').searchParams.get('reason');
  assert.equal(new URL(REMOVE_ADS_LINK.href, 'https://x').pathname, '/paywall');
  assert.equal(paywallReason(reason), 'remove_ads');
  assert.equal(reasonHeading(reason), 'Remove ads with Plus');
});

test('the link renders only inside the banner\'s own gate, below the banner and outside it', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/components/ExploreAd.tsx', import.meta.url), 'utf8');
  const gate = src.indexOf('if (!gma || !ready || failed || !showsAds(me.data)) return null;');
  const bannerEnd = src.indexOf('onAdFailedToLoad={() => { setLoaded(false); setFailed(true); }} />');
  assert.match(src, /onAdLoaded=\{\(\) => setLoaded\(true\)\}/);
  assert.match(src, /\{loaded \? <Pressable/, 'the link waits for the banner to load');
  const link = src.indexOf('REMOVE_ADS_LINK.href');
  assert.ok(gate > 0 && bannerEnd > gate && link > bannerEnd, 'gate, then the banner, then the link');
  // The web app has no ad, so no link either.
  assert.doesNotMatch(fs.readFileSync(new URL('../src/components/ExploreAd.web.tsx', import.meta.url), 'utf8'), /REMOVE_ADS_LINK|Remove ads/);
  const users = fs.readdirSync(new URL('../src/', import.meta.url), { recursive: true }).filter(f => /\.tsx?$/.test(f) && !f.endsWith('lib/ads-config.ts'))
    .filter(f => /REMOVE_ADS_LINK|reason=remove_ads/.test(fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8')));
  assert.deepEqual(users, ['components/ExploreAd.tsx']);
});

test('the Explore list has an ad slot only after its last plan, and only once the person has scrolled the list', () => {
  assert.equal(exploreAdSlot(5, true), true);
  assert.equal(exploreAdSlot(1, true), true);
  assert.equal(exploreAdSlot(5, false), false, 'a list nobody has scrolled: its end may be off screen');
  assert.equal(exploreAdSlot(0, true), false, 'an empty list (its "Show all plans" and "Post a plan" buttons) never gets the ad');
  assert.equal(exploreAdSlot(0, false), false);
});

test('the Explore banner is the only ad placement in the app, and there are no full-screen ad formats', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const SRC = new URL('../src/', import.meta.url).pathname;
  const files = [];
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) files.push(p); } };
  walk(SRC);
  const rel = p => path.relative(SRC, p);
  const using = (re) => files.filter(f => re.test(fs.readFileSync(f, 'utf8'))).map(rel).sort();
  assert.deepEqual(using(/<BannerAd\b/), ['components/ExploreAd.tsx']);
  assert.deepEqual(using(/<ExploreAd\b/), ['app/(tabs)/index.tsx']);
  assert.deepEqual(using(/require\('react-native-google-mobile-ads'\)|from 'react-native-google-mobile-ads'/), ['lib/ads.ts']);
  assert.deepEqual(using(/Interstitial|AppOpenAd|RewardedAd|NativeAd\b/), []);
});
