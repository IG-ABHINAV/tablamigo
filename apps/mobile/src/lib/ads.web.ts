// The web app (PWA) shows no ads: AdMob is an Android-only SDK. Same exports as ads.ts, all inert.
import { create } from 'zustand';
import type { AdsExtra } from './ads-config';

export const ADS: AdsExtra = { enabled: false, bannerUnitId: '', testIds: false };
export const gma = null;
export const useAds = create<{ ready: boolean; privacyOptions: boolean }>(() => ({ ready: false, privacyOptions: false }));
export const startAds = (): Promise<void> => Promise.resolve();
export const openAdPrivacyOptions = (): Promise<void> => Promise.resolve();
