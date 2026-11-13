// The web app's session (src/lib/session.web.ts) when an admin uses "Login as user": the read-only token lives in that tab only,
// the admin's own session in localStorage is never touched, and when the 15-minute look ends the tab is an ordinary signed-out
// tab again (it used to stay in admin-view mode, so a sign-in there afterwards was kept in that tab only). Also the ordinary
// session: tokens in localStorage, other open tabs kept on the newest rotated refresh token, and a storage that throws.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';

const storage = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
globalThis.localStorage = storage();
globalThis.sessionStorage = storage();
let href = 'https://tablamigo.hookstep.in/app/';
const listeners = {};
globalThis.window = {
  get location() { return { href }; },
  history: { replaceState: (_s, _t, u) => { href = new URL(u, href).href; } },
  addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
};
const fireStorage = e => (listeners.storage ?? []).forEach(fn => fn(e));

const ADMIN = { accessToken: 'admin-access', refreshToken: 'admin-refresh' };
localStorage.setItem('tablamigo.tokens', JSON.stringify(ADMIN));
href = 'https://tablamigo.hookstep.in/app/#impersonate_token=imp-access';
const { useSession } = await import('../src/lib/session.web.ts');

test('the admin-view token is used in this tab, out of the address, and the admin session is left alone', async () => {
  await useSession.getState().load();
  const s = useSession.getState();
  assert.equal(s.impersonating, true);
  assert.equal(s.tokens.accessToken, 'imp-access');
  assert.equal(href, 'https://tablamigo.hookstep.in/app/');
  assert.deepEqual(JSON.parse(localStorage.getItem('tablamigo.tokens')), ADMIN);
});

test('while looking at someone else\'s account, the browser\'s own session changing in another tab is ignored', () => {
  fireStorage({ key: 'tablamigo.tokens', newValue: JSON.stringify({ accessToken: 'other-tab', refreshToken: 'r' }) });
  assert.equal(useSession.getState().tokens.accessToken, 'imp-access');
  assert.equal(useSession.getState().impersonating, true);
});

test('when the look ends the tab is signed out and ordinary again; the admin session is still there', async () => {
  await useSession.getState().setTokens(null);   // what lib/api.ts does when the refresh (there is no refresh token) fails
  const s = useSession.getState();
  assert.equal(s.tokens, null);
  assert.equal(s.impersonating, false);
  assert.equal(sessionStorage.getItem('tablamigo.impersonation'), null);
  assert.deepEqual(JSON.parse(localStorage.getItem('tablamigo.tokens')), ADMIN);
});

test('a sign-in in that tab afterwards is a normal session, kept like any other', async () => {
  const mine = { accessToken: 'mine-access', refreshToken: 'mine-refresh' };
  await useSession.getState().setTokens(mine);
  assert.deepEqual(JSON.parse(localStorage.getItem('tablamigo.tokens')), mine);
  assert.equal(sessionStorage.getItem('tablamigo.impersonation'), null);
  await useSession.getState().load();
  assert.equal(useSession.getState().impersonating, false);
});

test('a normal load reads localStorage; a broken value signs out instead of crashing', async () => {
  localStorage.setItem('tablamigo.tokens', JSON.stringify({ accessToken: 'a', refreshToken: 'r' }));
  await useSession.getState().load();
  assert.deepEqual(useSession.getState().tokens, { accessToken: 'a', refreshToken: 'r' });
  localStorage.setItem('tablamigo.tokens', '{broken');
  await useSession.getState().load();
  assert.equal(useSession.getState().tokens, null);
  assert.equal(useSession.getState().ready, true);
});

test('another tab refreshed the tokens: this tab switches to the new pair; signing out in one tab signs out all', () => {
  fireStorage({ key: 'tablamigo.tokens', newValue: JSON.stringify({ accessToken: 'a2', refreshToken: 'r2' }) });
  assert.deepEqual(useSession.getState().tokens, { accessToken: 'a2', refreshToken: 'r2' });
  fireStorage({ key: 'other', newValue: 'x' });
  assert.deepEqual(useSession.getState().tokens, { accessToken: 'a2', refreshToken: 'r2' });
  fireStorage({ key: 'tablamigo.tokens', newValue: null });
  assert.equal(useSession.getState().tokens, null);
});

test('setTokens(null) clears storage; a storage that throws (private mode) still updates the session', async () => {
  await useSession.getState().setTokens({ accessToken: 'x', refreshToken: 'y' });
  await useSession.getState().setTokens(null);
  assert.equal(localStorage.getItem('tablamigo.tokens'), null);
  const real = localStorage.setItem;
  localStorage.setItem = () => { throw new Error('QuotaExceededError'); };
  try {
    await useSession.getState().setTokens({ accessToken: 'p', refreshToken: 'q' });
    assert.deepEqual(useSession.getState().tokens, { accessToken: 'p', refreshToken: 'q' });
  } finally { localStorage.setItem = real; }
});
