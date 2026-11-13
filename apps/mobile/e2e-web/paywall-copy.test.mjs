// The subscription disclosure under the Subscribe button on the Play paywall (src/lib/paywall-copy.ts renewalNotice).
// Google Play wants the price, the billing period, that it renews automatically and how to cancel in front of the person
// before they buy. It was deleted once by accident (f0bcdb5); this fails if any of the four goes missing again.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renewalNotice, paywallReason, reasonHeading, REASONS } from '../src/lib/paywall-copy.ts';

for (const [plan, unit] of [['weekly', 'week'], ['monthly', 'month'], ['halfyearly', '6 months'], ['yearly', 'year']]) {
  test(`${plan}: price, period, automatic renewal and how to cancel`, () => {
    const t = renewalNotice(plan, '₹299.00');
    assert.match(t, /₹299\.00 per /, 'the price');
    assert.ok(t.includes(`per ${unit}`), 'the period');
    assert.ok(t.includes(`every ${unit}`) && /renews automatically/i.test(t) && /until you cancel/i.test(t), 'that it renews automatically until cancelled');
    assert.ok(/Cancel any time in Google Play/.test(t), 'where to cancel');
  });
}

test('the Trip Pass is a one-time purchase with its price, and says nothing renews', () => {
  const t = renewalNotice('pass', '$9.99');
  assert.match(t, /one-time purchase of \$9\.99/);
  assert.match(t, /Nothing renews/);
  assert.doesNotMatch(t, /renews automatically/i);
});

test('each plan names its price: a different price gives a different line', () => {
  assert.notEqual(renewalNotice('monthly', '₹299.00'), renewalNotice('monthly', '₹349.00'));
  assert.notEqual(renewalNotice('monthly', '₹299.00'), renewalNotice('yearly', '₹299.00'));
});

test('the paywall reason from the URL: known ones kept, anything else general, so a crafted link cannot reach the heading', () => {
  for (const r of Object.keys(REASONS)) assert.equal(paywallReason(r), r);
  for (const r of ['advanced_filters', 'buddy_requests_limit', 'trusted_contacts_limit']) {
    assert.equal(paywallReason(r), r);
    assert.equal(reasonHeading(r), 'Make every trip social');
  }
  assert.equal(paywallReason(['remove_ads', 'dm']), 'remove_ads', 'a repeated ?reason= takes the first');
  for (const r of [undefined, null, '', 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'x'.repeat(5000), 42, {}, '<b>hi</b>']) {
    assert.equal(paywallReason(r), 'general', String(r).slice(0, 20));
    assert.equal(reasonHeading(r), 'Make every trip social', String(r).slice(0, 20));
  }
});
