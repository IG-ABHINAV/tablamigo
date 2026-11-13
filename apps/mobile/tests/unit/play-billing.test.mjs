// Google Play purchases (lib/play-billing.ts) with Play Billing stubbed (tests/unit/stubs/expo-iap.mjs). The purchase listener used
// to live in the paywall only, so a UPI payment that settled after the paywall closed was never verified or acknowledged and Google
// refunded it after 3 days. Pinned here: the listener runs from app start without the paywall, a pending purchase waits and is
// verified when Play delivers it as paid, purchases completed while the app was closed are verified at the next start, and a
// failed verify leaves the purchase unfinished for the next try.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as iap from 'expo-iap';
import { Platform } from 'react-native';
import { startPlayPurchases, handlePurchase, onPurchaseEvent, PASS, SKU } from '../../src/lib/play-billing.ts';
import { useSession } from '../../src/lib/session.ts';

const API = process.env.EXPO_PUBLIC_API_URL;
let calls = [];
let verifyStatus = 200;
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = url.slice(API.length);
  calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
  if (path === '/billing/google/verify') return verifyStatus === 200 ? json(200, { active: true }) : json(verifyStatus, { error: 'verify_failed' });
  return json(404, { error: 'not_found' });
};
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };
const verifies = () => calls.filter(c => c.path === '/billing/google/verify').map(c => c.body);
const purchase = (o = {}) => ({ productId: SKU, purchaseToken: 'tok-sub-1', purchaseState: 'purchased', isAcknowledgedAndroid: false, ...o });

let stop = () => {};
let events = [];
let off = () => {};
beforeEach(async () => {
  calls = []; verifyStatus = 200; events = [];
  iap.reset();
  Platform.OS = 'android';
  await useSession.getState().setTokens({ accessToken: 'acc-1', refreshToken: 'ref-1' });
  off = onPurchaseEvent(e => events.push(e));
});
afterEach(() => { stop(); stop = () => {}; off(); });

test('from app start, with no paywall on screen: one connection and a purchase listener', async () => {
  stop = startPlayPurchases();
  await flush();
  assert.equal(iap.state.connects, 1);
  assert.equal(iap.state.updated.length, 1);
  assert.equal(startPlayPurchases(), stop, 'a second start (the paywall) shares the running one');
  assert.equal(iap.state.updated.length, 1);
  stop();
  assert.equal(iap.state.updated.length, 0);
  assert.equal(iap.state.ends, 1);
});

test('a UPI purchase: pending first (nothing verified or finished), then delivered as paid later and verified', async () => {
  stop = startPlayPurchases();
  await flush();
  await iap.deliver(purchase({ purchaseState: 'pending' }));
  await flush();
  assert.deepEqual(verifies(), []);
  assert.deepEqual(iap.state.finished, []);
  assert.deepEqual(events.map(e => e.kind), ['pending']);
  await iap.deliver(purchase());
  await flush();
  assert.deepEqual(verifies(), [{ productId: SKU, purchaseToken: 'tok-sub-1' }]);
  assert.equal(iap.state.finished.length, 1);
  assert.equal(iap.state.finished[0].isConsumable, false);
  assert.deepEqual(events.map(e => e.kind), ['pending', 'verified']);
});

test('at start: purchases Play still holds unacknowledged (paid while the app was closed) are verified; acknowledged ones and pending ones are left', async () => {
  iap.state.available = [
    purchase({ productId: PASS, purchaseToken: 'tok-pass-closed' }),
    purchase({ purchaseToken: 'tok-sub-done', isAcknowledgedAndroid: true }),
    purchase({ purchaseToken: 'tok-sub-pending', purchaseState: 'pending' }),
  ];
  stop = startPlayPurchases();
  await flush();
  assert.deepEqual(verifies(), [{ productId: PASS, purchaseToken: 'tok-pass-closed' }]);
  assert.equal(iap.state.finished.length, 1);
  assert.equal(iap.state.finished[0].isConsumable, true, 'a Trip Pass is consumed, so it can be bought again');
});

test('a verify that fails is not finished, so Play keeps it and the next start tries again', async () => {
  verifyStatus = 400;
  iap.state.available = [purchase({ purchaseToken: 'tok-retry' })];
  stop = startPlayPurchases();
  await flush();
  assert.equal(verifies().length, 1);
  assert.deepEqual(iap.state.finished, []);
  assert.deepEqual(events.map(e => e.kind), ['verify_failed']);
  stop();
  verifyStatus = 200; calls = [];
  stop = startPlayPurchases();
  await flush();
  assert.deepEqual(verifies(), [{ productId: SKU, purchaseToken: 'tok-retry' }]);
  assert.equal(iap.state.finished.length, 1);
});

test('the same purchase delivered twice at once is verified once', async () => {
  const p = purchase({ purchaseToken: 'tok-twice' });
  assert.deepEqual(await Promise.all([handlePurchase(p), handlePurchase(p)]).then(r => r.sort()), ['skipped', 'verified']);
  assert.equal(verifies().length, 1);
});

test('no Play connection (a phone without Play services): nothing breaks, nothing verified', async () => {
  iap.state.connectError = new Error('billing unavailable');
  iap.state.available = [purchase()];
  stop = startPlayPurchases();
  await flush();
  assert.equal(verifies().length, 0);
});

test('web and iOS never touch Google Play', async () => {
  for (const os of ['web', 'ios']) {
    Platform.OS = os;
    const s = startPlayPurchases();
    await flush();
    s();
  }
  assert.equal(iap.state.connects, 0);
  assert.equal(iap.state.updated.length, 0);
});

test('the paywall no longer owns the listener or the connection; the tabs start it once signed in', () => {
  const paywall = fs.readFileSync(new URL('../../src/screens/Paywall.tsx', import.meta.url), 'utf8');
  for (const gone of ['purchaseUpdatedListener', 'purchaseErrorListener', 'endConnection', 'initConnection', 'finishTransaction']) {
    assert.ok(!paywall.includes(gone), `Paywall.tsx still uses ${gone}`);
  }
  const tabs = fs.readFileSync(new URL('../../src/app/(tabs)/_layout.tsx', import.meta.url), 'utf8');
  assert.match(tabs, /startPlayPurchases\(\)/);
});
