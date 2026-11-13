// Google AdMob settings for an Android build, read from the build's environment. app.config.js (the AdMob config plugin and
// the app's `extra.ads`) and react-native.config.js (whether the Google Mobile Ads SDK is linked at all) both read this, so
// they can never disagree. Plain CommonJS so node can load it from both files and from e2e-web/ads.test.mjs.
//
//   ADS_ENABLED=on          link the Google Mobile Ads SDK and show the Explore list banner to free accounts. Off when unset.
//   ADMOB_ANDROID_APP_ID    ca-app-pub-<16 digits>~<10 digits>   (AdMob: Apps, App settings, App ID)
//   ADMOB_BANNER_UNIT_ID    ca-app-pub-<16 digits>/<10 digits>   (AdMob: the app's Banner ad unit)
//
// An id left unset falls back to Google's sample id, in every build, so a build never asks for live ads unless the
// environment names real ids. Google's samples only ever serve test ads (developers.google.com/admob/android/quick-start and
// /test-ads, read 20 Oct 2026); the banner sample is Google's anchored adaptive banner unit. None of this turns ads on: that is
// ADS_ENABLED alone.
const TEST_APP_ID = 'ca-app-pub-3940256099942544~3347511713';
const TEST_BANNER_UNIT_ID = 'ca-app-pub-3940256099942544/9214589741';

const APP_ID = /^ca-app-pub-\d{16}~\d{10}$/;
const UNIT_ID = /^ca-app-pub-\d{16}\/\d{10}$/;

function adsEnv(env = process.env) {
  const enabled = ['on', '1', 'true'].includes(String(env.ADS_ENABLED ?? '').trim().toLowerCase());
  const androidAppId = String(env.ADMOB_ANDROID_APP_ID ?? '').trim() || TEST_APP_ID;
  const bannerUnitId = String(env.ADMOB_BANNER_UNIT_ID ?? '').trim() || TEST_BANNER_UNIT_ID;
  // A typo here would build an app that crashes on start (app id) or never fills (unit id), so refuse it at config time.
  if (!APP_ID.test(androidAppId)) throw new Error(`ADMOB_ANDROID_APP_ID must look like ca-app-pub-0000000000000000~0000000000 (got "${androidAppId}")`);
  if (!UNIT_ID.test(bannerUnitId)) throw new Error(`ADMOB_BANNER_UNIT_ID must look like ca-app-pub-0000000000000000/0000000000 (got "${bannerUnitId}")`);
  if (androidAppId.split('~')[0] !== bannerUnitId.split('/')[0] && androidAppId !== TEST_APP_ID && bannerUnitId !== TEST_BANNER_UNIT_ID) {
    throw new Error('ADMOB_ANDROID_APP_ID and ADMOB_BANNER_UNIT_ID belong to different AdMob accounts');
  }
  return { enabled, androidAppId, bannerUnitId, testIds: androidAppId === TEST_APP_ID || bannerUnitId === TEST_BANNER_UNIT_ID };
}

module.exports = { adsEnv, TEST_APP_ID, TEST_BANNER_UNIT_ID };
