// The soft paywall after onboarding and the yearly plan's numbers (src/lib/plus-intro.ts): prices from the real ones, the trial only
// when the API names a Play offer AND Play returns it, no weekly plan in the intro, and the start screen's hand-off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { afterStart, yearlyDeal, money, yearlyBadge, isoDays, pickPlayOffers, trialLine, introOrder, introLine, purchaseToken, planOrder, INTRO_OFFERS } from '../../src/lib/plus-intro.ts';
import { renewalNotice } from '../../src/lib/paywall-copy.ts';

test('yearly per month and saving, from the web prices (₹499 a month, ₹3,999 a year)', () => {
  assert.deepEqual(yearlyDeal(499, 3999), { perMonth: 334, savePct: 33 }); // 333.25 rounds up, 33.2% rounds down
  assert.equal(yearlyBadge(yearlyDeal(499, 3999), 'INR', 'en-IN'), '₹334/month · save 33%');
});

test('never reads cheaper or a bigger saving than the prices give', () => {
  assert.deepEqual(yearlyDeal(19.99, 89.99), { perMonth: 7.5, savePct: 62 });     // 7.4991.. up to 7.50; 62.48% down to 62
  assert.deepEqual(yearlyDeal(10, 96), { perMonth: 8, savePct: 20 });              // exact values stay exact
  assert.equal(yearlyDeal(499, 5988), null);                                        // no saving: no badge
  assert.equal(yearlyDeal(null, 3999), null);
  assert.equal(yearlyDeal(499, 0), null);
  assert.equal(money(7.5, 'USD', 'en-US'), '$7.50');
  assert.equal(money(334, 'INR', 'en-IN'), '₹334');
  assert.equal(money(5, 'XXX-bad'), 'XXX-bad 5');
});

const phase = (period, micros, cur = 'INR', formattedPrice) => ({ billingPeriod: period, priceAmountMicros: String(micros), priceCurrencyCode: cur, billingCycleCount: 1, ...(formattedPrice ? { formattedPrice } : {}) });
const base = (plan, micros, display) => ({ id: plan, basePlanIdAndroid: plan, displayPrice: display, offerTokenAndroid: `tok-${plan}`, pricingPhasesAndroid: { pricingPhaseList: [phase({ yearly: 'P1Y', halfyearly: 'P6M', monthly: 'P1M' }[plan] ?? 'P1W', micros)] } });
const trialOffer = (id = 'yearly-trial-3d', plan = 'yearly', first = phase('P3D', 0)) => ({ id, basePlanIdAndroid: plan, displayPrice: '₹0', offerTokenAndroid: `tok-${id}`, pricingPhasesAndroid: { pricingPhaseList: [first, phase('P1Y', 3999e6)] } });
const OFFERS = [base('weekly', 149e6, '₹149'), base('monthly', 499e6, '₹499'), base('yearly', 3999e6, '₹3,999')];

test('flag off: base plans only, no trial, even when Play has a trial offer', () => {
  const r = pickPlayOffers([...OFFERS, trialOffer()], null);
  assert.equal(r.trial, null);
  assert.deepEqual(r.plans.map(p => [p.basePlan, p.token, p.amount]), [['weekly', 'tok-weekly', 149], ['monthly', 'tok-monthly', 499], ['yearly', 'tok-yearly', 3999]]);
});

test('flag on and Play returns that offer: the trial, with its days from Play', () => {
  const r = pickPlayOffers([...OFFERS, trialOffer()], 'yearly-trial-3d');
  assert.deepEqual(r.trial, { token: 'tok-yearly-trial-3d', days: 3, intro: null });
  assert.equal(r.plans.find(p => p.basePlan === 'yearly').token, 'tok-yearly', 'the yearly row keeps its own base plan');
  assert.equal(trialLine(3, '₹3,999'), '3 days free, then ₹3,999/year');
});

test('flag on but no trial: not returned by Play (not eligible), another id, another base plan, or a paid first phase', () => {
  assert.equal(pickPlayOffers(OFFERS, 'yearly-trial-3d').trial, null);
  assert.equal(pickPlayOffers([...OFFERS, trialOffer('other-offer')], 'yearly-trial-3d').trial, null);
  assert.equal(pickPlayOffers([...OFFERS, trialOffer('yearly-trial-3d', 'monthly')], 'yearly-trial-3d').trial, null);
  assert.equal(pickPlayOffers([...OFFERS, trialOffer('yearly-trial-3d', 'yearly', phase('P3D', 10e6))], 'yearly-trial-3d').trial, null);
  assert.equal(pickPlayOffers([...OFFERS, trialOffer('yearly-trial-3d', 'yearly', phase('P1M', 0))], 'yearly-trial-3d').trial, null);
});

test('no trial when the price after the free days is not the yearly price the screen names', () => {
  const cheaper = { ...trialOffer(), pricingPhasesAndroid: { pricingPhaseList: [phase('P3D', 0), phase('P1Y', 2999e6)] } };
  assert.equal(pickPlayOffers([...OFFERS, cheaper], 'yearly-trial-3d').trial, null);
  assert.equal(pickPlayOffers([trialOffer(), base('monthly', 499e6, '₹499')], 'yearly-trial-3d').trial, null, 'no yearly row to compare with');
});

test('an intro offer never takes the place of a base plan price', () => {
  const r = pickPlayOffers([trialOffer('summer-trial'), trialOffer('intro-50'), ...OFFERS], null);
  assert.equal(r.plans.find(p => p.basePlan === 'yearly').token, 'tok-yearly');
  assert.equal(r.plans.length, 3);
});

test('isoDays reads the trial periods Play uses', () => {
  assert.equal(isoDays('P3D'), 3); assert.equal(isoDays('P1W'), 7); assert.equal(isoDays('P1M'), null); assert.equal(isoDays(''), null); assert.equal(isoDays('P0D'), null);
});

test('the intro offers yearly, monthly and the Trip Pass, in that order, and no weekly plan', () => {
  assert.deepEqual(introOrder([{ basePlan: 'weekly' }, { basePlan: 'monthly' }, { basePlan: 'yearly' }, { basePlan: 'pass' }]).map(p => p.basePlan), ['yearly', 'monthly', 'pass']);
});

test('the notice under the button names the trial terms only when a trial is bought', () => {
  assert.doesNotMatch(renewalNotice('yearly', '₹3,999'), /free|trial/i);
  const t = renewalNotice('yearly', '₹3,999', 14, 3);
  assert.match(t, /^Free for 3 days, then ₹3,999 per year/);
  assert.match(t, /unless you cancel before then/);
  assert.match(t, /Cancel any time in Google Play, under Subscriptions/);
});

test('leaving the start screen: the Plus screen only when the API says show', async () => {
  const calls = [];
  const api = answer => async (path, init) => { calls.push([path, init]); if (answer instanceof Error) throw answer; return answer; };
  assert.equal(await afterStart(api({ show: true, reason: 'show' })), '/paywall?intro=1');
  assert.deepEqual(calls[0], ['/me/plus-intro', { body: {} }]);
  assert.equal(await afterStart(api({ show: false, reason: 'seen' })), '/(tabs)');
  assert.equal(await afterStart(api({ show: 'yes' })), '/(tabs)');
  assert.equal(await afterStart(api(new Error('offline'))), '/(tabs)');
  assert.equal(await afterStart(() => new Promise(() => {}), 20), '/(tabs)', 'a hung call never holds the person on the start screen');
});

test('the web paywall never says anything about a trial; both paywalls have "Not now" in intro mode', () => {
  const web = fs.readFileSync(new URL('../../src/screens/Paywall.web.tsx', import.meta.url), 'utf8');
  const play = fs.readFileSync(new URL('../../src/screens/Paywall.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(web.replace(/\/\/.*$/gm, ''), /trial/i);
  assert.doesNotMatch(web, /pickPlayOffers|trialLine|PlayTrial/);
  // One offer token per purchase, chosen by purchaseToken (the trial only for the yearly plan).
  assert.match(play, /const token = purchaseToken\(p\.basePlan, p\.token, trial, intros\);/);
  for (const src of [web, play]) assert.match(src, /intro \? <Button title="Not now" kind="ghost"/);
  assert.match(play, /chosen\.basePlan === 'yearly' && trial \? `Start \$\{trial\.days\}-day free trial`|chosen\?\.basePlan === 'yearly' && trial \? `Start \$\{trial\.days\}-day free trial`/);
});

// ---- intro offers (2 Nov 2026) -------------------------------------------------------------------
const intro = (id, plan, period, micros, display, baseMicros) => ({ id, basePlanIdAndroid: plan, displayPrice: display, offerTokenAndroid: `tok-${id}`,
  pricingPhasesAndroid: { pricingPhaseList: [phase(period, micros, 'INR', display), phase(period, baseMicros)] } });
const MONTHLY_50 = intro('monthly-intro-50', 'monthly', 'P1M', 249e6, '₹249', 499e6);
const YEARLY_20 = intro('yearly-launch-20', 'yearly', 'P1Y', 3199e6, '₹3,199', 3999e6);
const TRIAL_20 = { id: 'yearly-trial-3d', basePlanIdAndroid: 'yearly', displayPrice: '₹0', offerTokenAndroid: 'tok-yearly-trial-3d',
  pricingPhasesAndroid: { pricingPhaseList: [phase('P3D', 0), phase('P1Y', 3199e6, 'INR', '₹3,199'), phase('P1Y', 3999e6)] } };

test('intro offers: Play\'s own first-period price per base plan, the base rows unchanged', () => {
  const r = pickPlayOffers([...OFFERS, MONTHLY_50, YEARLY_20], null);
  assert.deepEqual(r.intros, { monthly: { token: 'tok-monthly-intro-50', price: '₹249' }, yearly: { token: 'tok-yearly-launch-20', price: '₹3,199' } });
  assert.deepEqual(r.plans.map(p => [p.basePlan, p.token, p.price]), [['weekly', 'tok-weekly', '₹149'], ['monthly', 'tok-monthly', '₹499'], ['yearly', 'tok-yearly', '₹3,999']]);
  assert.equal(r.trial, null);
  assert.equal(introLine('monthly', '₹249', '₹499'), '₹249 for your first month, then ₹499/month');
  assert.equal(introLine('yearly', '₹3,199', '₹3,999'), '₹3,199 for your first year, then ₹3,999/year');
});

test('no intro when Play does not return it (not a new customer) or it is not the offer the screen describes', () => {
  assert.deepEqual(pickPlayOffers(OFFERS, null).intros, {});
  const off = (o, patch) => ({ ...o, pricingPhasesAndroid: { pricingPhaseList: patch(o.pricingPhasesAndroid.pricingPhaseList) } });
  for (const bad of [
    { ...MONTHLY_50, id: 'monthly-summer' },                                  // an id the screen does not know
    { ...MONTHLY_50, basePlanIdAndroid: 'weekly' },                           // on another base plan
    off(MONTHLY_50, l => [l[0], phase('P1M', 599e6)]),                        // then a price other than the monthly row's
    off(MONTHLY_50, l => [phase('P1M', 0, 'INR', '₹0'), l[1]]),               // free, not discounted
    off(MONTHLY_50, l => [phase('P1M', 599e6, 'INR', '₹599'), l[1]]),         // dearer than the base plan
    off(MONTHLY_50, l => [{ ...l[0], billingCycleCount: 3 }, l[1]]),         // three discounted months, not one
    off(MONTHLY_50, l => [phase('P1W', 249e6, 'INR', '₹249'), l[1]]),         // a week, not the plan's month
    off(MONTHLY_50, l => [phase('P1M', 249e6), l[1]]),                        // no price string from Play
    { ...MONTHLY_50, offerTokenAndroid: null },
  ]) assert.deepEqual(pickPlayOffers([...OFFERS, bad], null).intros, {}, JSON.stringify(bad).slice(0, 120));
});

test('the yearly trial with a discounted first year: one offer, with Play\'s price for that year', () => {
  const r = pickPlayOffers([...OFFERS, MONTHLY_50, YEARLY_20, TRIAL_20], 'yearly-trial-3d');
  assert.deepEqual(r.trial, { token: 'tok-yearly-trial-3d', days: 3, intro: '₹3,199' });
  assert.equal(trialLine(3, '₹3,999', '₹3,199'), '3 days free, then ₹3,199 for your first year, then ₹3,999/year');
  // A middle phase that is not one discounted year: no trial.
  const odd = { ...TRIAL_20, pricingPhasesAndroid: { pricingPhaseList: [phase('P3D', 0), phase('P1M', 99e6, 'INR', '₹99'), phase('P1Y', 3999e6)] } };
  assert.equal(pickPlayOffers([...OFFERS, odd], 'yearly-trial-3d').trial, null);
  // The trial switch off: the combined offer is never shown or sold, and yearly falls back to the 20% offer.
  const off = pickPlayOffers([...OFFERS, YEARLY_20, TRIAL_20], null);
  assert.equal(off.trial, null);
  assert.equal(purchaseToken('yearly', 'tok-yearly', off.trial, off.intros), 'tok-yearly-launch-20');
});

test('a purchase carries exactly one offer: trial, else intro, else the base plan', () => {
  const all = pickPlayOffers([...OFFERS, MONTHLY_50, YEARLY_20, TRIAL_20], 'yearly-trial-3d');
  assert.equal(purchaseToken('yearly', 'tok-yearly', all.trial, all.intros), 'tok-yearly-trial-3d');
  assert.equal(purchaseToken('monthly', 'tok-monthly', all.trial, all.intros), 'tok-monthly-intro-50', 'the trial never applies to monthly');
  assert.equal(purchaseToken('weekly', 'tok-weekly', all.trial, all.intros), 'tok-weekly');
  const returning = pickPlayOffers(OFFERS, 'yearly-trial-3d'); // Play returns no new-customer offers to a past subscriber
  assert.equal(purchaseToken('yearly', 'tok-yearly', returning.trial, returning.intros), 'tok-yearly');
  assert.equal(purchaseToken('monthly', 'tok-monthly', returning.trial, returning.intros), 'tok-monthly');
  assert.equal(purchaseToken('monthly', null, null, {}), null);
});

test('all four plans with every intro offer live: the 6-month row keeps its own price and token, no intro or trial', () => {
  const r = pickPlayOffers([...OFFERS, base('halfyearly', 2499e6, '₹2,499'), MONTHLY_50, YEARLY_20, TRIAL_20], 'yearly-trial-3d');
  assert.deepEqual(planOrder(r.plans).map(p => [p.basePlan, p.token, p.price]), [['weekly', 'tok-weekly', '₹149'], ['monthly', 'tok-monthly', '₹499'], ['halfyearly', 'tok-halfyearly', '₹2,499'], ['yearly', 'tok-yearly', '₹3,999']]);
  assert.deepEqual(Object.keys(r.intros).sort(), ['monthly', 'yearly']);
  assert.equal(purchaseToken('halfyearly', 'tok-halfyearly', r.trial, r.intros), 'tok-halfyearly');
  assert.equal(purchaseToken('monthly', 'tok-monthly', r.trial, r.intros), 'tok-monthly-intro-50');
  assert.equal(purchaseToken('yearly', 'tok-yearly', r.trial, r.intros), 'tok-yearly-trial-3d');
  // A multi-phase offer on the 6-month plan neither replaces its row nor becomes an intro.
  const extra = { ...trialOffer('halfyearly-trial', 'halfyearly'), pricingPhasesAndroid: { pricingPhaseList: [phase('P3D', 0), phase('P6M', 2499e6)] } };
  const x = pickPlayOffers([...OFFERS, base('halfyearly', 2499e6, '₹2,499'), extra], null);
  assert.equal(x.plans.find(p => p.basePlan === 'halfyearly').token, 'tok-halfyearly');
  assert.deepEqual(x.intros, {});
});

test('the notice under the button gives the intro price, then the normal one', () => {
  assert.match(renewalNotice('monthly', '₹499', 14, undefined, '₹249'), /^₹249 for your first month, then ₹499 per month, charged to your Google Play account\. Renews automatically every month/);
  assert.match(renewalNotice('yearly', '₹3,999', 14, 3, '₹3,199'), /^Free for 3 days, then ₹3,199 for your first year, then ₹3,999 per year, charged to your Google Play account when the trial ends unless you cancel/);
  assert.equal(renewalNotice('monthly', '₹499', 14, undefined, null), renewalNotice('monthly', '₹499'));
});
