// The Google Mobile Ads SDK is linked into an Android build only when ADS_ENABLED=on (ads-env.js), and never into iOS, which
// has no ad setup. A build without it is, natively, the app from before ads: no ads SDK and no AD_ID permission, so it can be
// released while Play Console still says "no ads" and "no advertising ID" (PLAY-DATA-SAFETY-ADS.md at the repo root).
// Gradle caches this list until package.json or a lockfile changes, so app.config.js clears that cache on every prebuild.
const { adsEnv } = require('./ads-env');

module.exports = {
  dependencies: {
    'react-native-google-mobile-ads': { platforms: { ios: null, ...(adsEnv().enabled ? {} : { android: null }) } },
  },
};
