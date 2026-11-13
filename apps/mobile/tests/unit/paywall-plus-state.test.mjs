// The Play paywall for someone who already has Plus (src/lib/paywall-copy.ts paywallPlusState, plusUntilLine), and the
// Profile Plus card's line. A renewing subscription (Google Play or the website) must never be offered a second one.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paywallPlusState, plusUntilLine, PLAY_UNAVAILABLE } from '../../src/lib/paywall-copy.ts';

const NOW = Date.parse('2026-10-27T08:00:00Z');
const inDays = d => new Date(NOW + d * 86_400_000).toISOString();

test('a free account (or no answer yet) gets the normal paywall', () => {
  assert.deepEqual(paywallPlusState(undefined), { kind: 'none' });
  assert.deepEqual(paywallPlusState({ plus: false, renewing: null }), { kind: 'none' });
  // `renewing` without Plus (a stale row) never hides the plans
  assert.deepEqual(paywallPlusState({ plus: false, renewing: 'google' }), { kind: 'none' });
});

test('a renewing Google Play or website subscription gets no second subscription', () => {
  for (const where of ['google', 'razorpay']) {
    const s = paywallPlusState({ plus: true, plusUntil: inDays(20), renewing: where });
    assert.equal(s.kind, 'renewing'); assert.equal(s.where, where); assert.ok(s.line.length > 0);
  }
});

test('Plus from a Trip Pass, a cancelled subscription or granted days can be extended', () => {
  // paywallPlusState reads the real clock, so the end date is 5 days from now (inDays(5) from NOW expired on 1 Nov 2026 08:00 UTC).
  const s = paywallPlusState({ plus: true, plusUntil: new Date(Date.now() + 5 * 86_400_000).toISOString(), renewing: null });
  assert.equal(s.kind, 'extend'); assert.match(s.line, /^Plus until /);
});

test('the Plus line never says "Renews", and a far-future grant reads as complimentary', () => {
  assert.match(plusUntilLine(inDays(30), NOW), /^Plus until /);
  assert.doesNotMatch(plusUntilLine(inDays(30), NOW), /Renew/i);
  assert.equal(plusUntilLine('2099-01-01T00:00:00Z', NOW), 'Complimentary Plus');
  assert.equal(plusUntilLine(inDays(-1), NOW), '');
  assert.equal(plusUntilLine(null, NOW), '');
  assert.equal(plusUntilLine('not a date', NOW), '');
});

test('the Play-unavailable card no longer says the app is not on Google Play yet', () => {
  const all = PLAY_UNAVAILABLE.title + ' ' + PLAY_UNAVAILABLE.body;
  assert.doesNotMatch(all, /launching soon|once the app is live/i);
  assert.match(all, /try again/i);
});
