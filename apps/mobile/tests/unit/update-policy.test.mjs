// The Google Play in-app update rule (src/lib/update-policy.ts) and the run that applies it (src/lib/update-runner.ts):
// at most one question to Play a day, a background (flexible) update by default, a blocking one only when the API's
// ANDROID_MIN_VERSION_CODE or the Play Console's own priority says this version must not keep running.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  CHECK_EVERY_MS, DISMISS_BACKOFF_MS, IMMEDIATE_PRIORITY, RETRY_AFTER_MS,
  mustUpdate, parseMinCode, parseState, pendingInstall, plan, shouldCheck,
} from '../../src/lib/update-policy.ts';
import { createUpdateRunner } from '../../src/lib/update-runner.ts';

const CODE = 14;
const ctx = (o = {}) => ({ now: 1_000_000_000_000, platform: 'android', supported: true, currentCode: CODE, minCode: null, ...o });
const status = (o = {}) => ({
  available: true, inProgress: false, versionCode: CODE + 1, flexibleAllowed: true, immediateAllowed: true,
  priority: 0, stalenessDays: 1, downloaded: false, inFlight: false, ...o,
});
const state = (o = {}) => ({ checkedAt: null, triedAt: null, dismissedCode: null, dismissedAt: null, pendingCode: null, startedImmediate: null, ...o });

// ---- the 24 hour throttle ------------------------------------------------

test('Play is asked at most once a day, and a failed question costs an hour, not a day', () => {
  const now = ctx().now;
  assert.equal(shouldCheck(state(), ctx()), true, 'a fresh install asks');
  assert.equal(shouldCheck(state({ checkedAt: now - CHECK_EVERY_MS + 1, triedAt: now - CHECK_EVERY_MS + 1 }), ctx()), false);
  assert.equal(shouldCheck(state({ checkedAt: now - CHECK_EVERY_MS, triedAt: now - CHECK_EVERY_MS }), ctx()), true);
  // Asked 10 minutes ago and Play never answered (checkedAt untouched): wait out the hour first.
  assert.equal(shouldCheck(state({ checkedAt: null, triedAt: now - 10 * 60_000 }), ctx()), false);
  assert.equal(shouldCheck(state({ checkedAt: null, triedAt: now - RETRY_AFTER_MS }), ctx()), true);
});

test('a clock set backwards does not hide the check forever', () => {
  const now = ctx().now;
  assert.equal(shouldCheck(state({ checkedAt: now + 5 * CHECK_EVERY_MS, triedAt: now + 5 * CHECK_EVERY_MS }), ctx()), true);
});

test('damaged or missing saved state asks later, never sooner', () => {
  for (const raw of [null, '', 'not json', '[]', '{"checkedAt":"yesterday","pendingCode":-3,"startedImmediate":"yes"}']) {
    const s = parseState(raw);
    assert.deepEqual(s, { checkedAt: null, triedAt: null, dismissedCode: null, dismissedAt: null, pendingCode: null, startedImmediate: null }, raw);
  }
  assert.equal(parseState('{"pendingCode":15.9}').pendingCode, 15);
});

// ---- flexible vs immediate ----------------------------------------------

test('by default Play downloads in the background: a flexible update, never a blocking one', () => {
  const p = plan(state(), status(), ctx());
  assert.deepEqual(p, { do: 'start', immediate: false, versionCode: CODE + 1, forced: false });
});

test('below the API floor the update blocks, but only when the update actually clears the floor', () => {
  assert.equal(mustUpdate(status({ versionCode: 16 }), ctx({ minCode: 16 })), true);
  // Play only has 15 and the floor is 16: blocking someone to install 15 would lock them out for nothing.
  assert.equal(mustUpdate(status({ versionCode: 15 }), ctx({ minCode: 16 })), false);
  // Already at or above the floor.
  assert.equal(mustUpdate(status(), ctx({ minCode: CODE })), false);
  // Unset floor (the normal state) forces nothing.
  assert.equal(mustUpdate(status(), ctx({ minCode: null })), false);
  assert.deepEqual(plan(state(), status({ versionCode: 16 }), ctx({ minCode: 16 })),
    { do: 'start', immediate: true, versionCode: 16, forced: true });
});

test("the Play Console's own priority 4+ blocks too", () => {
  assert.equal(mustUpdate(status({ priority: IMMEDIATE_PRIORITY - 1 }), ctx()), false);
  assert.deepEqual(plan(state(), status({ priority: IMMEDIATE_PRIORITY }), ctx()),
    { do: 'start', immediate: true, versionCode: CODE + 1, forced: true });
  assert.deepEqual(plan(state(), status({ priority: 5 }), ctx()),
    { do: 'start', immediate: true, versionCode: CODE + 1, forced: true });
});

test('a mandatory update Play will not run as a blocking flow falls back to the background one, never to a lockout', () => {
  assert.deepEqual(plan(state(), status({ immediateAllowed: false, priority: 5 }), ctx()),
    { do: 'start', immediate: false, versionCode: CODE + 1, forced: true });
  assert.deepEqual(plan(state(), status({ immediateAllowed: false, flexibleAllowed: false, priority: 5 }), ctx()),
    { do: 'nothing', why: 'not_allowed' });
});

test('nothing to install, something already downloading, or a dismissed version: no prompt', () => {
  assert.deepEqual(plan(state(), status({ available: false }), ctx()), { do: 'nothing', why: 'none' });
  assert.deepEqual(plan(state(), status({ inFlight: true }), ctx()), { do: 'nothing', why: 'none' });
  const dismissed = state({ dismissedCode: CODE + 1, dismissedAt: ctx().now - 1 });
  assert.deepEqual(plan(dismissed, status(), ctx()), { do: 'nothing', why: 'dismissed' });
  // A week later the same version may be offered again.
  assert.equal(plan(state({ dismissedCode: CODE + 1, dismissedAt: ctx().now - DISMISS_BACKOFF_MS }), status(), ctx()).do, 'start');
  // A different version is not covered by the dismissal.
  assert.equal(plan(dismissed, status({ versionCode: CODE + 2 }), ctx()).do, 'start');
  // A dismissal never holds back a mandatory update.
  assert.equal(plan(dismissed, status({ priority: 5 }), ctx()).immediate, true);
});

test('a downloaded update is offered as a restart, and an interrupted blocking update is resumed', () => {
  assert.deepEqual(plan(state(), status({ downloaded: true }), ctx()), { do: 'install', versionCode: CODE + 1 });
  // Play answers an interrupted immediate update with availability only, so available is false here.
  const interrupted = status({ available: false, inProgress: true, versionCode: CODE + 1 });
  assert.deepEqual(plan(state({ startedImmediate: true }), interrupted, ctx()),
    { do: 'start', immediate: true, versionCode: CODE + 1, forced: true });
  // A phone that no longer remembers what it started still resumes: a half-done blocking update must not be stranded.
  assert.equal(plan(state(), interrupted, ctx()).do, 'start');
  assert.deepEqual(plan(state({ startedImmediate: true }), status({ available: false, inProgress: true, immediateAllowed: false }), ctx()),
    { do: 'nothing', why: 'not_allowed' });
});

test('a background download Play calls "in progress" is left alone, never turned into a blocking screen', () => {
  // Play reports a flexible update it is still downloading as a developer-triggered update in progress as well.
  const downloading = status({ available: false, inProgress: true, inFlight: true });
  assert.deepEqual(plan(state({ startedImmediate: false }), downloading, ctx()), { do: 'nothing', why: 'none' });
  assert.deepEqual(plan(state(), downloading, ctx()), { do: 'nothing', why: 'none' }, 'even with nothing remembered');
  // And once Play is between states, what this app started decides.
  assert.deepEqual(plan(state({ startedImmediate: false }), status({ available: false, inProgress: true }), ctx()), { do: 'nothing', why: 'none' });
});

// ---- no-op off Android ---------------------------------------------------

test('the web app and iOS do nothing at all: no check, no plan, no banner', () => {
  for (const platform of ['web', 'ios']) {
    assert.equal(shouldCheck(state(), ctx({ platform })), false, platform);
    assert.deepEqual(plan(state(), status(), ctx({ platform })), { do: 'nothing', why: 'unsupported' }, platform);
    assert.equal(pendingInstall(state({ pendingCode: CODE + 1 }), ctx({ platform })), null, platform);
  }
  // Android, but a build without the native module (an old dev client).
  assert.equal(shouldCheck(state(), ctx({ supported: false })), false);
  assert.deepEqual(plan(state(), status(), ctx({ supported: false })), { do: 'nothing', why: 'unsupported' });
});

test('a remembered download is forgotten once the app is that version or newer', () => {
  assert.equal(pendingInstall(state({ pendingCode: CODE + 1 }), ctx()), CODE + 1);
  assert.equal(pendingInstall(state({ pendingCode: CODE }), ctx()), null);
  assert.equal(pendingInstall(state({ pendingCode: CODE - 1 }), ctx()), null);
  assert.equal(pendingInstall(state(), ctx()), null);
});

test('the floor from the API is read strictly: only a positive whole number is a floor', () => {
  assert.equal(parseMinCode(14), 14);
  assert.equal(parseMinCode('14'), 14);
  assert.equal(parseMinCode(14.7), 14);
  for (const v of [null, undefined, 0, -3, '', 'soon', NaN, Infinity, {}]) assert.equal(parseMinCode(v), null, String(v));
});

// ---- the run -------------------------------------------------------------

function harness(o = {}) {
  const calls = { start: [], track: [], banner: [], install: 0 };
  let store = o.saved ?? null;
  const d = {
    platform: 'android',
    supported: () => o.supported ?? true,
    currentCode: () => CODE,
    load: async () => store,
    save: async raw => { store = raw; },
    minCode: o.minCode ?? (async () => null),
    check: o.check ?? (async () => status()),
    start: o.start ?? (async immediate => { calls.start.push(immediate); return true; }),
    install: o.install ?? (async () => { calls.install++; return true; }),
    showBanner: v => calls.banner.push(v),
    hideBanner: () => calls.banner.push(null),
    track: (e, p) => calls.track.push([e, p]),
    now: () => o.now ?? ctx().now,
    log: () => {},
    timeoutMs: 50,
  };
  if (o.start) d.start = async immediate => { calls.start.push(immediate); return o.start(immediate); };
  return { calls, runner: createUpdateRunner(d), saved: () => (store ? JSON.parse(store) : null) };
}

test('a normal run starts a background update and says so to analytics', async () => {
  const h = harness();
  assert.equal(await h.runner.run(), 'flexible');
  assert.deepEqual(h.calls.start, [false]);
  assert.deepEqual(h.calls.track.map(t => t[0]), ['update_available', 'update_started']);
  assert.equal(h.calls.track[0][1].immediate, false);
  assert.equal(h.saved().checkedAt, ctx().now, 'the day starts now');
  assert.equal(h.saved().startedImmediate, false, 'what was started is remembered, so a resume is the same kind');
});

test('a blocking update that was started is remembered as such', async () => {
  const h = harness({ minCode: async () => CODE + 1 });
  assert.equal(await h.runner.run(), 'immediate');
  assert.equal(h.saved().startedImmediate, true);
});

test('Play unreachable: no prompt, nothing said, and the next try is in an hour, not a day', async () => {
  const h = harness({ check: async () => { throw new Error('offline'); } });
  assert.equal(await h.runner.run(), 'check_failed');
  assert.deepEqual(h.calls.start, []);
  assert.deepEqual(h.calls.track, []);
  assert.equal(h.saved().checkedAt, null, 'an unanswered question does not count as a check');
  assert.equal(h.saved().triedAt, ctx().now);
});

test('a Play check that hangs is given up on instead of hanging the run', async () => {
  const h = harness({ check: () => new Promise(() => {}) });
  assert.equal(await h.runner.run(), 'check_failed');
});

test('the API being down forces nothing: the background update still happens', async () => {
  const h = harness({ minCode: async () => { throw new Error('502'); }, check: async () => status({ versionCode: 99 }) });
  assert.equal(await h.runner.run(), 'flexible');
  assert.deepEqual(h.calls.start, [false]);
});

test('the API floor makes the very same update a blocking one', async () => {
  const h = harness({ minCode: async () => CODE + 1 });
  assert.equal(await h.runner.run(), 'immediate');
  assert.deepEqual(h.calls.start, [true]);
  assert.equal(h.calls.track[0][1].forced, true);
});

test('the API is not even asked when Play has nothing', async () => {
  let asked = 0;
  const h = harness({ check: async () => status({ available: false }), minCode: async () => { asked++; return 20; } });
  assert.equal(await h.runner.run(), 'none');
  assert.equal(asked, 0);
});

test('a second run the same day asks Play nothing', async () => {
  let checks = 0;
  const h = harness({ check: async () => { checks++; return status({ available: false }); } });
  await h.runner.run();
  assert.equal(await h.runner.run(), 'throttled');
  assert.equal(checks, 1);
});

test('a sideloaded build or the web app: the run ends before it touches anything', async () => {
  let checks = 0;
  const h = harness({ supported: false, check: async () => { checks++; return status(); } });
  assert.equal(await h.runner.run(), 'unsupported');
  assert.equal(checks, 0);
  assert.deepEqual(h.calls.banner, []);
});

test('Play refusing to start is not a crash, and is recorded', async () => {
  const h = harness({ start: async () => { throw new Error('SendIntentException'); } });
  assert.equal(await h.runner.run(), 'start_failed');
  assert.deepEqual(h.calls.track.map(t => t[0]), ['update_available', 'update_failed']);
});

test('Play saying "nothing started" is quiet: no update_started event', async () => {
  const h = harness({ start: async () => false });
  assert.equal(await h.runner.run(), 'not_started');
  assert.deepEqual(h.calls.track.map(t => t[0]), ['update_available']);
});

test('a downloaded update shows the banner, survives a restart, and the restart installs it', async () => {
  const h = harness();
  await h.runner.run();
  await h.runner.downloaded();
  assert.deepEqual(h.calls.banner, [CODE + 1]);
  assert.equal(h.saved().pendingCode, CODE + 1);
  assert.ok(h.calls.track.some(t => t[0] === 'update_downloaded'));

  // The app is restarted inside the same day: the banner is back without asking Play again.
  const back = harness({ saved: JSON.stringify(h.saved()), check: async () => { throw new Error('must not be asked'); } });
  assert.equal(await back.runner.run(), 'pending_install');
  assert.deepEqual(back.calls.banner, [CODE + 1]);
  assert.equal(await back.runner.install(), true);
  assert.equal(back.calls.install, 1);
});

test('"Not now" holds for the rest of the session (every resume runs a pass) and the banner is back on the next app start', async () => {
  const h = harness();
  await h.runner.run();
  await h.runner.downloaded();
  assert.deepEqual(h.calls.banner, [CODE + 1]);
  h.runner.dismissBanner();
  // Back to the foreground twice: no banner.
  assert.equal(await h.runner.run(), 'banner_closed');
  assert.equal(await h.runner.run(), 'banner_closed');
  assert.deepEqual(h.calls.banner, [CODE + 1, null], 'shown once, hidden by Not now, never shown again this session');
  // A new process (app start) with the same saved state: the banner returns.
  const next = harness({ saved: JSON.stringify(h.saved()), check: async () => { throw new Error('must not be asked'); } });
  assert.equal(await next.runner.run(), 'pending_install');
  assert.deepEqual(next.calls.banner, [CODE + 1]);
});

test('a banner for an update that is no longer there clears itself', async () => {
  const h = harness({ saved: JSON.stringify(state({ pendingCode: CODE + 1 })), install: async () => { throw new Error('ERR_UPDATE_INSTALL'); } });
  await h.runner.run();
  assert.equal(await h.runner.install(), false);
  assert.equal(h.calls.banner.at(-1), null, 'the banner is hidden');
  assert.equal(h.saved().pendingCode, null);
  assert.ok(h.calls.track.some(t => t[0] === 'update_failed' && t[1].stage === 'install'));
});

test('the update that was waiting is gone once the app is already that version', async () => {
  const h = harness({ saved: JSON.stringify(state({ pendingCode: CODE, checkedAt: ctx().now, triedAt: ctx().now })) });
  assert.equal(await h.runner.run(), 'throttled');
  assert.deepEqual(h.calls.banner, []);
  assert.equal(h.saved().pendingCode, null);
});

test('closing Play\'s dialog leaves that version alone for a week', async () => {
  const h = harness();
  await h.runner.run();
  await h.runner.cancelled('dialog');
  assert.equal(h.saved().dismissedCode, CODE + 1);
  assert.equal(h.saved().dismissedAt, ctx().now);

  const later = harness({ saved: JSON.stringify({ ...h.saved(), checkedAt: null, triedAt: null }) });
  assert.equal(await later.runner.run(), 'dismissed');
  assert.deepEqual(later.calls.start, []);
});

test('an install that finished is reported once and clears the banner', async () => {
  const h = harness();
  await h.runner.run();
  await h.runner.downloaded();
  await h.runner.installed();
  assert.ok(h.calls.track.some(t => t[0] === 'update_installed'));
  assert.equal(h.calls.banner.at(-1), null);
  assert.equal(h.saved().pendingCode, null);
});

test('two runs at once are one run', async () => {
  let checks = 0;
  const h = harness({ check: async () => { checks++; return status({ available: false }); } });
  const [a, b] = await Promise.all([h.runner.run(), h.runner.run()]);
  assert.equal(a, b);
  assert.equal(checks, 1);
});

test('an unwritable keystore still runs, and still asks only once per app start', async () => {
  const calls = [];
  const runner = createUpdateRunner({
    platform: 'android', supported: () => true, currentCode: () => CODE,
    load: async () => { throw new Error('keystore'); },
    save: async () => { throw new Error('keystore'); },
    minCode: async () => null, check: async () => status(),
    start: async i => { calls.push(i); return true; }, install: async () => true,
    showBanner: () => {}, hideBanner: () => {}, track: () => {}, now: () => ctx().now, log: () => {}, timeoutMs: 50,
  });
  assert.equal(await runner.run(), 'flexible');
  // In memory the state survives even when the keystore does not, so a second run the same day is quiet.
  assert.equal(await runner.run(), 'throttled');
  assert.deepEqual(calls, [false]);
});

// ---- the wiring ----------------------------------------------------------

test('the root layout starts the check and mounts the banner', () => {
  const src = readFileSync(new URL('../../src/app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(src, /startUpdateChecks\(\)/);
  assert.match(src, /<UpdateBanner \/>/);
});

test('the native module is only ever reached through the policy, never straight from a screen', () => {
  const src = readFileSync(new URL('../../src/lib/update-prompt.ts', import.meta.url), 'utf8');
  assert.match(src, /modules\/in-app-updates/);
  assert.match(src, /Platform\.OS === 'android'/);
  // The banner's button is the only way completeUpdate() is reached.
  assert.match(readFileSync(new URL('../../src/components/UpdateBanner.tsx', import.meta.url), 'utf8'), /installUpdate\(\)/);
});

test('the Android module asks Play but never restarts the app on its own', () => {
  const kt = readFileSync(new URL('../../modules/in-app-updates/android/src/main/java/com/tablamigo/inappupdates/InAppUpdatesModule.kt', import.meta.url), 'utf8');
  // completeUpdate() restarts the app. It must be reachable only through the install() function the banner calls.
  const installs = kt.split('m.completeUpdate()').length - 1;
  assert.equal(installs, 1, 'exactly one completeUpdate() call');
  const listener = kt.slice(kt.indexOf('private val installListener'), kt.indexOf('override fun definition'));
  assert.doesNotMatch(listener, /completeUpdate/, 'a finished download tells the app, it does not restart it');
});
