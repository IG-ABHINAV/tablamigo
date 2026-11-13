// 12 Nov 2026: notifications are offered right after onboarding, with our own explanation before the phone's prompt. Since
// 1.4.2 the app asked only after a trip or a joined plan, and 6 of 8 new Android app accounts (4-12 Nov) never got there,
// so they had no push token. The post-join ask stays as the fallback for anyone who says "Not now".
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as notifications from 'expo-notifications';
import { store } from 'expo-secure-store';
import { Alert, Platform } from 'react-native';
import { offerPushAfterOnboarding, acceptPushOffer, declinePushOffer, askPushAfterValue } from '../../src/lib/push.ts';
import { onboardingAskDecision, ONBOARDING_PRE_PROMPT } from '../../src/lib/push-policy.ts';
import { useSession } from '../../src/lib/session.ts';

const API = process.env.EXPO_PUBLIC_API_URL;
let calls = [];
globalThis.fetch = async (url, init = {}) => { calls.push({ path: url.slice(API.length), body: init.body ? JSON.parse(init.body) : undefined }); return new Response('{"ok":true}', { status: 200 }); };
const flush = () => new Promise(r => setTimeout(r, 0));
const apiPaths = () => calls.filter(c => c.path !== '/analytics/events').map(c => c.path);
const regs = () => calls.filter(c => c.path === '/analytics/events' && c.body.event === 'push_registration').map(c => c.body.properties);

beforeEach(async () => {
  calls = []; Alert.calls.length = 0; notifications.reset(); store.clear(); Platform.OS = 'android';
  await useSession.getState().setTokens({ accessToken: 'a', refreshToken: 'r' });
});

test('policy: offer once while the phone can still ask; register when already allowed; never after a final no', () => {
  assert.equal(onboardingAskDecision({ status: 'undetermined', canAskAgain: true }, false), 'offer');
  assert.equal(onboardingAskDecision({ status: 'undetermined', canAskAgain: true }, true), 'skip');
  assert.equal(onboardingAskDecision({ status: 'denied', canAskAgain: true }, false), 'offer');
  assert.equal(onboardingAskDecision({ status: 'denied', canAskAgain: false }, false), 'skip');
  assert.equal(onboardingAskDecision({ status: 'granted', canAskAgain: true }, false), 'register');
  assert.equal(onboardingAskDecision({ status: 'granted', canAskAgain: true }, true), 'register');
});

test('the explanation says what the notifications are for, with Turn on / Not now', () => {
  assert.equal(ONBOARDING_PRE_PROMPT.body, 'Get a ping when someone plans a trip to your city or replies to you.');
  assert.deepEqual([ONBOARDING_PRE_PROMPT.yes, ONBOARDING_PRE_PROMPT.no], ['Turn on', 'Not now']);
});

test('a fresh install is offered it once, and the offer itself never opens the phone prompt', async () => {
  notifications.state.permission = 'undetermined';
  assert.equal(await offerPushAfterOnboarding(), true);
  assert.equal(notifications.state.asked, 0);
  assert.equal(await offerPushAfterOnboarding(), false);   // once per install
  assert.deepEqual(apiPaths(), []);
});

test('Turn on: the phone prompt, then the token is saved and reported as asked at onboarding', async () => {
  notifications.state.permission = 'undetermined'; notifications.state.afterAsking = 'granted';
  assert.equal(await offerPushAfterOnboarding(), true);
  assert.equal(await acceptPushOffer(), true);
  await flush();
  assert.equal(notifications.state.asked, 1);
  assert.deepEqual(apiPaths(), ['/me/push-token']);
  const r = regs().at(-1);
  assert.deepEqual([r.outcome, r.asked, r.at], ['registered', true, 'onboarding']);
});

test('Turn on, then no to the phone prompt: reported, nothing saved', async () => {
  notifications.state.permission = 'undetermined'; notifications.state.afterAsking = 'denied';
  assert.equal(await offerPushAfterOnboarding(), true);
  assert.equal(await acceptPushOffer(), false);
  await flush();
  assert.deepEqual(apiPaths(), []);
  assert.deepEqual([regs().at(-1).outcome, regs().at(-1).at], ['blocked', 'onboarding']);
});

test('Not now: reported, and the ask after a first trip still comes as the fallback', async () => {
  notifications.state.permission = 'undetermined';
  assert.equal(await offerPushAfterOnboarding(), true);
  declinePushOffer();
  await flush();
  assert.deepEqual([regs().at(-1).outcome, regs().at(-1).at], ['not_now', 'onboarding']);
  assert.equal(await askPushAfterValue('trip'), true);   // its own once-a-week clock was not touched by the onboarding offer
  assert.equal(Alert.calls.length, 1);
});

test('already allowed (a reinstall that kept the permission): no sheet, the token is registered', async () => {
  notifications.state.permission = 'granted';
  assert.equal(await offerPushAfterOnboarding(), false);
  await flush();
  assert.deepEqual(apiPaths(), ['/me/push-token']);
});

test('refused for good: no sheet', async () => {
  notifications.state.permission = 'denied'; notifications.state.canAskAgain = false;
  assert.equal(await offerPushAfterOnboarding(), false);
});

test('a broken permission read never gets in the way of the screen', async () => {
  notifications.state.permissionError = new Error('boom');
  assert.equal(await offerPushAfterOnboarding(), false);
});

test('the Start screen after onboarding mounts the offer; the web app has the same three functions', () => {
  const start = fs.readFileSync(new URL('../../src/app/start.tsx', import.meta.url), 'utf8');
  assert.match(start, /<PushOffer \/>/);
  const web = fs.readFileSync(new URL('../../src/lib/push.web.ts', import.meta.url), 'utf8');
  for (const fn of ['offerPushAfterOnboarding', 'acceptPushOffer', 'declinePushOffer']) assert.match(web, new RegExp(`export (async )?function ${fn}\\(`));
  assert.match(web, /Notification\.permission !== 'default'/);
});
