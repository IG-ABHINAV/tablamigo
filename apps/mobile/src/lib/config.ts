import { Platform } from 'react-native';
// Dev: the Android emulator reaches the host machine at 10.0.2.2.
const devUrl = Platform.OS === 'android' ? 'http://10.0.2.2:4100' : 'http://localhost:4100';
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? (__DEV__ ? devUrl : 'https://tablamigo-api.hookstep.in');
export const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';
export const APP_NAME = 'Tablamigo';
// "Continue with Google": the Android app and the web app both ask Google for an ID token issued to this web OAuth
// client, which is the audience the API checks. A public identifier. The two Android OAuth clients (Play signing key,
// upload key) only have to exist in the same Google Cloud project, tablamigo-f460a.
export const GOOGLE_WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '316890004786-11d9pklbq4phqa7vk3a99vfiol2qsc1s.apps.googleusercontent.com';

// Features added unreviewed between 1 and 3 Oct 2026 and hidden after the audit (audit-2026-10-03/PUNCHLIST.md).
// The API refuses the same things (apps/api/src/lib/config.ts `features`, and the bundle route is gone), so turning
// one on here alone does nothing. Each needs its server-side work first:
// - paidEvents: Razorpay Checkout in the app, refunds, host payouts. The server only issues a ticket for a payment it verified.
// - idVerification: a private bucket for ID images, an admin review screen, a legal view on Aadhaar.
// - tripPassBundles: real Play products and verified Razorpay orders; the wallet is only credited after payment.
// - voiceNotes: real recording (expo-audio, RECORD_AUDIO) and upload; the server only accepts the sender's own upload.
//
// Preview-only screens, hidden for the same audit ("Preview-only features"). The code stays; each needs the real thing first:
// - languagePicker: Hindi and Spanish. 24 strings exist and one screen reads them; the rest of the app is English only.
// - themePicker: dark mode. The choice is saved, but every screen draws with the one light palette in lib/theme.ts.
// - offlinePack: the "offline cache" on Saved Plans. Sync Pack fetches the list and shows a toast; nothing is stored on the phone.
export const FEATURES = {
  paidEvents: process.env.EXPO_PUBLIC_FEATURE_PAID_EVENTS === 'on',
  idVerification: process.env.EXPO_PUBLIC_FEATURE_ID_VERIFICATION === 'on',
  tripPassBundles: false,
  voiceNotes: false,
  languagePicker: false,
  themePicker: false,
  offlinePack: false,
};
