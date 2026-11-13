// The app's one live socket (src/lib/socket.ts). Regressions it guards: replacing the socket on a token refresh left every
// open screen listening to a dead socket (no live messages); an expired token on connect must refresh and reconnect a few
// times only; signing out must drop the socket so the next account never inherits it.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { created } from 'socket.io-client';
import { getSocket, closeSocket } from '../../src/lib/socket.ts';
import { useSession } from '../../src/lib/session.ts';

const API = process.env.EXPO_PUBLIC_API_URL;
let meCalls = 0;
globalThis.fetch = async url => { if (url === `${API}/me`) meCalls++; return new Response('{}', { status: 200 }); };
const tick = ms => new Promise(r => setTimeout(r, ms));

beforeEach(async () => { closeSocket(); created.length = 0; meCalls = 0; await useSession.getState().setTokens(null); });

test('no socket while signed out', () => {
  assert.equal(getSocket(), null);
  assert.equal(created.length, 0);
});

test('one socket for the session, on /rt over websocket, kept across a token refresh, sending the newest token', async () => {
  await useSession.getState().setTokens({ accessToken: 'a1', refreshToken: 'r1' });
  const s = getSocket();
  assert.equal(s.url, API);
  assert.equal(s.opts.path, '/rt');
  assert.deepEqual(s.opts.transports, ['websocket']);
  assert.equal(s.currentToken(), 'a1');
  await useSession.getState().setTokens({ accessToken: 'a2', refreshToken: 'r2' });
  assert.equal(getSocket(), s);
  assert.equal(created.length, 1);
  assert.equal(s.currentToken(), 'a2');
});

test('refused as unauthorized: refreshes through the API and reconnects, at most 3 times; a good connect resets the count', async () => {
  await useSession.getState().setTokens({ accessToken: 'a1', refreshToken: 'r1' });
  const s = getSocket();
  s.fire('connect_error', new Error('unauthorized'));
  await tick(1100);
  assert.equal(meCalls, 1);
  assert.equal(s.connects, 1);
  s.fire('connect_error', new Error('unauthorized'));
  await tick(2100);
  s.fire('connect_error', new Error('unauthorized'));
  await tick(3100);
  s.fire('connect_error', new Error('unauthorized'));   // the 4th: given up
  await tick(50);
  assert.equal(meCalls, 3);
  assert.equal(s.connects, 3);
  s.fire('connect');
  s.fire('connect_error', new Error('unauthorized'));
  await tick(1100);
  assert.equal(meCalls, 4);
});

test('other connect errors (network) are left to socket.io\'s own retry', async () => {
  await useSession.getState().setTokens({ accessToken: 'a1', refreshToken: 'r1' });
  const s = getSocket();
  s.fire('connect_error', new Error('websocket error'));
  await tick(1100);
  assert.equal(meCalls, 0);
  assert.equal(s.connects, 0);
});

test('signing out disconnects it; the next account gets a fresh socket', async () => {
  await useSession.getState().setTokens({ accessToken: 'a1', refreshToken: 'r1' });
  const first = getSocket();
  await useSession.getState().setTokens(null);
  assert.equal(first.disconnected, true);
  assert.equal(getSocket(), null);
  await useSession.getState().setTokens({ accessToken: 'b1', refreshToken: 'q1' });
  const second = getSocket();
  assert.notEqual(second, first);
  assert.equal(second.currentToken(), 'b1');
});

test('a sign-out while a reconnect is pending does not reconnect the old socket', async () => {
  await useSession.getState().setTokens({ accessToken: 'a1', refreshToken: 'r1' });
  const s = getSocket();
  s.fire('connect_error', new Error('unauthorized'));
  await useSession.getState().setTokens(null);
  await tick(1100);
  assert.equal(s.connects, 0);
});
