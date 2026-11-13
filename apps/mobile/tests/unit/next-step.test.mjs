// The "what now" screen after onboarding (src/app/start.tsx, src/lib/next-step.ts): which plans it offers and the greeting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startPlans, firstName } from '../../src/lib/next-step.ts';

const NOW = Date.UTC(2026, 10, 1, 6, 0, 0);
const at = h => new Date(NOW + h * 3600_000).toISOString();
const plan = (id, over = {}) => ({ id, startsAt: at(5), going: 1, maxPeople: 6, joined: false, distanceM: 1000, ...over });

test('offers the 2 nearest open plans, then the soonest among equals', () => {
  const r = startPlans([plan('far', { distanceM: 9000 }), plan('near'), plan('mid', { distanceM: 3000 }), plan('near-later', { startsAt: at(30) })], null, NOW);
  assert.deepEqual(r.plans.map(p => p.id), ['near', 'near-later']);
  assert.equal(r.radiusKm, null);
});

test('never offers a full plan, one already joined, or one that started over 2 hours ago', () => {
  const r = startPlans([plan('full', { going: 6 }), plan('mine', { joined: true }), plan('old', { startsAt: at(-3) }), plan('running', { startsAt: at(-1), distanceM: 5000 }), plan('nolimit', { maxPeople: null, going: 40, distanceM: 6000 })], null, NOW);
  assert.deepEqual(r.plans.map(p => p.id), ['running', 'nolimit']);
});

test('nothing nearby: the nearest further out, with the radius; nothing anywhere: empty', () => {
  assert.deepEqual(startPlans([], { radiusKm: 100, activities: [plan('w2', { distanceM: 60_000 }), plan('w1', { distanceM: 40_000 })] }, NOW), { plans: [plan('w1', { distanceM: 40_000 }), plan('w2', { distanceM: 60_000 })], radiusKm: 100 });
  assert.deepEqual(startPlans([plan('full', { going: 6 })], { radiusKm: 100, activities: [plan('w', { joined: true })] }, NOW), { plans: [], radiusKm: null });
  assert.deepEqual(startPlans(undefined, undefined, NOW), { plans: [], radiusKm: null });
});

test('greets by first name only, and copes with no name', () => {
  assert.equal(firstName('Asha Rao'), 'Asha');
  assert.equal(firstName('  Ben  '), 'Ben');
  assert.equal(firstName(''), '');
  assert.equal(firstName(null), '');
});
