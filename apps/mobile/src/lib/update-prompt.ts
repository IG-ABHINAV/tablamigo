// Google Play's in-app update, wired up for the Android app: what update-runner.ts needs from the phone, and the banner's
// state. The web app gets update-prompt.web.ts (nothing: a browser reloads the new version by itself).
//
// Started once from app/_layout.tsx, then on every return to the foreground. Everything is fire and forget: a person never
// waits for this, and a phone with no Play Store, no network or an old API sees nothing at all.
import { AppState, Platform } from 'react-native';
import * as Application from 'expo-application';
import * as SecureStore from 'expo-secure-store';
import { create } from 'zustand';
import { api, trackEvent } from './api';
import { addUpdateListener, check, inAppUpdatesAvailable, install, start } from '../../modules/in-app-updates';
import { parseMinCode } from './update-policy';
import { createUpdateRunner } from './update-runner';

const KEY = 'tablamigo.app-update.v1';

/** The "Update ready - Restart" banner (components/UpdateBanner.tsx). */
export const useUpdateBanner = create<{ versionCode: number | null }>(() => ({ versionCode: null }));

// Application.nativeBuildVersion is android.versionCode as a string; 0 when it cannot be read, which the policy treats as
// a build that is below every floor, so a mandatory update still applies.
const currentCode = () => Math.max(0, Math.floor(Number(Application.nativeBuildVersion ?? 0)) || 0);

const runner = createUpdateRunner({
  platform: Platform.OS,
  supported: () => Platform.OS === 'android' && inAppUpdatesAvailable(),
  currentCode,
  load: () => SecureStore.getItemAsync(KEY),
  save: raw => SecureStore.setItemAsync(KEY, raw),
  // Public and unauthenticated: the check runs at app start, which can be before anyone has signed in.
  minCode: async () => parseMinCode((await api<{ androidMinVersionCode: number | null }>('/app/min-version', { auth: false }))?.androidMinVersionCode),
  check,
  start,
  install,
  showBanner: versionCode => useUpdateBanner.setState({ versionCode }),
  hideBanner: () => useUpdateBanner.setState({ versionCode: null }),
  track: (event, properties) => trackEvent(event, properties),
  now: () => Date.now(),
  log: line => console.log(line),
});

let started = false;
/** Called once from the root layout. Safe to call again; later calls do nothing. */
export function startUpdateChecks() {
  if (started || Platform.OS !== 'android') return;
  started = true;
  addUpdateListener('downloaded', () => { void runner.downloaded(); });
  addUpdateListener('installed', () => { void runner.installed(); });
  addUpdateListener('failed', p => { void runner.failed('install', p?.code); });
  addUpdateListener('cancelled', p => { void runner.cancelled(String(p?.where ?? 'dialog')); });
  AppState.addEventListener?.('change', s => { if (s === 'active') void runner.run(); });
  void runner.run();
}

/** The banner's button. Play then shows its own notice and restarts the app. */
export const installUpdate = () => runner.install();
export const dismissUpdateBanner = () => runner.dismissBanner();
/** For tests and the QA build. */
export const updateRunner = runner;
