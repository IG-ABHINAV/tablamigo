// The phone-only libs the shipped Android app depends on, with the native modules stubbed (tests/unit/stubs):
//  - lib/selfie.ts: the verification selfie is a live front-camera shot, never a gallery pick (a gallery photo could be anyone's);
//  - lib/upload.ts: profile and chat photos come from the gallery and go straight to storage with the right Content-Type;
//  - lib/push.ts: the FCM token is registered after permission and again when FCM rotates it, each start reports its outcome
//    (push_registration), a push for the chat on screen shows no banner, a tap opens its chat;
//  - lib/safety.ts: the report sheet only offers reasons and targets the API accepts.
// The camera, the gallery and FCM themselves are on the phone (TESTING.md section 7, apps/mobile/maestro).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as picker from 'expo-image-picker';
import * as files from 'expo-file-system/legacy';
import * as notifications from 'expo-notifications';
import { pushed } from 'expo-router';
import { Platform } from 'react-native';
import { shootAndUpload } from '../../src/lib/selfie.ts';
import { pickAndUpload } from '../../src/lib/upload.ts';
import { registerPush, setOpenChat } from '../../src/lib/push.ts';
import { REASONS, REPORT_WHAT } from '../../src/lib/safety.ts';
import { ApiError } from '../../src/lib/api.ts';
import { useSession } from '../../src/lib/session.ts';

const API = process.env.EXPO_PUBLIC_API_URL;
let calls = [];
let routes = {};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = url.slice(API.length);
  calls.push({ path, method: init.method, headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  return routes[path] ? routes[path](init) : json(404, { error: 'not_found' });
};
const flush = () => new Promise(r => setTimeout(r, 0));

beforeEach(async () => {
  calls = []; routes = {}; pushed.length = 0;
  picker.reset(); files.reset(); notifications.reset(); setOpenChat(null);
  Platform.OS = 'android';
  await useSession.getState().setTokens({ accessToken: 'acc-1', refreshToken: 'ref-1' });
});

// ---------------------------------------------------------------- selfie (verification)
test('selfie: camera permission refused means camera_needed, and the gallery is never offered instead', async () => {
  picker.state.cameraPermission = { granted: false, status: 'denied' };
  await assert.rejects(shootAndUpload('Turn your head left'), e => e instanceof ApiError && e.code === 'camera_needed' && /camera/i.test(e.message));
  assert.deepEqual(picker.calls.map(c => c[0]), ['requestCameraPermissionsAsync']);
  assert.equal(calls.length, 0);
});

test('selfie: a permission request that throws is treated as refused, still no gallery', async () => {
  picker.state.cameraPermission = new Error('activity gone');
  await assert.rejects(shootAndUpload(), e => e.code === 'camera_needed');
  assert.ok(!picker.calls.some(c => c[0] === 'launchImageLibraryAsync'));
});

test('selfie: a front-camera shot goes to /verify/upload and is PUT to the presigned URL; the key comes back', async () => {
  routes['/verify/upload'] = () => json(200, { uploadUrl: 'https://r2.example/put?sig=1', key: 'avatar/u1/selfie.jpg' });
  assert.equal(await shootAndUpload('Smile'), 'avatar/u1/selfie.jpg');
  const cam = picker.calls.find(c => c[0] === 'launchCameraAsync');
  assert.equal(cam[1].cameraType, picker.CameraType.front);
  assert.deepEqual(cam[1].mediaTypes, ['images']);
  assert.ok(!picker.calls.some(c => c[0] === 'launchImageLibraryAsync'), 'never the gallery');
  assert.deepEqual(calls.map(c => [c.method, c.path, c.body]), [['POST', '/verify/upload', { contentType: 'image/jpeg' }]]);
  assert.equal(calls[0].headers.Authorization, 'Bearer acc-1');
  assert.equal(files.uploads.length, 1);
  assert.equal(files.uploads[0].url, 'https://r2.example/put?sig=1');
  assert.equal(files.uploads[0].opts.httpMethod, 'PUT');
  assert.equal(files.uploads[0].opts.headers['Content-Type'], 'image/jpeg');
});

test('selfie: a PNG keeps its type; a cancelled camera uploads nothing; a refused PUT is an error', async () => {
  routes['/verify/upload'] = init => json(200, { uploadUrl: 'https://r2.example/put', key: `k-${JSON.parse(init.body).contentType}` });
  picker.state.camera = { canceled: false, assets: [{ uri: 'file:///x.png', mimeType: 'image/png' }] };
  assert.equal(await shootAndUpload(), 'k-image/png');
  assert.equal(files.uploads[0].opts.headers['Content-Type'], 'image/png');

  calls = []; files.reset();
  picker.state.camera = { canceled: true, assets: null };
  assert.equal(await shootAndUpload(), null);
  assert.equal(calls.length, 0);
  assert.equal(files.uploads.length, 0);

  picker.state.camera = { canceled: false, assets: [{ uri: 'file:///y.jpg', mimeType: 'image/jpeg' }] };
  files.state.status = 403;
  await assert.rejects(shootAndUpload(), /upload_failed_403/);
});

// ---------------------------------------------------------------- photo uploads (profile, chat)
test('photos: a profile photo is picked from the gallery square-cropped, a chat photo uncropped; both go to /uploads/image', async () => {
  routes['/uploads/image'] = init => json(200, { uploadUrl: 'https://r2.example/put2', publicUrl: `https://media.example/${JSON.parse(init.body).kind}.jpg` });
  assert.equal(await pickAndUpload('avatar'), 'https://media.example/avatar.jpg');
  assert.equal(await pickAndUpload('chat'), 'https://media.example/chat.jpg');
  const picks = picker.calls.filter(c => c[0] === 'launchImageLibraryAsync').map(c => c[1]);
  assert.equal(picks[0].allowsEditing, true);
  assert.deepEqual(picks[0].aspect, [1, 1]);
  assert.equal(picks[1].allowsEditing, false);
  assert.deepEqual(calls.map(c => c.body), [{ kind: 'avatar', contentType: 'image/jpeg' }, { kind: 'chat', contentType: 'image/jpeg' }]);
  assert.ok(files.uploads.every(u => u.opts.httpMethod === 'PUT' && u.opts.headers['Content-Type'] === 'image/jpeg'));
});

test('photos: cancelling the picker uploads nothing; a refused PUT is an error, not a broken photo URL', async () => {
  picker.state.library = { canceled: true, assets: [] };
  assert.equal(await pickAndUpload('chat'), null);
  assert.equal(calls.length, 0);
  picker.state.library = { canceled: false, assets: [{ uri: 'file:///p.jpg', mimeType: 'image/jpeg' }] };
  routes['/uploads/image'] = () => json(200, { uploadUrl: 'https://r2.example/put3', publicUrl: 'https://media.example/p.jpg' });
  files.state.status = 400;
  await assert.rejects(pickAndUpload('avatar'), /upload_failed_400/);
});

// ---------------------------------------------------------------- push
const pushFor = chatId => ({ request: { content: { data: chatId ? { chatId } : {} } } });

test('push: a message for the chat on screen shows no banner or sound; any other push does', async () => {
  const h = notifications.state.handler;
  assert.ok(h, 'push.ts installs a notification handler when it loads');
  assert.equal((await h.handleNotification(pushFor('c1'))).shouldShowBanner, true);
  setOpenChat('c1');
  assert.deepEqual(await h.handleNotification(pushFor('c1')), { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
  assert.equal((await h.handleNotification(pushFor('c2'))).shouldShowBanner, true);
  assert.equal((await h.handleNotification(pushFor(null))).shouldPlaySound, true);
  setOpenChat(null);
  assert.equal((await h.handleNotification(pushFor('c1'))).shouldShowBanner, true);
});

const tokenPosts = () => calls.filter(c => c.path === '/me/push-token').map(c => [c.method, c.path, c.body]);
/** The push_registration events sent so far (fire-and-forget, so flush first). */
const registrations = async () => { await flush(); return calls.filter(c => c.path === '/analytics/events' && c.body.event === 'push_registration').map(c => c.body.properties); };

test('push: with permission, the Android channel is made, the FCM token is registered once and "registered" is reported', async () => {
  routes['/me/push-token'] = () => json(200, { ok: true });
  Platform.Version = 34;
  const sub = await registerPush();
  assert.deepEqual(notifications.state.channels.map(c => [c[0], c[1].importance]), [['default', notifications.AndroidImportance.HIGH]]);
  assert.equal(notifications.state.asked, 0, 'already granted: not asked again');
  assert.deepEqual(tokenPosts(), [['POST', '/me/push-token', { token: 'fcm-device-token-1', platform: 'android' }]]);
  try {
    assert.deepEqual(await registrations(), [{ outcome: 'registered', platform: 'android', os: '34', asked: false }]);
  } finally { sub.remove(); delete Platform.Version; }
});

test('push: a permission call that throws is still reported (error, message capped at 160) and leaves a removable subscription', async () => {
  notifications.state.permissionError = new Error('x'.repeat(300));
  const sub = await registerPush();
  const [r] = await registrations();
  assert.equal(r.outcome, 'error');
  assert.equal(r.error.length, 160);
  assert.deepEqual(tokenPosts(), []);
  sub.remove();
  assert.equal(notifications.state.listeners.length, 0);
});

test('push: a token the API refuses is save_failed, not registered, and no rotation listener is left behind', async () => {
  routes['/me/push-token'] = () => json(500, { error: 'internal' });
  const sub = await registerPush();
  assert.equal(tokenPosts().length, 1);
  assert.deepEqual((await registrations()).map(r => r.outcome), ['save_failed']);
  assert.equal(notifications.state.tokenListeners.length, 0);
  sub.remove();
});

test('push: a token FCM rotates while the app runs is saved; after remove() (sign-out) a rotation is ignored', async () => {
  routes['/me/push-token'] = () => json(200, { ok: true });
  const sub = await registerPush();
  assert.equal(notifications.state.tokenListeners.length, 1);
  for (const fn of notifications.state.tokenListeners) fn({ type: 'android', data: 'fcm-device-token-2' });
  await flush();
  assert.deepEqual(tokenPosts().map(c => c[2].token), ['fcm-device-token-1', 'fcm-device-token-2']);
  sub.remove();
  assert.equal(notifications.state.tokenListeners.length, 0, 'remove() drops the rotation listener too');
  assert.equal(notifications.state.listeners.length, 0);
});

test('push: never asks at start (QA 1 Nov 2026); not yet allowed registers nothing; an iPhone says ios', async () => {
  notifications.state.permission = 'undetermined';
  (await registerPush()).remove();
  assert.equal(notifications.state.asked, 0, 'no prompt on first open');
  assert.deepEqual(tokenPosts(), []);
  assert.deepEqual((await registrations()).map(r => [r.outcome, r.asked]), [['off', false]]);
  calls = [];

  notifications.reset();
  routes['/me/push-token'] = () => json(200, { ok: true });
  Platform.OS = 'ios';
  (await registerPush()).remove();
  assert.equal(notifications.state.channels.length, 0, 'channels are Android only');
  assert.equal(tokenPosts()[0][2].platform, 'ios');
  assert.deepEqual((await registrations()).map(r => [r.outcome, r.platform]), [['registered', 'ios']]);
});

test('push: a build without Firebase config (no device token) carries on quietly', async () => {
  notifications.state.tokenError = new Error('Default FirebaseApp is not initialized');
  const sub = await registerPush();
  assert.equal(typeof sub.remove, 'function');
  assert.deepEqual(tokenPosts(), []);
  assert.deepEqual((await registrations()).map(r => [r.outcome, r.error]), [['no_token', 'Default FirebaseApp is not initialized']]);
  sub.remove();
});

test('push: tapping a notification opens its chat, also when the tap started the app; other taps go nowhere', async () => {
  routes['/me/push-token'] = () => json(200, { ok: true });
  notifications.state.lastResponse = { notification: pushFor('chat-from-cold-start') };
  const sub = await registerPush();
  await flush();
  assert.deepEqual(pushed, ['/chat/chat-from-cold-start']);
  for (const fn of notifications.state.listeners) { fn({ notification: pushFor('chat-42') }); fn({ notification: pushFor(null) }); fn(null); }
  assert.deepEqual(pushed, ['/chat/chat-from-cold-start', '/chat/chat-42']);
  sub.remove();
  assert.equal(notifications.state.listeners.length, 0, 'the subscription it returns removes the tap listener');
});

// ---------------------------------------------------------------- report sheet = API
const apiFile = p => fs.readFileSync(new URL(`../../../api/src/${p}`, import.meta.url), 'utf8');

test('report sheet: the six reasons it offers are ones the API accepts', () => {
  const enumText = apiFile('routes/safety.ts').match(/reason: z\.enum\(\[([^\]]+)\]\)/)[1];
  const accepted = [...enumText.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.equal(REASONS.length, 6);
  assert.deepEqual(REASONS.map(r => r.id).filter(id => !accepted.includes(id)), []);
  assert.ok(REASONS.every(r => r.label && r.emoji));
});

test('report sheet: every kind of thing it can report is a target type the API accepts, and the other way round', () => {
  const list = apiFile('lib/report-targets.ts').match(/REPORT_TARGET_TYPES = \[([^\]]+)\]/)[1];
  const api = [...list.matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(Object.keys(REPORT_WHAT).sort(), api);
});
