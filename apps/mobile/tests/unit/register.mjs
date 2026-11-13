// Loaded with `node --import ./tests/unit/register.mjs --test ...` (npm run test:unit). Lets node:test import the app's own
// TypeScript libs (src/lib/*.ts) the way Metro does, with no bundler:
//  - extensionless relative imports ('./config') resolve to the .ts file next to the importer;
//  - native modules that only exist inside the app (react-native, expo-secure-store, expo-image-picker, expo-file-system,
//    expo-notifications, expo-router, expo-iap, expo-store-review) and socket.io-client resolve to small in-memory stubs in ./stubs, which the tests
//    inspect and steer.
// Node strips the types itself (Node 22.6+ with --experimental-strip-types, default from Node 23.6). Components (.tsx) need
// a real renderer and are covered by the browser pass (e2e-web/drive.mjs), not here.
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const STUBS = {
  'react-native': './stubs/react-native.mjs',
  'expo-secure-store': './stubs/expo-secure-store.mjs',
  'socket.io-client': './stubs/socket.io-client.mjs',
  'expo-image-picker': './stubs/expo-image-picker.mjs',
  'expo-file-system/legacy': './stubs/expo-file-system-legacy.mjs',
  'expo-notifications': './stubs/expo-notifications.mjs',
  'expo-router': './stubs/expo-router.mjs',
  'expo-iap': './stubs/expo-iap.mjs',
  'expo-store-review': './stubs/expo-store-review.mjs',
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (STUBS[specifier]) return { url: new URL(STUBS[specifier], import.meta.url).href, shortCircuit: true };
    const fromTs = context.parentURL?.endsWith('.ts');
    if (fromTs && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (fs.existsSync(fileURLToPath(candidate))) return { url: candidate.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

// What Metro defines for a release build; config.ts reads both at import time.
globalThis.__DEV__ = false;
process.env.EXPO_PUBLIC_API_URL ??= 'http://api.unit.test';
