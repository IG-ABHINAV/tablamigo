import { Platform } from 'react-native';
import * as Application from 'expo-application';

// The Play Store install referrer ("utm_source=invite&utm_medium=app", or Play's own "utm_source=google-play&utm_medium=organic"),
// sent with the sign-in that creates the account, so an Android sign-up can be tied to the Meta ad or the invite link that
// brought it. Before, every Android sign-up was recorded as 'Google Play' with no campaign. The API reads the utm_* values out
// of it (routes/auth.ts parseAttribution). Android only; read once per app run; never throws.
let cached: Promise<string | null> | null = null;
export function installReferrer(): Promise<string | null> {
  if (Platform.OS !== 'android') return Promise.resolve(null);
  cached ??= Application.getInstallReferrerAsync().then(r => (r ? r.slice(0, 500) : null)).catch(() => null);
  return cached;
}

/** What the sign-in calls add to their body: { install_referrer } when there is one. */
export async function signupExtras(): Promise<{ install_referrer?: string }> {
  const r = await installReferrer();
  return r ? { install_referrer: r } : {};
}
