// When the app asks for notification permission (lib/push.ts, push.web.ts). Plain, so it is unit-tested.

export type PushMoment = 'trip' | 'plan';
export type NotificationState = 'on' | 'off' | 'blocked';

/** The pre-prompt before the phone's own prompt shows at most once in this long. */
export const PRE_PROMPT_EVERY_MS = 7 * 86_400_000;

/**
 * After a trip is added or a plan joined: 'register' when notifications are already allowed (make sure the token is
 * saved), 'prompt' when the phone can still ask and the pre-prompt was not shown in the last week, 'skip' otherwise
 * (refused for good: only the phone's settings can change that, from Profile > Notifications).
 */
export function pushAskDecision(p: { status: string; canAskAgain: boolean }, lastPromptAt: number | null, now: number): 'register' | 'prompt' | 'skip' {
  if (p.status === 'granted') return 'register';
  if (!p.canAskAgain) return 'skip';
  if (lastPromptAt && now - lastPromptAt < PRE_PROMPT_EVERY_MS) return 'skip';
  return 'prompt';
}

/**
 * Right after onboarding: our own short explanation once per install (ONBOARDING_PRE_PROMPT), then the phone's prompt only if
 * the person taps "Turn on". 'register' when notifications are already allowed, 'offer' when they are off, the phone can still
 * ask and this install has not offered it yet, 'skip' otherwise. Since 1.4.2 the app asked only after a trip or a joined plan,
 * and most new people never got there: 2 of 8 new Android app accounts had a push token from 4 to 12 Nov 2026, against 10 of
 * 16 before (user-journey audit, 12 Nov). A "Not now" here leaves the post-join ask (pushAskDecision) free to ask once later.
 */
export function onboardingAskDecision(p: { status: string; canAskAgain: boolean }, alreadyOffered: boolean): 'register' | 'offer' | 'skip' {
  if (p.status === 'granted') return 'register';
  if (!p.canAskAgain || alreadyOffered) return 'skip';
  return 'offer';
}

/** The in-app explanation after onboarding, shown before the phone's own prompt. */
export const ONBOARDING_PRE_PROMPT = {
  title: 'Turn on notifications?',
  body: 'Get a ping when someone plans a trip to your city or replies to you.',
  yes: 'Turn on',
  no: 'Not now',
};

/**
 * Whether the phone can still show its own prompt. Android 13+ reports importance 0 (none) for every app that does not hold
 * the permission yet, a fresh install included (expo-notifications: areNotificationsEnabled() is false until it is granted),
 * so importance 0 means "switched off in the phone's settings" only once notifications were allowed on this install. Reading
 * it as blocked before that meant a fresh install was never asked and Profile sent it to the settings (QA of 1.4.1, 1 Nov 2026).
 */
export function phoneCanAsk(p: { canAskAgain?: boolean; android?: { importance?: number } }, wasAllowed: boolean): boolean {
  if (p.canAskAgain === false) return false;
  return !(wasAllowed && p.android?.importance === 0);
}

/** Profile > Notifications' button: ask while the phone still can, else open the phone's settings (also to turn it off). */
export const notificationsAction = (s: NotificationState): 'ask' | 'settings' => (s === 'off' ? 'ask' : 'settings');

/** The row's words. A browser cannot open its own settings, so on the web only "Turn on" is a button. */
export function notificationsRow(s: NotificationState, web = false): { detail: string; button: string | null; note: string } {
  if (web && s === 'on') return { detail: 'On', button: null, note: 'Messages, plan changes and trip matches arrive as notifications. Change this in your browser\'s site settings.' };
  if (web && s === 'blocked') return { detail: 'Off', button: null, note: "This browser blocks notifications from Tablamigo. Allow them in the browser's site settings (on iPhone, add Tablamigo to the Home Screen first)." };
  if (s === 'on') return { detail: 'On', button: 'Manage in settings', note: 'Messages, plan changes and trip matches arrive as notifications.' };
  if (s === 'blocked') return { detail: 'Off', button: 'Open settings', note: "Notifications are off for Tablamigo in your phone's settings. Turn them on there to hear about messages and plans." };
  return { detail: 'Off', button: 'Turn on', note: "You won't hear about new messages or plan changes until you turn them on." };
}
