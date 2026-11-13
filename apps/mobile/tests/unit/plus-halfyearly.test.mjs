// The 6-month Plus plan (halfyearly, 2 Nov 2026): its per-month price and saving against monthly, its place between monthly and
// yearly on both paywalls, its renewal notice, and that an app which doesn't know a base plan simply leaves it out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { halfYearDeal, planDeal, yearlyBadge, yearlyDeal, pickPlayOffers, introOrder, planOrder } from '../../src/lib/plus-intro.ts';
import { renewalNotice } from '../../src/lib/paywall-copy.ts';

test('6 months per month and saving, from the real prices (India ₹499 / ₹2,499, US $9.99 / $34.99, UK £8.99 / £31.49)', () => {
  assert.deepEqual(halfYearDeal(499, 2499), { perMonth: 417, savePct: 16 });     // 416.5 rounds up, 16.5% rounds down
  assert.equal(yearlyBadge(halfYearDeal(499, 2499), 'INR', 'en-IN'), '₹417/month · save 16%');
  assert.deepEqual(halfYearDeal(9.99, 34.99), { perMonth: 5.84, savePct: 41 });  // 5.8316 up to 5.84; 41.6% down to 41
  assert.equal(yearlyBadge(halfYearDeal(9.99, 34.99), 'USD', 'en-US'), '$5.84/month · save 41%');
  assert.deepEqual(halfYearDeal(8.99, 31.49), { perMonth: 5.25, savePct: 41 });
  assert.equal(halfYearDeal(499, 2994), null, 'no saving: no badge');
  assert.equal(halfYearDeal(null, 2499), null);
  assert.equal(planDeal(499, 499, 1), null, 'a one-month plan has no deal');
});

test('owner rule: 6 months is a bit cheaper than 6× monthly and a bit dearer than half of yearly, so yearly stays the best deal', () => {
  for (const [m, h, y] of [[499, 2499, 3999], [9.99, 34.99, 48.99]]) {
    assert.ok(h < 6 * m && h > y / 2, `${m}/${h}/${y}`);
    assert.ok(yearlyDeal(m, y).savePct > halfYearDeal(m, h).savePct);
  }
});

const phase = (period, micros, cur = 'INR') => ({ billingPeriod: period, priceAmountMicros: String(micros), priceCurrencyCode: cur });
const PERIOD = { weekly: 'P1W', monthly: 'P1M', halfyearly: 'P6M', yearly: 'P1Y' };
const base = (plan, micros, display) => ({ id: plan, basePlanIdAndroid: plan, displayPrice: display, offerTokenAndroid: `tok-${plan}`, pricingPhasesAndroid: { pricingPhaseList: [phase(PERIOD[plan] ?? 'P3M', micros)] } });
// Play's order is its own: the screen must not depend on it.
const OFFERS = [base('yearly', 3999e6, '₹3,999'), base('halfyearly', 2499e6, '₹2,499'), base('weekly', 149e6, '₹149'), base('monthly', 499e6, '₹499')];

test('Play returns the 6-month base plan: picked like the others, with its token and amount', () => {
  const { plans } = pickPlayOffers(OFFERS, null);
  assert.deepEqual(plans.find(p => p.basePlan === 'halfyearly'), { basePlan: 'halfyearly', price: '₹2,499', token: 'tok-halfyearly', amount: 2499, currency: 'INR' });
});

test('the full paywall: weekly, monthly, 6 months, yearly, Trip Pass; the intro: yearly, 6 months, monthly, Trip Pass', () => {
  const plans = [...pickPlayOffers(OFFERS, null).plans, { basePlan: 'pass' }];
  assert.deepEqual(planOrder(plans).map(p => p.basePlan), ['weekly', 'monthly', 'halfyearly', 'yearly', 'pass']);
  assert.deepEqual(introOrder(plans).map(p => p.basePlan), ['yearly', 'halfyearly', 'monthly', 'pass']);
  // Without the 6-month plan (a region or a Play answer without it) nothing else moves.
  assert.deepEqual(planOrder(plans.filter(p => p.basePlan !== 'halfyearly')).map(p => p.basePlan), ['weekly', 'monthly', 'yearly', 'pass']);
});

test('a base plan the app does not know is left out, never shown or crashed on (what older builds do with halfyearly)', () => {
  const plans = pickPlayOffers([...OFFERS, base('quarterly', 1299e6, '₹1,299')], null).plans;
  assert.ok(plans.some(p => p.basePlan === 'quarterly'), 'picked from Play');
  assert.ok(!planOrder(plans).some(p => p.basePlan === 'quarterly'), 'but not listed');
  // Build 15 and older list exactly these base plans, in this order (Paywall.tsx before 2 Nov), so halfyearly is dropped there.
  const old = ['weekly', 'monthly', 'yearly', 'pass'].map(b => plans.find(p => p.basePlan === b)).filter(Boolean);
  assert.deepEqual(old.map(p => p.basePlan), ['weekly', 'monthly', 'yearly']);
});

test('the 6-month renewal notice: price, "per 6 months", renews every 6 months, how to cancel', () => {
  const t = renewalNotice('halfyearly', '₹2,499');
  assert.equal(t, '₹2,499 per 6 months, charged to your Google Play account. Renews automatically every 6 months until you cancel. Cancel any time in Google Play, under Subscriptions.');
});

test('both paywalls label the 6-month plan and give it the saving badge, never "Best value"', () => {
  const native = fs.readFileSync(new URL('../../src/screens/Paywall.tsx', import.meta.url), 'utf8');
  const web = fs.readFileSync(new URL('../../src/screens/Paywall.web.tsx', import.meta.url), 'utf8');
  assert.match(native, /halfyearly: \['6 months'\]/);
  assert.match(native, /halfYearDeal\(m\.amount, h\.amount\)/);
  assert.match(native, /planOrder\(byPlan\)/);
  assert.match(web, /id: 'halfyearly', basePlan: 'halfyearly', price: inr\(rzp\.prices\.halfyearly\), label: '6 months'/);
  // The badge is the saving line alone; "Best value" stays on yearly.
  assert.match(native, /if \(b\) h\.badge = b;/);
  assert.match(web, /label: '6 months', badge: half \?\? undefined/);
});
