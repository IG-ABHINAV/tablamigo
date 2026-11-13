// `expo config` resolves the Google Mobile Ads config plugin, and only when a build asks for ads. Runs the real Expo CLI on this
// app (app.json + app.config.js), so a plugin entry that can't be resolved or configured fails here, as it did on 24 Oct 2026 when
// app.json listed react-native-google-mobile-ads without the package being installed ("PluginError: Failed to resolve plugin").
//   cd apps/mobile && npm run test:unit        (needs npm ci; each CLI run takes a few seconds)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const MOBILE = new URL('../../', import.meta.url).pathname;
const require = createRequire(import.meta.url);
const { TEST_APP_ID, TEST_BANNER_UNIT_ID } = require('../../ads-env.js');
const REAL_APP = 'ca-app-pub-1234567890123456~1234567890';
const REAL_UNIT = 'ca-app-pub-1234567890123456/0987654321';
const PLUGIN = 'react-native-google-mobile-ads';

function expoConfig(env, type = 'public') {
  const clean = { ...process.env };
  for (const k of ['ADS_ENABLED', 'ADMOB_ANDROID_APP_ID', 'ADMOB_BANNER_UNIT_ID', 'APP_ENV']) delete clean[k];
  const r = spawnSync(process.execPath, [MOBILE + 'node_modules/expo/bin/cli', 'config', '--type', type, '--json'],
    { cwd: MOBILE, env: { ...clean, ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, encoding: 'utf8', timeout: 120_000 });
  assert.equal(r.status, 0, `expo config ${JSON.stringify(env)} failed:\n${r.stderr}`);
  return JSON.parse(r.stdout);
}
const adsPlugin = c => (c.plugins ?? []).find(p => (Array.isArray(p) ? p[0] : p) === PLUGIN);

test('app.json never lists the ads plugin itself: app.config.js adds it only for an ADS_ENABLED build', () => {
  const app = JSON.parse(fs.readFileSync(MOBILE + 'app.json', 'utf8'));
  assert.ok(!JSON.stringify(app.expo.plugins ?? []).includes(PLUGIN), 'app.json must not carry react-native-google-mobile-ads');
  assert.ok(require('../../package.json').dependencies[PLUGIN], 'the package the plugin comes from is a dependency');
});

test('ads off (the default): expo config passes, no ads plugin, the app reads ads as off', () => {
  const c = expoConfig({});
  assert.equal(adsPlugin(c), undefined);
  assert.equal(c.extra.ads.enabled, false);
});

test('ads on, dev build: the plugin resolves with Google\'s TEST app id and the test banner unit', () => {
  const c = expoConfig({ ADS_ENABLED: 'on' });
  const [, opts] = adsPlugin(c);
  assert.equal(opts.androidAppId, TEST_APP_ID);
  assert.equal(opts.delayAppMeasurementInit, true);
  assert.equal(opts.androidSdk, 'classic'); // 17.2.0's Gradle script needs a backend named (fixed upstream in 17.3.1)
  assert.deepEqual(c.extra.ads, { enabled: true, bannerUnitId: TEST_BANNER_UNIT_ID, testIds: true });
});

test('ads on, release build: Google\'s test ids unless the environment names real ones', () => {
  const plain = expoConfig({ ADS_ENABLED: 'on', APP_ENV: 'production' });
  assert.equal(adsPlugin(plain)[1].androidAppId, TEST_APP_ID);
  assert.deepEqual(plain.extra.ads, { enabled: true, bannerUnitId: TEST_BANNER_UNIT_ID, testIds: true });
  const real = expoConfig({ ADS_ENABLED: 'on', APP_ENV: 'production', ADMOB_ANDROID_APP_ID: REAL_APP, ADMOB_BANNER_UNIT_ID: REAL_UNIT });
  assert.equal(adsPlugin(real)[1].androidAppId, REAL_APP);
  assert.deepEqual(real.extra.ads, { enabled: true, bannerUnitId: REAL_UNIT, testIds: false });
});

test('ads on: the plugin really writes the app id into the Android manifest, with measurement held until consent', () => {
  const c = expoConfig({ ADS_ENABLED: 'on' }, 'introspect');
  const meta = Object.fromEntries((c._internal.modResults.android.manifest.manifest.application[0]['meta-data'] ?? [])
    .map(m => [m.$['android:name'], m.$['android:value']]));
  assert.equal(meta['com.google.android.gms.ads.APPLICATION_ID'], TEST_APP_ID);
  assert.equal(meta['com.google.android.gms.ads.DELAY_APP_MEASUREMENT_INIT'], 'true');
});

test('the SDK is linked into Android only for an ads build, and never into iOS (react-native.config.js)', () => {
  const run = env => JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require('./react-native.config.js')))`],
    { cwd: MOBILE, env: { ...process.env, ADS_ENABLED: '', ...env }, encoding: 'utf8' }).stdout).dependencies[PLUGIN].platforms;
  assert.deepEqual(run({}), { ios: null, android: null });
  assert.deepEqual(run({ ADS_ENABLED: 'on' }), { ios: null });
});
