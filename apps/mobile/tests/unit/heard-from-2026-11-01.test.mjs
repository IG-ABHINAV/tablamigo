// "How did you hear about us?" (onboarding, 1 Nov 2026): the answers the app offers are exactly the ones the API accepts, a
// tap posts that answer, and a failed save never holds up onboarding. The screen itself is walked in e2e-web/drive.mjs and
// maestro/flows/02-onboarding.yaml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { HEARD_FROM_OPTIONS, saveHeardFrom } from '../../src/lib/heard-from.ts';

test('the app offers exactly the API answers, in the same order, each with a label', () => {
  const src = fs.readFileSync(new URL('../../../api/src/lib/heard-from.ts', import.meta.url), 'utf8');
  const api = [...src.match(/HEARD_FROM = \[([^\]]+)\]/)[1].matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
  assert.deepEqual(HEARD_FROM_OPTIONS.map(o => o[0]), api);
  assert.equal(api.length, 8);
  for (const [, label] of HEARD_FROM_OPTIONS) assert.ok(label.length > 1);
  assert.ok(HEARD_FROM_OPTIONS.some(([k]) => k === 'friend'), 'invite links count as a friend');
});

test('a tap posts the answer to /me/heard-from; Skip posts skipped', async () => {
  const calls = [];
  const api = async (path, init) => { calls.push([path, init.body]); return { ok: true }; };
  await saveHeardFrom(api, 'instagram');
  await saveHeardFrom(api, 'skipped');
  assert.deepEqual(calls, [['/me/heard-from', { source: 'instagram' }], ['/me/heard-from', { source: 'skipped' }]]);
});

test('a save that fails resolves quietly, so onboarding carries on', async () => {
  await assert.doesNotReject(saveHeardFrom(async () => { throw new Error('offline'); }, 'youtube'));
});
