import { router } from 'expo-router';
import { api } from './api';
import { routeForPush, openedReport } from './app-links';

// Same API as push.ts, over the browser Push API. The service worker (/app/sw.js) shows the
// notification, skips it when that chat is already focused, and posts taps back here.
export const setOpenChat = (_id: string | null) => {};

const bytes = (b64: string) => {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
};

async function subscribe(key: string) {
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes(key) });
  await api('/me/push-token', { body: { token: JSON.stringify(sub.toJSON()), platform: 'web' } });
}

// The VAPID key once registerPush has it: askPushOnIntent needs it to subscribe.
let vapidKey: string | null = null;

/**
 * Asks for notification permission at a moment of intent: adding a trip, joining a plan, sending a message. Call it first thing
 * in the tap handler (browsers, Safari above all, only show the prompt from a tap). Never on first load, never twice.
 * iPhone: Safari offers web push only to the app added to the Home Screen (iOS 16.4+); in a Safari tab this does nothing.
 */
export function askPushOnIntent() {
  if (typeof window === 'undefined' || !vapidKey || !('Notification' in window) || Notification.permission !== 'default') return;
  const key = vapidKey;
  Notification.requestPermission().then(p => p === 'granted' ? subscribe(key) : undefined).catch(() => {});
}

/** Register this browser's push subscription (when already allowed) and route taps. */
export async function registerPush() {
  const onMsg = (e: MessageEvent) => {
    if (e.data?.type !== 'open') return;
    const data = (e.data.data ?? { chatId: e.data.chatId }) as Record<string, unknown>;
    const opened = openedReport(data);
    if (opened) api('/me/notifications/opened', { body: opened }).catch(() => {});
    const to = routeForPush(data);
    if (to) router.push(to as any);
  };
  const sub = { remove: () => { navigator.serviceWorker?.removeEventListener('message', onMsg); } };
  if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return sub;
  navigator.serviceWorker.addEventListener('message', onMsg);
  try {
    const { key } = await api<{ key: string | null }>('/push/vapid-public-key', { auth: false });
    if (!key) return sub;
    await navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' });
    vapidKey = key;
    // Opened from a push while the app was closed: the service worker put the event in the query string (public/sw.js).
    const q = new URLSearchParams(window.location.search);
    const opened = openedReport({ nkind: q.get('nkind'), nref: q.get('nref') });
    if (opened) api('/me/notifications/opened', { body: opened }).catch(() => {});
    if (Notification.permission === 'granted') await subscribe(key);
  } catch (e) {
    if (__DEV__) console.log('push unavailable:', (e as Error).message);
  }
  return sub;
}

export type { PushMoment, NotificationState } from './push-policy';
import type { PushMoment, NotificationState } from './push-policy';

/** The web app already asked from the tap itself (askPushOnIntent): browsers only prompt from a tap. */
export async function askPushAfterValue(_moment: PushMoment, _now = Date.now()): Promise<boolean> { return false; }

/** Profile > Notifications on the web: the browser's permission for this site. */
export async function notificationState(): Promise<NotificationState> {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'blocked';
  return Notification.permission === 'granted' ? 'on' : Notification.permission === 'denied' ? 'blocked' : 'off';
}

/** Asks while the browser still can (called from the button's tap); a site the browser blocked can only be unblocked there. */
export async function fixNotifications(): Promise<NotificationState> {
  const s = await notificationState();
  if (s !== 'off') return s;
  if (!vapidKey) return 'blocked';   // push is not set up for this site: nothing to ask
  const key = vapidKey;
  const p = await Notification.requestPermission().catch(() => 'default' as NotificationPermission);
  if (p === 'granted') { await subscribe(key).catch(() => {}); return 'on'; }
  return p === 'denied' ? 'blocked' : 'off';
}

export async function syncNotifications(): Promise<NotificationState> {
  const s = await notificationState();
  if (s === 'on' && vapidKey) await subscribe(vapidKey).catch(() => {});
  return s;
}

const ONBOARDING_KEY = 'tablamigo.push-onboarding-offered';
const offeredHere = () => { try { return window.localStorage.getItem(ONBOARDING_KEY) === '1'; } catch { return false; } };

/**
 * Right after onboarding (app/start.tsx): the same in-app explanation as the Android app, once per browser, only while this
 * browser can still ask (permission 'default') and push is set up for the site. A Safari tab on iPhone has no Notification
 * API (web push needs the Home Screen app), so it is never offered there.
 */
export async function offerPushAfterOnboarding(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window) || !vapidKey) return false;
  if (Notification.permission !== 'default' || offeredHere()) return false;
  try { window.localStorage.setItem(ONBOARDING_KEY, '1'); } catch { /* shown again next time: harmless */ }
  return true;
}

/** "Turn on": called from the button's tap, so the browser shows its prompt. True when allowed. */
export async function acceptPushOffer(): Promise<boolean> { return (await fixNotifications()) === 'on'; }

/** "Not now": nothing to undo; the web app asks again from the next trip or plan tap (askPushOnIntent). */
export function declinePushOffer() {}
