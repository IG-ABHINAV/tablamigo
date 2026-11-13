// 1 Nov 2026 (owner's decisions after the Android QA pass): notifications are asked for after a trip is added or a plan
// joined, with a short reason first, and can be fixed from Profile > Notifications; trips and plans get real date and time
// pickers; an empty Trip Circle is hidden.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import * as notifications from 'expo-notifications';
import { store } from 'expo-secure-store';
import { Alert, Linking, Platform } from 'react-native';
import { askPushAfterValue, notificationState, fixNotifications, syncNotifications } from '../../src/lib/push.ts';
import { pushAskDecision, notificationsAction, notificationsRow, phoneCanAsk, PRE_PROMPT_EVERY_MS } from '../../src/lib/push-policy.ts';
import { toPickerDay, fromPickerDay, daysBetween, webInputValue, fromWebInput, withTime, clampDate, localDay } from '../../src/lib/date-pick.ts';
import { showTripCircle, EMPTY_CIRCLE_NOTE } from '../../src/lib/trip-circle.ts';
import { useSession } from '../../src/lib/session.ts';

const API = process.env.EXPO_PUBLIC_API_URL;
let calls = [];
globalThis.fetch = async (url, init = {}) => { calls.push({ path: url.slice(API.length), body: init.body ? JSON.parse(init.body) : undefined }); return new Response('{"ok":true}', { status: 200 }); };
const flush = () => new Promise(r => setTimeout(r, 0));
// The API calls other than analytics (push_registration is fire-and-forget), and the push_registration outcomes sent.
const apiPaths = () => calls.filter(c => c.path !== '/analytics/events').map(c => c.path);
const outcomes = () => calls.filter(c => c.path === '/analytics/events' && c.body.event === 'push_registration').map(c => [c.body.properties.outcome, c.body.properties.asked]);
const lastAlert = () => Alert.calls[Alert.calls.length - 1];
const tap = async (alert, text) => { alert[2].find(b => b.text === text).onPress?.(); await flush(); await flush(); };

beforeEach(async () => {
  calls = []; Alert.calls.length = 0; notifications.reset(); store.clear(); Platform.OS = 'android'; Linking.settingsOpened = 0;
  await useSession.getState().setTokens({ accessToken: 'a', refreshToken: 'r' });
});

test('policy: register when allowed, pre-prompt when the phone can ask and not shown this week, else nothing', () => {
  const now = Date.UTC(2026, 10, 1);
  assert.equal(pushAskDecision({ status: 'granted', canAskAgain: true }, null, now), 'register');
  assert.equal(pushAskDecision({ status: 'undetermined', canAskAgain: true }, null, now), 'prompt');
  assert.equal(pushAskDecision({ status: 'undetermined', canAskAgain: true }, now - 86_400_000, now), 'skip');
  assert.equal(pushAskDecision({ status: 'undetermined', canAskAgain: true }, now - PRE_PROMPT_EVERY_MS - 1, now), 'prompt');
  assert.equal(pushAskDecision({ status: 'denied', canAskAgain: false }, null, now), 'skip');
  assert.equal(notificationsAction('off'), 'ask');
  assert.equal(notificationsAction('blocked'), 'settings');
  assert.equal(notificationsAction('on'), 'settings');
  assert.deepEqual([notificationsRow('on').button, notificationsRow('off').button, notificationsRow('blocked').button], ['Manage in settings', 'Turn on', 'Open settings']);
});

test('after a trip: a reason first; "Turn on" asks the phone and registers the token; not again within a week', async () => {
  notifications.state.permission = 'undetermined';
  await askPushAfterValue('trip', 1_000);
  assert.equal(notifications.state.asked, 0, 'the phone is not asked before the person says yes');
  assert.match(lastAlert()[0], /who else is coming/i);
  await tap(lastAlert(), 'Turn on');
  assert.equal(notifications.state.asked, 1);
  assert.deepEqual(apiPaths(), ['/me/push-token']);
  // A week later the phone is allowed: nothing is shown, the token is (re)registered.
  Alert.calls.length = 0; calls = [];
  await askPushAfterValue('plan', 2_000);
  assert.equal(Alert.calls.length, 0);
  assert.deepEqual(apiPaths(), ['/me/push-token']);
});

test('"Not now" asks nothing and the reason is not shown again for a week; refused for good means no more asking', async () => {
  notifications.state.permission = 'undetermined';
  await askPushAfterValue('plan', 10_000);
  assert.match(lastAlert()[0], /Don't miss the plan/);
  await tap(lastAlert(), 'Not now');
  assert.equal(notifications.state.asked, 0);
  Alert.calls.length = 0;
  await askPushAfterValue('trip', 10_000 + 86_400_000);
  assert.equal(Alert.calls.length, 0, 'not again the next day');
  await askPushAfterValue('trip', 10_000 + PRE_PROMPT_EVERY_MS + 1);
  assert.equal(Alert.calls.length, 1, 'again after a week');
  notifications.state.permission = 'denied'; notifications.state.canAskAgain = false; Alert.calls.length = 0;
  await askPushAfterValue('trip', 10_000 + 3 * PRE_PROMPT_EVERY_MS);
  assert.equal(Alert.calls.length, 0);
});

test('Profile > Notifications: off asks the phone, blocked opens the phone settings, on comes back registered', async () => {
  notifications.state.permission = 'undetermined';
  assert.equal(await notificationState(), 'off');
  notifications.state.afterAsking = 'denied';
  assert.equal(await fixNotifications(), 'blocked');
  assert.equal(notifications.state.asked, 1);
  assert.equal(await fixNotifications(), 'blocked');
  assert.equal(Linking.settingsOpened, 1, 'refused for good: the phone settings open');
  assert.equal(notifications.state.asked, 1, 'the phone is not asked again');
  // Back from the settings with notifications on.
  notifications.state.permission = 'granted'; calls = [];
  assert.equal(await syncNotifications(), 'on');
  assert.deepEqual(apiPaths(), ['/me/push-token']);
});

test('Android 13: switched off in the phone settings after allowing (importance 0) is blocked: settings open, no pre-prompt', async () => {
  // Allowed first on this install (the app registers the token at its next start), then switched off in the settings.
  assert.equal(await syncNotifications(), 'on');
  Alert.calls.length = 0;
  notifications.state.permission = 'denied'; notifications.state.canAskAgain = true; notifications.state.importance = 0; notifications.state.afterAsking = 'denied';
  assert.equal(await notificationState(), 'blocked');
  assert.equal(await askPushAfterValue('trip', 5), false);
  assert.equal(Alert.calls.length, 0);
  assert.equal(await fixNotifications(), 'blocked');
  assert.equal(Linking.settingsOpened, 1);
});

test('Android 13 fresh install: never asked reads importance 0 too, and still gets the reason, then the phone prompt', async () => {
  // expo-notifications on API 33+: no permission yet means areNotificationsEnabled() false, so status denied and importance 0
  // (QA of 1.4.1 on an Android 15 emulator, 1 Nov 2026: no prompt after joining a plan, Profile said "Open settings").
  notifications.state.permission = 'denied'; notifications.state.canAskAgain = true; notifications.state.importance = 0;
  assert.equal(await notificationState(), 'off');
  assert.equal(await askPushAfterValue('plan', 1), true);
  assert.match(lastAlert()[0], /Don't miss the plan/);
  await tap(lastAlert(), 'Turn on');
  assert.equal(notifications.state.asked, 1);
  assert.deepEqual(apiPaths(), ['/me/push-token']);
});

test('phoneCanAsk: importance 0 blocks only after notifications were allowed on this install', () => {
  assert.equal(phoneCanAsk({ canAskAgain: true, android: { importance: 0 } }, false), true);
  assert.equal(phoneCanAsk({ canAskAgain: true, android: { importance: 0 } }, true), false);
  assert.equal(phoneCanAsk({ canAskAgain: true, android: { importance: 3 } }, true), true);
  assert.equal(phoneCanAsk({ canAskAgain: false }, false), false);
  assert.equal(phoneCanAsk({ canAskAgain: true }, false), true);
});

test('the pre-prompt says whether it showed (the store rating ask waits for a join without one)', async () => {
  notifications.state.permission = 'undetermined';
  assert.equal(await askPushAfterValue('plan', 1), true);
  assert.equal(await askPushAfterValue('plan', 2), false);
  notifications.reset();
  assert.equal(await askPushAfterValue('plan', 3), false, 'already allowed: nothing shown');
});

test('web row: no button where a browser cannot open its own settings', () => {
  assert.equal(notificationsRow('on', true).button, null);
  assert.equal(notificationsRow('blocked', true).button, null);
  assert.match(notificationsRow('blocked', true).note, /site settings/);
  assert.equal(notificationsRow('off', true).button, 'Turn on');
});

test('date picker: local days cross the Android dialog as UTC midnight of the same day, both ways', () => {
  const d = new Date(2026, 10, 8, 0, 0);             // 8 Nov, local midnight (in India: 7 Nov 18:30 UTC)
  assert.equal(toPickerDay(d).toISOString(), '2026-11-08T00:00:00.000Z');
  const back = fromPickerDay(new Date('2026-11-08T00:00:00Z'));
  assert.deepEqual([back.getFullYear(), back.getMonth(), back.getDate(), back.getHours()], [2026, 10, 8, 0]);
  assert.equal(daysBetween(new Date(2026, 10, 1, 23, 0), new Date(2026, 10, 8, 1, 0)), 7);
  assert.equal(daysBetween(new Date(2026, 11, 28), new Date(2027, 0, 3)), 6);
  assert.deepEqual(localDay(new Date(2026, 10, 8, 15, 30)), new Date(2026, 10, 8));
});

test('date picker: browser input values both ways, a time keeps its day, and picks stay inside min and max', () => {
  const d = new Date(2026, 10, 8, 19, 5);
  assert.equal(webInputValue('date', d), '2026-11-08');
  assert.equal(webInputValue('time', d), '19:05');
  assert.equal(webInputValue('datetime', d), '2026-11-08T19:05');
  assert.deepEqual(fromWebInput('date', '2026-11-08'), new Date(2026, 10, 8));
  assert.deepEqual(fromWebInput('time', '07:30', d), new Date(2026, 10, 8, 7, 30));
  assert.deepEqual(fromWebInput('datetime', '2026-12-01T18:45'), new Date(2026, 11, 1, 18, 45));
  assert.equal(fromWebInput('date', ''), null);
  assert.deepEqual(withTime(new Date(2026, 10, 9), new Date(2000, 0, 1, 18, 30)), new Date(2026, 10, 9, 18, 30));
  const min = new Date(2026, 10, 1, 12), max = new Date(2026, 10, 30);
  assert.deepEqual(clampDate(new Date(2026, 9, 1), min, max), min);
  assert.deepEqual(clampDate(new Date(2027, 0, 1), min, max), max);
  assert.deepEqual(clampDate(d, min, max), d);
});

test('Trip Circle: hidden until someone other than me is in it', () => {
  assert.equal(showTripCircle(null), false);
  assert.equal(showTripCircle({ memberCount: 0, isMember: false }), false);
  assert.equal(showTripCircle({ memberCount: 1, isMember: true }), false, 'just me');
  assert.equal(showTripCircle({ memberCount: 1, isMember: false }), true);
  assert.equal(showTripCircle({ memberCount: 3, isMember: true }), true);
  assert.match(EMPTY_CIRCLE_NOTE, /group chat when others join your dates/);
});

test('push_registration: every ask says what came of it (registered, not_now, denied, blocked), asked true only for the phone prompt', async () => {
  notifications.state.permission = 'undetermined';
  await askPushAfterValue('plan', 1);
  await tap(lastAlert(), 'Not now');
  assert.deepEqual(outcomes(), [['not_now', false]]);
  calls = [];
  await askPushAfterValue('plan', 1 + PRE_PROMPT_EVERY_MS + 1);
  await tap(lastAlert(), 'Turn on');
  assert.deepEqual(outcomes(), [['registered', true]]);

  calls = []; notifications.reset(); store.clear();
  notifications.state.permission = 'undetermined'; notifications.state.afterAsking = 'denied'; notifications.state.canAskAgain = true;
  // The stub turns canAskAgain off after a no (Android's second no): that is "blocked", the first is "denied".
  assert.equal(await fixNotifications(), 'blocked');
  assert.deepEqual(outcomes(), [['blocked', true]]);
});
