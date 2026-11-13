import { Alert, Linking, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { api, trackEvent } from './api';
import { routeForPush, openedReport } from './app-links';
import { pushAskDecision, onboardingAskDecision, notificationsAction, phoneCanAsk, type PushMoment, type NotificationState } from './push-policy';
export type { PushMoment, NotificationState } from './push-policy';

// The chat on screen right now; its pushes are shown in the chat itself, not as a banner.
let openChatId: string | null = null;
export const setOpenChat = (id: string | null) => { openChatId = id; };

Notifications.setNotificationHandler({
  handleNotification: async n => {
    const here = !!openChatId && n.request.content.data?.chatId === openChatId;
    return { shouldShowBanner: !here, shouldShowList: !here, shouldPlaySound: !here, shouldSetBadge: false };
  },
});

const openFrom = (r: Notifications.NotificationResponse | null) => {
  const data = r?.notification.request.content.data as Record<string, unknown> | undefined;
  // The email ladder (apps/api/src/lib/ladder.ts) only emails what was not opened.
  const opened = openedReport(data);
  if (opened) api('/me/notifications/opened', { body: opened }).catch(() => {});
  const to = routeForPush(data);
  if (to) router.push(to as any);
};

/** Native: the moment of intent is after the action succeeds (askPushAfterValue); only the web app asks from the tap itself. */
export const askPushOnIntent = () => {};

/**
 * What became of a push setup, sent as analytics event push_registration. An account with no token was a mystery before
 * (ops-health TM-11, 29 Oct 2026: about half of new Android accounts had none): nothing said whether the person said no,
 * the phone gave no token or the save failed. The API adds push_token_gone when FCM later drops a token (uninstalled).
 * off = not allowed and the phone can still ask (we no longer ask at start); blocked = only the phone's settings can turn it on;
 * not_now = "Not now" on our explanation; denied = no to the phone's own prompt.
 */
type Outcome = 'registered' | 'no_token' | 'save_failed' | 'off' | 'blocked' | 'not_now' | 'denied' | 'error';
const platform = () => (Platform.OS === 'ios' ? 'ios' : 'android');
// at: where the ask came from ('onboarding' for the pre-prompt after onboarding; left out elsewhere, as before).
const report = (outcome: Outcome, asked: boolean, error?: unknown, at?: 'onboarding') => trackEvent('push_registration', {
  outcome, platform: platform(), os: String(Platform.Version ?? ''), asked,
  ...(at ? { at } : {}),
  ...(error ? { error: String((error as Error)?.message ?? error).slice(0, 160) } : {}),
});
const saveToken = (token: unknown) => api('/me/push-token', { body: { token: String(token), platform: platform() } });

// FCM can hand this install a new token while the app runs; without a listener the old one dies and pushes stop until the
// next launch. One listener for the session, removed with registerPush's subscription (sign-out).
let rotation: { remove(): void } | null = null;

/** Register this device's FCM token with the API and report the outcome. Quietly nothing if the build has no Firebase config. */
async function registerToken(asked = false, at?: 'onboarding') {
  await markAllowed();
  let token: unknown;
  try { token = (await Notifications.getDevicePushTokenAsync()).data; }
  catch (e) { report('no_token', asked, e, at); if (__DEV__) console.log('push unavailable:', (e as Error).message); return; }
  try { await saveToken(token); }
  catch (e) { report('save_failed', asked, e, at); return; }
  rotation ??= Notifications.addPushTokenListener(t => { saveToken(t.data).catch(() => {}); });
  report('registered', asked, undefined, at);
}

/**
 * Route taps to their chat and, if notifications are already allowed, register the token. Never asks: the phone used to ask
 * the moment Explore first opened, straight after the location prompt (QA 1 Nov 2026), before the person had any reason
 * to say yes. Asking now happens after they add a trip or join a plan (askPushAfterValue) or from Profile > Notifications.
 */
export async function registerPush() {
  const taps = Notifications.addNotificationResponseReceivedListener(openFrom);
  const sub = { remove: () => { taps.remove(); rotation?.remove(); rotation = null; } };
  Notifications.getLastNotificationResponseAsync().then(openFrom).catch(() => {});
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', { name: 'Messages and plans', importance: Notifications.AndroidImportance.HIGH, lightColor: '#FF5A36' });
    }
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status === 'granted') await registerToken();
    else report((await canAsk(perm)) ? 'off' : 'blocked', false);
  } catch (e) {
    // The channel or the permission call itself failed: still say so, or this account is another unexplained gap.
    report('error', false, e);
    if (__DEV__) console.log('push unavailable:', (e as Error).message);
  }
  return sub;
}

/** After the phone's own prompt: register, or say whether it was a no the phone can ask again or a final one. */
async function afterAsking(r: Notifications.NotificationPermissionsStatus, at?: 'onboarding') {
  if (r.status === 'granted') await registerToken(true, at);
  else report((await canAsk(r)) ? 'denied' : 'blocked', true, undefined, at);
}

const ONBOARDING_KEY = 'tablamigo.push-onboarding-offered';

/**
 * Right after onboarding (app/start.tsx): true when the in-app explanation should show now (lib/push-policy.ts
 * onboardingAskDecision), and then it is marked as offered on this install, so it shows once. Already allowed: registers the
 * token and returns false. Never throws.
 */
export async function offerPushAfterOnboarding(): Promise<boolean> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    const offered = (await SecureStore.getItemAsync(ONBOARDING_KEY).catch(() => null)) === '1';
    const next = onboardingAskDecision({ status: perm.status, canAskAgain: await canAsk(perm) }, offered);
    if (next === 'register') { await registerToken(); return false; }
    if (next === 'skip') return false;
    await SecureStore.setItemAsync(ONBOARDING_KEY, '1').catch(() => {});
    return true;
  } catch { return false; }
}

/** "Turn on" on the onboarding explanation: the phone's own prompt, then register or report the no. True when allowed. */
export async function acceptPushOffer(): Promise<boolean> {
  try {
    const r = await Notifications.requestPermissionsAsync();
    await afterAsking(r, 'onboarding');
    return r.status === 'granted';
  } catch (e) { report('error', true, e, 'onboarding'); return false; }
}

/**
 * "Not now" on the onboarding explanation. Only reported: the post-join ask (askPushAfterValue) keeps its own once-a-week
 * clock, so it still asks after the person's first trip or plan, as the fallback.
 */
export function declinePushOffer() { report('not_now', false, undefined, 'onboarding'); }

const PROMPTED_KEY = 'tablamigo.push-preprompt-at';
const PRE_PROMPT: Record<PushMoment, { title: string; body: string }> = {
  trip: { title: 'Know who else is coming', body: "Turn on notifications and we'll tell you when another traveler will be in your trip's city on your dates, and when someone messages you." },
  plan: { title: "Don't miss the plan", body: 'Turn on notifications to hear when the group chat gets a message, the plan changes or someone is running late.' },
};

/**
 * After someone adds a trip or joins a plan: if notifications are not on yet and the phone can still ask, a short
 * explanation first ("Not now" or "Turn on"), then the phone's own prompt. Shown at most once a week, so it never nags.
 * Already allowed: just makes sure the token is registered. Refused for good: nothing (Profile > Notifications opens settings).
 */
export async function askPushAfterValue(moment: PushMoment, now = Date.now()): Promise<boolean> {
  try {
    const perm = await Notifications.getPermissionsAsync();
    const last = Number(await SecureStore.getItemAsync(PROMPTED_KEY).catch(() => null)) || null;
    const next = pushAskDecision({ status: perm.status, canAskAgain: await canAsk(perm) }, last, now);
    if (next === 'register') { await registerToken(); return false; }
    if (next === 'skip') return false;
    await SecureStore.setItemAsync(PROMPTED_KEY, String(now)).catch(() => {});
    const copy = PRE_PROMPT[moment];
    Alert.alert(copy.title, copy.body, [
      { text: 'Not now', style: 'cancel', onPress: () => report('not_now', false) },
      { text: 'Turn on', onPress: () => { Notifications.requestPermissionsAsync().then(afterAsking).catch(e => report('error', true, e)); } },
    ]);
    return true;
  } catch { return false; /* never in the way of the trip or the plan */ }
}

/**
 * Whether the phone can still show its prompt. Android 13+: someone who allowed and then switched notifications off in
 * the phone's settings reads as denied with canAskAgain true, but asking shows nothing; importance 0 (none) then means only
 * the settings can turn it back on. A fresh install reads importance 0 too, so it counts only after notifications were
 * allowed here (push-policy.ts phoneCanAsk).
 */
const ALLOWED_KEY = 'tablamigo.push-was-allowed';
const wasAllowed = async () => (await SecureStore.getItemAsync(ALLOWED_KEY).catch(() => null)) === '1';
const markAllowed = () => SecureStore.setItemAsync(ALLOWED_KEY, '1').catch(() => {});
const canAsk = async (p: Notifications.NotificationPermissionsStatus) => phoneCanAsk(p as any, await wasAllowed());

/** What Profile > Notifications shows: on, off (the phone can still ask) or blocked (only the phone's settings can turn it on). */
export async function notificationState(): Promise<NotificationState> {
  try {
    const p = await Notifications.getPermissionsAsync();
    return p.status === 'granted' ? 'on' : (await canAsk(p)) ? 'off' : 'blocked';
  } catch { return 'off'; }
}

/** Profile > Notifications: asks when the phone still can, otherwise opens this app's page in the phone's settings. */
export async function fixNotifications(): Promise<NotificationState> {
  const state = await notificationState();
  if (notificationsAction(state) === 'ask') {
    const r = await Notifications.requestPermissionsAsync().catch(() => null);
    if (r) await afterAsking(r);
    if (r?.status === 'granted') return 'on';
    return r && (await canAsk(r)) ? 'off' : 'blocked';   // a "no" just now: the row offers the settings next, it does not jump there
  }
  await Linking.openSettings().catch(() => {});
  return state;
}

/** Back from the phone's settings: if notifications are on now, register the token. */
export async function syncNotifications(): Promise<NotificationState> {
  const state = await notificationState();
  if (state === 'on') await registerToken();
  return state;
}
