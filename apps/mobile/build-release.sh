#!/usr/bin/env bash
# Builds the signed Play Store bundle (.aab) locally, no EAS account needed.
#   ./build-release.sh            -> dist/tablamigo-<version>-<code>.aab (+ .apk for a device, + -mapping.txt, the R8 deobfuscation file)
# Bump android.versionCode in app.json before every upload; Play rejects repeats.
# The upload key lives in ../../credentials (gitignored). Back it up somewhere safe.
set -euo pipefail
cd "$(dirname "$0")"

export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
export ANDROID_HOME=${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}
PROPS="$(cd ../.. && pwd)/credentials/upload-keystore.properties"   # absolute: read from inside android/ too
[ -f "$PROPS" ] || { echo "missing $PROPS"; exit 1; }
prop() { grep "^$1=" "$PROPS" | cut -d= -f2-; }

export APP_ENV=production NODE_ENV=production
npx expo prebuild --platform android --no-install >/dev/null
(cd android && ./gradlew --quiet bundleRelease assembleRelease \
  -Pandroid.injected.signing.store.file="$(prop storeFile)" \
  -Pandroid.injected.signing.store.password="$(prop storePassword)" \
  -Pandroid.injected.signing.key.alias="$(prop keyAlias)" \
  -Pandroid.injected.signing.key.password="$(prop keyPassword)")

version=$(node -p "require('./app.json').expo.version")
code=$(node -p "require('./app.json').expo.android.versionCode")
mkdir -p dist
out="dist/tablamigo-$version-$code.aab"
cp android/app/build/outputs/bundle/release/app-release.aab "$out"
cp android/app/build/outputs/apk/release/app-release.apk "dist/tablamigo-$version-$code.apk"  # for testing on a device
# R8 renames and removes code in release builds (app.json: enableMinifyInReleaseBuilds). This file turns a crash stack from
# the Play Console back into real names, so keep it with the .aab and upload it for this version in the Play Console.
# (AGP also puts a copy inside the .aab; this one is for ReTrace and for the record.)
mapping=android/app/build/outputs/mapping/release/mapping.txt
[ -s "$mapping" ] || { echo "NO R8 MAPPING FILE at $mapping: is minify off? The release build must be minified."; exit 1; }
cp "$mapping" "dist/tablamigo-$version-$code-mapping.txt"
# Must be signed with OUR upload key, not the debug key Expo's template falls back to.
want=$("$JAVA_HOME/bin/keytool" -list -keystore "$(prop storeFile)" -storepass "$(prop storePassword)" -alias "$(prop keyAlias)" | grep -o "SHA-256): .*" | cut -d' ' -f2)
got=$("$JAVA_HOME/bin/keytool" -printcert -jarfile "$out" | grep "SHA256:" | head -1 | awk '{print $2}')
[ "$want" = "$got" ] || { echo "WRONG SIGNING KEY: $got (expected $want)"; exit 1; }
echo "signed with upload key $want: $out ($(du -h "$out" | cut -f1))"
# Ads are off unless this script ran with ADS_ENABLED=on (ads-env.js). Play Console's ads and advertising-ID answers must match
# the build (PLAY-DATA-SAFETY-ADS.md), so check the built app, not just the setting: Google's SDK brings the AD_ID permission,
# and react-native.config.js links the SDK only into an ads build.
ads=$(node -p "require('./ads-env').adsEnv().enabled")
bt=$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)
adid=$("$bt/aapt2" dump permissions "dist/tablamigo-$version-$code.apk" | grep -c "com.google.android.gms.permission.AD_ID" || true)
if [ "$ads" = true ] && [ "$adid" = 0 ]; then echo "ADS_ENABLED=on, but the build has no AD_ID permission: the ads SDK was not linked"; exit 1; fi
if [ "$ads" = false ] && [ "$adid" != 0 ]; then echo "ADS_ENABLED is off, but the build carries AD_ID: Play's advertising-ID answer would be wrong"; exit 1; fi
# Say which, so a build with Google's test ad ids, or one without ads, is never uploaded by mistake.
node -e "const a = require('./ads-env').adsEnv(); console.log(!a.enabled ? 'ads: off (no Google Mobile Ads SDK in this build)'
  : a.testIds ? 'ads: ON with Google TEST ad ids. WARNING: this build only ever shows test ads; do not upload it to Play.'
  : 'ads: ON, AdMob app ' + a.androidAppId + ', banner ' + a.bannerUnitId)"
