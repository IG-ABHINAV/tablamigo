#!/usr/bin/env bash
# Direct-download APK for sideloading: the release APK with only arm64 native code (every phone
# from ~2017 on), re-aligned and re-signed with our upload key. Run after ./build-release.sh.
#   ./build-apk-arm64.sh   -> dist/tablamigo-<version>-<code>-arm64.apk
set -euo pipefail
cd "$(dirname "$0")"
export JAVA_HOME=${JAVA_HOME:-/opt/homebrew/opt/openjdk@21}
BT=$(ls -d /opt/homebrew/share/android-commandlinetools/build-tools/* | sort -V | tail -1)
PROPS="$(cd ../.. && pwd)/credentials/upload-keystore.properties"
prop() { grep "^$1=" "$PROPS" | cut -d= -f2-; }
version=$(node -p "require('./app.json').expo.version"); code=$(node -p "require('./app.json').expo.android.versionCode")
src="dist/tablamigo-$version-$code.apk"; out="dist/tablamigo-$version-$code-arm64.apk"
tmp=$(mktemp -d); cp "$src" "$tmp/in.apk"
zip -q -d "$tmp/in.apk" 'lib/x86/*' 'lib/x86_64/*' 'lib/armeabi-v7a/*' 'META-INF/*.SF' 'META-INF/*.RSA' 'META-INF/*.MF' || true
"$BT/zipalign" -f -p 4 "$tmp/in.apk" "$tmp/aligned.apk"
"$BT/apksigner" sign --ks "$(prop storeFile)" --ks-pass pass:"$(prop storePassword)" --ks-key-alias "$(prop keyAlias)" --key-pass pass:"$(prop keyPassword)" --out "$out" "$tmp/aligned.apk"
"$BT/apksigner" verify "$out"
rm -rf "$tmp"
echo "$out ($(du -h "$out" | cut -f1)) sha256 $(shasum -a 256 "$out" | cut -d' ' -f1)"
