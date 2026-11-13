// Release builds (APP_ENV=production) must not allow cleartext HTTP; dev builds
// need it to reach the local API on 10.0.2.2.
const fs = require('fs');
const path = require('path');
const { withDangerousMod, withAppBuildGradle, withGradleProperties } = require('expo/config-plugins');
const { adsEnv } = require('./ads-env');

// react-native.config.js links the Google Mobile Ads SDK only when ADS_ENABLED=on, but Gradle reuses its autolinking list
// until package.json or a lockfile changes. A build after a flip would then keep the old list: an ads build without the
// SDK, or a no-ads build carrying an SDK with no app id, which crashes on start. Every prebuild drops that cache.
const withFreshAutolinking = config => withDangerousMod(config, ['android', async c => {
  fs.rmSync(path.join(c.modRequest.platformProjectRoot, 'build', 'generated', 'autolinking'), { recursive: true, force: true });
  return c;
}]);

// Play Console's Android vitals (1 Nov 2026, release 13 / 1.4.0) flagged the R8 setup: "Optimisation isn't enabled" and
// "Optimised resource shrinking isn't enabled". Expo's template names proguard-android.txt, whose -dontoptimize turns R8's
// optimisation passes off; proguard-android-optimize.txt is the same rules without it (Google's recommended default, and the
// only one AGP 9 accepts). Optimised resource shrinking lets R8 drop resources only reachable from removed code.
const OPTIMIZE_FROM = 'getDefaultProguardFile("proguard-android.txt")';
const OPTIMIZE_TO = 'getDefaultProguardFile("proguard-android-optimize.txt")';
const optimizeR8 = gradle => gradle.includes(OPTIMIZE_TO) ? gradle : gradle.replace(OPTIMIZE_FROM, OPTIMIZE_TO);
const withR8Optimize = config => withGradleProperties(withAppBuildGradle(config, c => {
  c.modResults.contents = optimizeR8(c.modResults.contents);
  return c;
}), c => {
  const key = 'android.r8.optimizedResourceShrinking';
  c.modResults = c.modResults.filter(p => !(p.type === 'property' && p.key === key));
  c.modResults.push({ type: 'property', key, value: 'true' });
  return c;
});

module.exports = ({ config }) => {
  const prod = process.env.APP_ENV === 'production';
  // Push needs a Firebase project. Drop its google-services.json next to this file and rebuild.
  const firebase = fs.existsSync(__dirname + '/google-services.json');
  // AdMob, off unless the build sets ADS_ENABLED=on (ads-env.js has the variables and Google's test ids).
  const ads = adsEnv();
  // The web app (PWA) is served at tablamigo.hookstep.in/app. Native bundles inline the base URL too, so set it for web only.
  const argv = process.argv;
  const web = argv.includes('--platform=web') || argv.some((a, i) => a === 'web' && ['-p', '--platform'].includes(argv[i - 1])) || argv.includes('--web');
  return {
    ...config,
    experiments: { ...config.experiments, ...(web ? { baseUrl: '/app' } : {}) },
    android: { ...config.android, ...(firebase ? { googleServicesFile: './google-services.json' } : {}) },
    // Only cleartext depends on the build; everything else app.json says about build properties (R8 minify, resource
    // shrinking) stays. Replacing the whole options object here used to drop it.
    plugins: [
      ...config.plugins.map(p =>
        Array.isArray(p) && p[0] === 'expo-build-properties'
          ? ['expo-build-properties', { ...p[1], android: { ...p[1]?.android, usesCleartextTraffic: !prod } }]
          : p),
      // Writes the AdMob app id into the Android manifest. Its "No 'iosAppId'" warning is expected: iOS never links the SDK.
      // App measurement waits until the SDK is started, which the app only does after Google's consent step (src/lib/ads.ts).
      // androidSdk 'classic' is the library's default backend, named here because 17.2.0's Gradle script fails to configure
      // when neither this property nor an app.json "react-native-google-mobile-ads" key is set (fixed upstream in 17.3.1).
      ...(ads.enabled ? [['react-native-google-mobile-ads', { androidAppId: ads.androidAppId, delayAppMeasurementInit: true, androidSdk: 'classic' }]] : []),
      withFreshAutolinking,
      withR8Optimize,
    ],
    extra: {
      ...(config.extra ?? {}), appEnv: prod ? 'production' : 'development',
      ads: { enabled: ads.enabled, bannerUnitId: ads.bannerUnitId, testIds: ads.testIds },
    },
  };
};
module.exports.optimizeR8 = optimizeR8;
