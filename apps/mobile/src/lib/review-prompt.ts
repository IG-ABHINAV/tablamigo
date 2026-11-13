// The store rating ask on phones: Google Play's In-App Review sheet on Android and SKStoreReviewController on iOS, both through
// expo-store-review's requestReview and nothing else (no custom stars, no "do you like the app?" question first, no reward).
// When and for whom is lib/review-trigger.ts + review-policy.ts; the web app gets review-prompt.web.ts (a neutral card).
//
// Google and Apple decide on their own whether the sheet shows (Google rations it per person), so requestReview may show
// nothing and says nothing either way; the ask still counts toward the 60 days. Errors are swallowed: nothing in the app waits
// on this or is held back for it.
import { AppState, Keyboard, Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import * as StoreReview from 'expo-store-review';
import { api } from './api';
import { queryClient } from './query';
import { useSession } from './session';
import { overlayOpen } from './overlay';
import { sessionStartAfterResume } from './review-policy';
import { createReviewTrigger, type Me } from './review-trigger';

// The session clock: the app starting, or coming back after 30 minutes away.
let sessionStart = Date.now();
let backgroundAt: number | null = null;
AppState.addEventListener?.('change', st => {
  if (st === 'active') { sessionStart = sessionStartAfterResume(sessionStart, backgroundAt, Date.now()); backgroundAt = null; }
  else backgroundAt ??= Date.now();
});

const surface = Platform.OS === 'ios' ? 'ios' : 'android';
const key = (uid: string) => `tablamigo.review.v2.${uid}`;

const trigger = createReviewTrigger({
  surface,
  // Not gated on isAvailableAsync (is the Play Store app installed): anyone who got the app from Google Play has it, and on a
  // phone without it Play's review request just fails, which is caught below like any "not shown".
  supported: () => Platform.OS === 'android' || Platform.OS === 'ios',
  load: uid => SecureStore.getItemAsync(key(uid)),
  save: (uid, raw) => SecureStore.setItemAsync(key(uid), raw),
  claim: (s, t) => api('/me/review-ask', { body: { surface: s, trigger: t } }),
  show: async t => {
    console.log(`[review] requestReview called (trigger=${t})`);
    try { await StoreReview.requestReview(); console.log('[review] requestReview finished'); }
    catch (e) { console.log(`[review] requestReview not shown: ${(e as Error)?.message ?? e}`); }
  },
  me: () => (queryClient.getQueryData(['me']) as Me | undefined) ?? null,
  impersonating: () => useSession.getState().impersonating,
  screen: () => ({ active: AppState.currentState === 'active', keyboard: Keyboard.isVisible?.() ?? false, overlay: overlayOpen() }),
  sessionStart: () => sessionStart,
  now: () => Date.now(),
  wait: ms => new Promise(r => setTimeout(r, ms)),
  log: line => console.log(line),
});

/** A chat message the person sent went through. Fire and forget. */
export const reviewAfterMessageSent = () => { void trigger.messageSent(); };
/** The person just joined someone's plan as going. Fire and forget. */
export const reviewAfterPlanJoined = () => { void trigger.planJoined(); };
/** For tests: the same calls, resolving to what happened. */
export const reviewTrigger = trigger;
