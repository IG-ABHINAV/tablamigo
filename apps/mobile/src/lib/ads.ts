// Google AdMob in the Android app: consent first, then the SDK, then the one banner (components/ExploreAd.tsx). Off unless the
// build sets ADS_ENABLED=on (apps/mobile/ads-env.js); the web app uses ads.web.ts, which has no ads. The consent logic itself is
// lib/ads-consent.ts (unit-tested); this file only wires it to the real SDK and to the store the screens read.
import Constants from 'expo-constants';
import { Platform } from 'react-native';
import { create } from 'zustand';
import { readAdsExtra } from './ads-config';
import { createAdsGate, type AdsSdk, type AdsState } from './ads-consent';

export const ADS = readAdsExtra(Constants.expoConfig?.extra?.ads, Platform.OS);

type Gma = typeof import('react-native-google-mobile-ads');
// Required only in a build that links the SDK: importing the package without its native module throws at once, and a build
// with ADS_ENABLED off doesn't link it (react-native.config.js). If the two ever disagree, the app loses its ads, not its launch.
function loadGma(): Gma | null {
  if (!ADS.enabled) return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-google-mobile-ads');
  } catch (e) {
    console.warn('Ads are on in this build but the Google Mobile Ads SDK is not linked; no ads.', e);
    return null;
  }
}
export const gma = loadGma();

export const useAds = create<AdsState>(() => ({ ready: false, privacyOptions: false }));

const gate = createAdsGate(gma as AdsSdk | null, s => useAds.setState(s), () => useAds.getState());

/** Google's consent step, then the SDK (lib/ads-consent.ts). A no-op in a build without ads. */
export const startAds = (): Promise<void> => gate.start();

/** Profile's "Ad privacy choices". */
export const openAdPrivacyOptions = (): Promise<void> => gate.openPrivacyOptions();
