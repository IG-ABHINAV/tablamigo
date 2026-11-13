// Connect as a request (src/lib/connect.ts, 4 Nov 2026): the profile button for each status, the world list's paging, first names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectStatus, connectButton, appendPage, firstName } from '../../src/lib/connect.ts';

test('the status comes from the API, and an older API answer still reads right', () => {
  for (const s of ['none', 'requested', 'incoming', 'connected']) assert.equal(connectStatus({ connectionStatus: s }), s);
  assert.equal(connectStatus({ isConnected: true }), 'connected');
  assert.equal(connectStatus({ isConnected: false }), 'none');
  assert.equal(connectStatus({ connectionStatus: 'mutual', isConnected: true }), 'connected');
  assert.equal(connectStatus(null), 'none');
});

test('Connect, then Requested, then Connected: never "Connected" before the other person accepts', () => {
  assert.deepEqual(connectButton('none'), { title: 'Connect', icon: 'person-add', primary: true });
  assert.equal(connectButton('requested').title, 'Requested');
  assert.equal(connectButton('requested').primary, false);
  assert.equal(connectButton('connected').title, 'Connected');
});

test('the world list never shows a plan twice across pages', () => {
  const a = [{ id: '1' }, { id: '2' }];
  assert.deepEqual(appendPage(a, [{ id: '2' }, { id: '3' }, { id: '3' }]).map(x => x.id), ['1', '2', '3']);
  assert.deepEqual(appendPage([], []), []);
});

test('first names for long, short and spaced names', () => {
  assert.equal(firstName('Maria Fernanda de los Angeles Gonzalez-Rodriguez'), 'Maria');
  assert.equal(firstName('  Jo  '), 'Jo');
  assert.equal(firstName('李'), '李');
});
