// One-tap Join on a plan card (src/lib/quick-join.ts): when the card offers it, and what a refusal says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canQuickJoin, joinErrorText } from '../../src/lib/quick-join.ts';

const NOW = Date.UTC(2026, 10, 2, 6, 0, 0);
const me = { id: 'me', gender: 'man' };
const plan = (over = {}) => ({ id: 'p', joined: false, isPaid: false, womenOnly: false, going: 1, maxPeople: 6, startsAt: new Date(NOW + 3 * 3600e3).toISOString(), host: { id: 'h' }, ...over });

test('offered on an open, free plan someone else hosts', () => {
  assert.equal(canQuickJoin(plan(), me, NOW), true);
  assert.equal(canQuickJoin(plan({ maxPeople: null }), me, NOW), true);   // no cap
  assert.equal(canQuickJoin(plan({ startsAt: new Date(NOW - 3600e3).toISOString() }), me, NOW), true);   // started an hour ago
});

test('not offered: signed out, already in, closed, own plan, paid, full, over', () => {
  assert.equal(canQuickJoin(plan(), null, NOW), false);
  assert.equal(canQuickJoin(plan(), {}, NOW), false);
  assert.equal(canQuickJoin(plan({ joined: true }), me, NOW), false);
  assert.equal(canQuickJoin(plan({ closed: true }), me, NOW), false);   // the host closed it to new people
  assert.equal(canQuickJoin(plan({ host: { id: 'me' } }), me, NOW), false);
  assert.equal(canQuickJoin(plan({ isPaid: true }), me, NOW), false);
  assert.equal(canQuickJoin(plan({ going: 6, maxPeople: 6 }), me, NOW), false);   // the waitlist is a choice on the plan page
  assert.equal(canQuickJoin(plan({ startsAt: new Date(NOW - 3 * 3600e3).toISOString() }), me, NOW), false);
});

test('women-only plans offer it to women only', () => {
  assert.equal(canQuickJoin(plan({ womenOnly: true }), me, NOW), false);
  assert.equal(canQuickJoin(plan({ womenOnly: true }), { id: 'w', gender: 'woman' }, NOW), true);
});

test('a refusal says what the plan page says', () => {
  assert.equal(joinErrorText('full', 'x'), 'This plan is full.');
  assert.equal(joinErrorText('plan_closed'), 'The host closed this plan to new people.');
  assert.equal(joinErrorText('women_only'), 'This plan is for women only.');
  assert.equal(joinErrorText('something_new', 'Server words'), 'Server words');
  assert.equal(joinErrorText(null, null), 'No connection.');
});
