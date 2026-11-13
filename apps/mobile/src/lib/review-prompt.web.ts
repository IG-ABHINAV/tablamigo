// The rating ask in the web app (and the PWA), where no store sheet exists: a small, dismissible, neutral card,
// "Enjoying Tablamigo? Rate us on Google Play" (components/ReviewCard.web.tsx), after the same moments and under the same rule as
// the phones (lib/review-trigger.ts, review-policy.ts; one 60-day cap per person across phone and web, kept by the API).
// No stars, no "do you like the app?" question first, no reward.
//
// Where: Android browsers (the link opens the Play app) and desktop browsers (the listing opens in a new tab; Play can send the
// app to the person's phone from there). Never on iPhone or iPad: there is nothing for them to rate on Google Play.
import { create } from 'zustand';
import { api } from './api';
import { queryClient } from './query';
import { useSession } from './session';
import { overlayOpen } from './overlay';
import { sessionStartAfterResume } from './review-policy';
import { createReviewTrigger, type Me } from './review-trigger';

export const PLAY_LISTING = 'https://play.google.com/store/apps/details?id=com.tablamigo.app';
export const useReviewCard = create<{ visible: boolean }>(() => ({ visible: false }));
export const hideReviewCard = () => useReviewCard.setState({ visible: false });

const ua = () => (typeof navigator === 'undefined' ? '' : navigator.userAgent);
const apple = () => /iPad|iPhone|iPod/.test(ua()) || (typeof navigator !== 'undefined' && navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
// A phone's on-screen keyboard is up while a text field has focus; a desktop keyboard covers nothing.
const touch = () => typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
const typing = () => {
  const el = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
};

let sessionStart = Date.now();
let hiddenAt: number | null = null;
if (typeof document !== 'undefined') document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { sessionStart = sessionStartAfterResume(sessionStart, hiddenAt, Date.now()); hiddenAt = null; }
  else hiddenAt ??= Date.now();
});

const key = (uid: string) => `tablamigo.review.v2.${uid}`;
const trigger = createReviewTrigger({
  surface: 'web',
  supported: () => !apple(),
  load: async uid => { try { return localStorage.getItem(key(uid)); } catch { return null; } },
  save: async (uid, raw) => { try { localStorage.setItem(key(uid), raw); } catch {} },
  claim: (s, t) => api('/me/review-ask', { body: { surface: s, trigger: t } }),
  show: async () => { useReviewCard.setState({ visible: true }); },
  me: () => (queryClient.getQueryData(['me']) as Me | undefined) ?? null,
  impersonating: () => useSession.getState().impersonating,
  screen: () => ({
    active: typeof document === 'undefined' || document.visibilityState === 'visible',
    keyboard: touch() && typing(),
    // react-native-web marks an open Modal aria-modal; components/Modal.tsx counts them too.
    overlay: overlayOpen() || (typeof document !== 'undefined' && !!document.querySelector('[aria-modal="true"]')),
  }),
  sessionStart: () => sessionStart,
  now: () => Date.now(),
  wait: ms => new Promise(r => setTimeout(r, ms)),
  log: line => console.info(line),
});

export const reviewAfterMessageSent = () => { void trigger.messageSent(); };
export const reviewAfterPlanJoined = () => { void trigger.planJoined(); };
export const reviewTrigger = trigger;
