// The app's API client (src/lib/api.ts): bearer auth, one transparent token refresh on 401 shared by every request that hit
// it, signing out when the refresh fails, and error copy a person can read (never a raw code). fetch is faked.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError } from '../../src/lib/api.ts';
import { useSession } from '../../src/lib/session.ts';
import { store } from 'expo-secure-store';

const API = process.env.EXPO_PUBLIC_API_URL;
let calls = [];
let routes = {};
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url, init = {}) => {
  const path = url.slice(API.length);
  calls.push({ path, method: init.method, headers: init.headers ?? {}, body: init.body });
  const h = routes[path];
  if (!h) return json(404, { error: 'not_found' });
  return h(init);
};
const signedIn = async (access = 'a1', refresh = 'r1') => useSession.getState().setTokens({ accessToken: access, refreshToken: refresh });

beforeEach(async () => { calls = []; routes = {}; await useSession.getState().setTokens(null); });

test('sends the bearer token and JSON; GET by default, POST when there is a body', async () => {
  await signedIn('tok-1');
  routes['/me'] = () => json(200, { id: 'u1' });
  routes['/activities'] = () => json(200, { id: 'p1' });
  assert.deepEqual(await api('/me'), { id: 'u1' });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].headers.Authorization, 'Bearer tok-1');
  await api('/activities', { body: { title: 'x' } });
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].headers['Content-Type'], 'application/json');
  assert.equal(calls[1].body, JSON.stringify({ title: 'x' }));
});

test('auth: false sends no token (sign-in calls)', async () => {
  await signedIn('tok-1');
  routes['/auth/email/start'] = () => json(200, { ok: true });
  await api('/auth/email/start', { body: { email: 'a@b.c' }, auth: false });
  assert.equal(calls[0].headers.Authorization, undefined);
});

test('an expired access token: refreshes once, saves the new pair on the phone, and retries the call', async () => {
  await signedIn('old-access', 'old-refresh');
  routes['/me'] = init => (init.headers.Authorization === 'Bearer new-access' ? json(200, { id: 'u1' }) : json(401, { error: 'unauthorized' }));
  routes['/auth/refresh'] = init => (JSON.parse(init.body).refreshToken === 'old-refresh' ? json(200, { accessToken: 'new-access', refreshToken: 'new-refresh' }) : json(401, {}));
  assert.deepEqual(await api('/me'), { id: 'u1' });
  assert.deepEqual(calls.map(c => c.path), ['/me', '/auth/refresh', '/me']);
  assert.deepEqual(useSession.getState().tokens, { accessToken: 'new-access', refreshToken: 'new-refresh' });
  assert.deepEqual(JSON.parse(store.get('tablamigo.tokens')), { accessToken: 'new-access', refreshToken: 'new-refresh' });
});

test('five calls that all hit an expired token share ONE refresh (refresh tokens rotate; a second refresh would sign out)', async () => {
  await signedIn('old-access', 'old-refresh');
  let refreshes = 0;
  routes['/auth/refresh'] = async () => { refreshes++; await new Promise(r => setTimeout(r, 20)); return json(200, { accessToken: 'new-access', refreshToken: 'new-refresh' }); };
  for (const p of ['/a', '/b', '/c', '/d', '/e']) routes[p] = init => (init.headers.Authorization === 'Bearer new-access' ? json(200, { p }) : json(401, { error: 'unauthorized' }));
  const out = await Promise.all(['/a', '/b', '/c', '/d', '/e'].map(p => api(p)));
  assert.deepEqual(out.map(o => o.p), ['/a', '/b', '/c', '/d', '/e']);
  assert.equal(refreshes, 1);
});

test('a refused refresh signs out (tokens wiped from the phone) and the call fails with "Please sign in again."', async () => {
  await signedIn('old-access', 'spent-refresh');
  routes['/me'] = () => json(401, { error: 'unauthorized' });
  routes['/auth/refresh'] = () => json(401, { error: 'unauthorized' });
  await assert.rejects(api('/me'), e => e instanceof ApiError && e.status === 401 && e.code === 'unauthorized' && e.message === 'Please sign in again.');
  assert.equal(useSession.getState().tokens, null);
  assert.equal(store.has('tablamigo.tokens'), false);
});

test('signed out: a 401 does not try to refresh', async () => {
  routes['/me'] = () => json(401, { error: 'unauthorized' });
  await assert.rejects(api('/me'), { code: 'unauthorized' });
  assert.deepEqual(calls.map(c => c.path), ['/me']);
});

test('error copy: the server\'s own sentence first, then the app\'s words for the code, never the raw code', async () => {
  await signedIn();
  routes['/x1'] = () => json(400, { error: 'plan_closed', message: 'The host closed this plan to new people.' });
  routes['/x2'] = () => json(400, { error: 'full' });
  routes['/x3'] = () => json(402, { error: 'plus_required', feature: 'more_activities' });
  routes['/x4'] = () => json(400, { error: 'some_new_code_the_app_does_not_know' });
  routes['/x5'] = () => new Response('<html>502 Bad Gateway</html>', { status: 502 });
  const err = async p => { try { await api(p); } catch (e) { return e; } assert.fail('no error'); };
  assert.equal((await err('/x1')).message, 'The host closed this plan to new people.');
  assert.equal((await err('/x2')).message, 'This plan is full.');
  const paywall = await err('/x3');
  assert.equal(paywall.message, 'This needs Tablamigo Plus.');
  assert.deepEqual(paywall.data, { error: 'plus_required', feature: 'more_activities' });
  const unknown = await err('/x4');
  assert.equal(unknown.code, 'some_new_code_the_app_does_not_know');
  assert.equal(unknown.message, 'Something went wrong on our side. Try again in a moment.');
  const gateway = await err('/x5');
  assert.equal(gateway.status, 502);
  assert.equal(gateway.code, 'error');
  assert.doesNotMatch(gateway.message, /error|502|html/i);
});

test('every friendly message is a sentence, not a code', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../../src/lib/api.ts', import.meta.url), 'utf8');
  const block = src.split('const FRIENDLY')[1].split('};')[0];
  const msgs = [...block.matchAll(/:\s*(['"`])((?:\\.|(?!\1).)*)\1,?\s*$/gm)].map(m => m[2]);
  assert.ok(msgs.length > 60);
  for (const m of msgs) {
    assert.match(m, /^[A-Z"“]/, m);
    assert.match(m, /[.!?]$|\.\)$/, m);
    assert.doesNotMatch(m, /\b[a-z]+_[a-z_]+\b/, m);
  }
});

// QA 1 Nov 2026: React Native's fetch never gives up, so a stalled connection left buttons and chat sends waiting forever,
// and an offline fetch surfaced as a raw TypeError.
test('a request the network refuses fails as ApiError no_connection, with readable words', async () => {
  await signedIn();
  routes['/me'] = () => { throw new TypeError('Network request failed'); };
  await assert.rejects(api('/me'), e => e instanceof ApiError && e.code === 'no_connection' && e.status === 0 && /offline/i.test(e.message));
});

test('a request that hangs is given up after its timeout as ApiError timeout, and the fetch is aborted', async () => {
  await signedIn();
  let aborted = false;
  routes['/slow'] = init => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }));
  const t0 = Date.now();
  await assert.rejects(api('/slow', { timeoutMs: 50 }), e => e instanceof ApiError && e.code === 'timeout' && /too long/.test(e.message));
  assert.equal(aborted, true);
  assert.ok(Date.now() - t0 < 2000);
});

test('default timeouts: 45 s for a call, 120 s for an upload; a fast answer clears its timer', async () => {
  const { REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } = await import('../../src/lib/api.ts');
  assert.equal(REQUEST_TIMEOUT_MS, 45_000);
  assert.equal(UPLOAD_TIMEOUT_MS, 120_000);
  await signedIn();
  let signal;
  routes['/me'] = init => { signal = init.signal; return json(200, { id: 'u1' }); };
  assert.deepEqual(await api('/me'), { id: 'u1' });
  assert.equal(signal.aborted, false);
});
