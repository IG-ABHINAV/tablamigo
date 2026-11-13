// The web app has no store to update from: a browser loads the new build on its own and lib/pwa.ts already handles the
// service worker. Everything the Android side exports is here as a no-op, so app/_layout.tsx and components/UpdateBanner.tsx
// are the same file on both platforms. (On iOS the Android file is used and does nothing: Platform.OS is not 'android'.)
import { create } from 'zustand';

export const useUpdateBanner = create<{ versionCode: number | null }>(() => ({ versionCode: null }));

export function startUpdateChecks() {}
export const installUpdate = async () => false;
export const dismissUpdateBanner = () => {};
