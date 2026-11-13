// The AdMob consent gate (src/lib/ads-consent.ts) driven with a fake Google consent SDK (UMP) and a fake Mobile Ads SDK.
// What matters: the SDK is never started, and so no ad is ever requested, before Google's consent step has answered
// canRequestAds = true; the consent form is never opened twice at once; a refusal, an error or being offline means no ads, and
// the next foreground tries again; Profile's "Ad privacy choices" shows exactly when Google says it is required.
//   cd apps/mobile && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAdsGate } from '../../src/lib/ads-consent.ts';

const REQUIRED = 'REQUIRED', NOT_REQUIRED = 'NOT_REQUIRED';

/** A fake SDK. `answers` are what getConsentInfo returns, in turn (the last one repeats); a value that is an Error is thrown. */
function fakeSdk({ answers = [{ canRequestAds: true, privacyOptionsRequirementStatus: NOT_REQUIRED }], gather = () => Promise.resolve(),
  init = () => Promise.resolve([]) } = {}) {
  const calls = [];
  let i = 0;
  const sdk = {
    AdsConsent: {
      gatherConsent: () => { calls.push('gather'); return gather(); },
      getConsentInfo: async () => {
        calls.push('info');
        const a = answers[Math.min(i++, answers.length - 1)];
        if (a instanceof Error) throw a;
        return a;
      },
      showPrivacyOptionsForm: async () => { calls.push('privacyForm'); },
    },
    AdsConsentPrivacyOptionsRequirementStatus: { REQUIRED, NOT_REQUIRED },
    default: () => ({ initialize: () => { calls.push('initialize'); return init(); } }),
  };
  return { sdk, calls };
}

function harness(opts) {
  const { sdk, calls } = fakeSdk(opts);
  let state = { ready: false, privacyOptions: false };
  const gate = createAdsGate(sdk, s => { state = { ...state, ...s }; }, () => state);
  return { gate, calls, state: () => state };
}

test('a build without the ads SDK does nothing at all', async () => {
  let state = { ready: false, privacyOptions: false };
  const gate = createAdsGate(null, s => { state = { ...state, ...s }; }, () => state);
  await gate.start();
  await gate.openPrivacyOptions();
  assert.deepEqual(state, { ready: false, privacyOptions: false });
});

test('consent first: the SDK starts only after the consent step says ads may be requested, and only once', async () => {
  const h = harness();
  await h.gate.start();
  assert.deepEqual(h.calls, ['gather', 'info', 'initialize']);
  assert.deepEqual(h.state(), { ready: true, privacyOptions: false });
  // Coming back to the foreground once ads are ready changes nothing: no second form, no second start.
  await h.gate.start();
  await h.gate.start();
  assert.deepEqual(h.calls, ['gather', 'info', 'initialize']);
});

test('the SDK is not started while the consent form is still open', async () => {
  let answer;
  const h = harness({ gather: () => new Promise(r => { answer = r; }) });
  const p = h.gate.start();
  await new Promise(r => setImmediate(r));
  assert.deepEqual(h.calls, ['gather']);
  assert.equal(h.state().ready, false);
  answer();
  await p;
  assert.deepEqual(h.calls, ['gather', 'info', 'initialize']);
});

test('a refusal (canRequestAds false) means no SDK and no ads, and the next foreground asks Google again', async () => {
  const h = harness({ answers: [{ canRequestAds: false, privacyOptionsRequirementStatus: REQUIRED }, { canRequestAds: true, privacyOptionsRequirementStatus: REQUIRED }] });
  await h.gate.start();
  assert.ok(!h.calls.includes('initialize'));
  assert.deepEqual(h.state(), { ready: false, privacyOptions: true });
  await h.gate.start();
  assert.deepEqual(h.calls, ['gather', 'info', 'gather', 'info', 'initialize']);
  assert.deepEqual(h.state(), { ready: true, privacyOptions: true });
});

test('offline or a consent-SDK error: the previous answer is used, as Google says', async () => {
  const yes = harness({ gather: () => Promise.reject(new Error('offline')) });
  await yes.gate.start();
  assert.deepEqual(yes.calls, ['gather', 'info', 'initialize']);
  assert.equal(yes.state().ready, true);
  const no = harness({ gather: () => Promise.reject(new Error('offline')), answers: [{ canRequestAds: false, privacyOptionsRequirementStatus: NOT_REQUIRED }] });
  await no.gate.start();
  assert.ok(!no.calls.includes('initialize'));
  assert.equal(no.state().ready, false);
});

test('a failed consent read or SDK start shows no ads, never throws, and is tried again later', async () => {
  const info = harness({ answers: [new Error('UMP down'), { canRequestAds: true, privacyOptionsRequirementStatus: NOT_REQUIRED }] });
  await assert.doesNotReject(info.gate.start());
  assert.equal(info.state().ready, false);
  assert.ok(!info.calls.includes('initialize'));
  await info.gate.start();
  assert.equal(info.state().ready, true);

  let fail = true;
  const init = harness({ init: () => (fail ? Promise.reject(new Error('init failed')) : Promise.resolve([])) });
  await assert.doesNotReject(init.gate.start());
  assert.equal(init.state().ready, false);
  fail = false;
  await init.gate.start();
  assert.equal(init.state().ready, true);
  assert.equal(init.calls.filter(c => c === 'initialize').length, 2);
});

test('overlapping starts (launch and a foreground event together) share one consent step: the form never opens twice', async () => {
  let answer;
  const h = harness({ gather: () => new Promise(r => { answer = r; }) });
  const a = h.gate.start(), b = h.gate.start(), c = h.gate.start();
  answer();
  await Promise.all([a, b, c]);
  assert.equal(h.calls.filter(x => x === 'gather').length, 1);
  assert.equal(h.calls.filter(x => x === 'initialize').length, 1);
});

test('"Ad privacy choices" follows Google: shown when required, and changing the choice there turns ads off or on again', async () => {
  const h = harness({ answers: [
    { canRequestAds: true, privacyOptionsRequirementStatus: REQUIRED },
    { canRequestAds: false, privacyOptionsRequirementStatus: REQUIRED }, // withdrew consent in the form
    { canRequestAds: true, privacyOptionsRequirementStatus: REQUIRED },  // gave it again
  ] });
  await h.gate.start();
  assert.deepEqual(h.state(), { ready: true, privacyOptions: true });
  await h.gate.openPrivacyOptions();
  assert.deepEqual(h.state(), { ready: false, privacyOptions: true });
  await h.gate.openPrivacyOptions();
  assert.deepEqual(h.state(), { ready: true, privacyOptions: true });
  // The SDK was started once; the form only re-reads consent.
  assert.equal(h.calls.filter(x => x === 'initialize').length, 1);
  assert.equal(h.calls.filter(x => x === 'privacyForm').length, 2);
  const notRequired = harness();
  await notRequired.gate.start();
  assert.equal(notRequired.state().privacyOptions, false);
});
