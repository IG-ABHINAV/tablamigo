// The location prompt after onboarding (src/lib/location-permission.ts). Onboarding asked, the person said no, and the map
// asked again on mount, which on Android spends the last prompt. The map's automatic call must only check after a no, and
// a final no must be reported as blocked so the map can offer Settings.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePermission, mayAutoAsk } from '../src/lib/location-permission.ts';

const fake = answer => { const calls = []; return { calls, request: async () => { calls.push('request'); return answer; }, check: async () => { calls.push('check'); return answer; } }; };

test('the map opening right after a no only checks and never shows the prompt', async () => {
  const p = fake({ status: 'denied', canAskAgain: true });
  const r = await resolvePermission(p, mayAutoAsk({ denied: true }));
  assert.deepEqual(p.calls, ['check']);
  assert.deepEqual(r, { granted: false, blocked: false });
});

test('a fresh session with no answer yet may ask', async () => {
  assert.equal(mayAutoAsk({ denied: false }), true);
  const p = fake({ status: 'granted', canAskAgain: true });
  assert.deepEqual(await resolvePermission(p, true), { granted: true, blocked: false });
  assert.deepEqual(p.calls, ['request']);
});

test('a final no is blocked, so the locate button can offer Settings', async () => {
  assert.deepEqual(await resolvePermission(fake({ status: 'denied', canAskAgain: false }), true), { granted: false, blocked: true });
});

test('granted is never blocked, and an older Expo without canAskAgain is not treated as final', async () => {
  assert.deepEqual(await resolvePermission(fake({ status: 'granted', canAskAgain: false }), false), { granted: true, blocked: false });
  assert.deepEqual(await resolvePermission(fake({ status: 'denied' }), true), { granted: false, blocked: false });
});
