// The store rating ask: when (lib/review-policy.ts), how the moments drive it (lib/review-trigger.ts, with a fake clock, storage,
// server and screen), and the phone wiring (lib/review-prompt.ts with expo-store-review, SecureStore, Keyboard and AppState
// stubbed). The rule (owner, 26 Oct 2026): right after the 3rd sent chat message (any chat) or right after joining a plan,
// whichever comes first; once per 60 days per person; never in a session's first minute; never for the Play reviewer, demo or
// test accounts; never on top of a modal or the keyboard. Store policy: only the official sheet, no gating, no reward.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMPTY, MESSAGES_TO_ASK, COOLDOWN_DAYS, SESSION_GRACE_MS, CLAIM_RETRY_MS, NEW_SESSION_AFTER_MS,
  parseState, noteSent, noteJoined, earned, decide, excludedAccount, sessionStartAfterResume,
} from '../../src/lib/review-policy.ts';
import { createReviewTrigger, PENDING_MS, SETTLE_MS } from '../../src/lib/review-trigger.ts';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 26, 6, 0, 0);
const ctx = (over = {}) => ({ now: T0 + 5 * 60_000, sessionStart: T0, supported: true, impersonating: false, account: true, active: true, keyboard: false, overlay: false, ...over });
const earnedState = { ...EMPTY, sent: MESSAGES_TO_ASK };

describe('review-policy', () => {
  test('the 3rd sent message earns the ask, the 1st and 2nd do not; a plan join earns it on its own', () => {
    let s = EMPTY;
    s = noteSent(s); assert.equal(earned(s), false);
    s = noteSent(s); assert.equal(earned(s), false);
    s = noteSent(s); assert.equal(earned(s), true);
    assert.equal(noteSent(s), s, 'counting stops at 3: nothing more to save');
    assert.equal(earned(noteJoined(EMPTY)), true);
    assert.equal(noteJoined(noteJoined(EMPTY)).joined, true);
  });

  test('decide: every reason, in order', () => {
    assert.deepEqual(decide(earnedState, ctx()), { ok: true });
    assert.deepEqual(decide(earnedState, ctx({ supported: false })), { ok: false, why: 'unsupported', wait: false });
    assert.deepEqual(decide(earnedState, ctx({ impersonating: true })), { ok: false, why: 'impersonating', wait: false });
    assert.deepEqual(decide(earnedState, ctx({ account: false })), { ok: false, why: 'excluded', wait: false });
    assert.deepEqual(decide({ ...earnedState, excluded: true }, ctx()), { ok: false, why: 'excluded', wait: false });
    assert.deepEqual(decide({ ...EMPTY, sent: 2 }, ctx()), { ok: false, why: 'not_earned', wait: false });
    assert.deepEqual(decide(earnedState, ctx({ now: T0 + 30_000 })), { ok: false, why: 'session_minute', wait: false });
    assert.deepEqual(decide(earnedState, ctx({ keyboard: true })), { ok: false, why: 'keyboard', wait: true });
    assert.deepEqual(decide(earnedState, ctx({ overlay: true })), { ok: false, why: 'overlay', wait: true });
    assert.deepEqual(decide(earnedState, ctx({ active: false })), { ok: false, why: 'background', wait: true });
  });

  test('never in the first minute of a session; from the 60th second on, yes', () => {
    assert.equal(decide(earnedState, ctx({ now: T0 + SESSION_GRACE_MS - 1 })).why, 'session_minute');
    assert.deepEqual(decide(earnedState, ctx({ now: T0 + SESSION_GRACE_MS })), { ok: true });
  });

  test('60 days between asks, counted from this device\'s ask or the server\'s next date; a clock set back stays quiet', () => {
    const asked = { ...earnedState, askedAt: T0 };
    assert.equal(decide(asked, ctx({ now: T0 + (COOLDOWN_DAYS - 1) * DAY, sessionStart: T0 })).why, 'cooldown');
    assert.deepEqual(decide(asked, ctx({ now: T0 + COOLDOWN_DAYS * DAY, sessionStart: T0 })), { ok: true });
    assert.equal(decide(asked, ctx({ now: T0 - DAY, sessionStart: T0 - 2 * DAY })).why, 'cooldown');
    const told = { ...earnedState, nextAt: T0 + 10 * DAY };
    assert.equal(decide(told, ctx({ now: T0 + 9 * DAY, sessionStart: T0 })).why, 'cooldown');
    assert.deepEqual(decide(told, ctx({ now: T0 + 10 * DAY, sessionStart: T0 })), { ok: true });
  });

  test('after the server said no (or could not be reached), it is asked again only after 10 minutes', () => {
    const s = { ...earnedState, claimAt: T0 + 5 * 60_000 };
    assert.equal(decide(s, ctx({ now: T0 + 5 * 60_000 + CLAIM_RETRY_MS - 1 })).why, 'claim_wait');
    assert.deepEqual(decide(s, ctx({ now: T0 + 5 * 60_000 + CLAIM_RETRY_MS })), { ok: true });
  });

  test('saved state that is missing, damaged or edited can only ask later, never sooner', () => {
    for (const raw of [null, undefined, '', 'not json', '[]', '"x"', '42', '{"sent":"3"}', '{"sent":-5}', '{"joined":"yes"}']) {
      const s = parseState(raw);
      assert.equal(earned(s), false, String(raw));
    }
    assert.equal(parseState('{"sent":99}').sent, MESSAGES_TO_ASK);
    assert.equal(parseState('{"sent":2.7}').sent, 2);
    const s = { sent: 3, joined: true, askedAt: T0, nextAt: T0 + DAY, excluded: true, claimAt: T0 };
    assert.deepEqual(parseState(JSON.stringify(s)), s);
  });

  test('accounts the app can tell are not real travellers are never asked', () => {
    for (const email of ['bot@demo.tablamigo', 'host@team.tablamigo', 'deleted-1@deleted.tablamigo', 'qa1@review.test', 'free1@qa.test', 'a@example.com', 'a@mail.example', 'x@y.invalid', 'a@localhost', 'no-at-sign', '', null])
      assert.equal(excludedAccount({ email, role: 'user' }), true, String(email));
    assert.equal(excludedAccount({ email: 'admin.person@example.com', role: 'admin' }), true, 'admins are the team');
    assert.equal(excludedAccount(null), true);
    for (const email of ['priya@gmail.com', 'Ravi.K@Outlook.com', 'a@testing.com', 'x@tablamigo-users.in'])
      assert.equal(excludedAccount({ email, role: 'user' }), false, email);
  });

  test('a session restarts after 30 minutes away, not after a quick switch to another app', () => {
    assert.equal(sessionStartAfterResume(T0, T0 + 1000, T0 + 1000 + NEW_SESSION_AFTER_MS - 1), T0);
    assert.equal(sessionStartAfterResume(T0, T0 + 1000, T0 + 1000 + NEW_SESSION_AFTER_MS), T0 + 1000 + NEW_SESSION_AFTER_MS);
    assert.equal(sessionStartAfterResume(T0, null, T0 + DAY), T0);
  });
});

/** A fake world: clock, storage, server, screen and the people signed in. */
function world(over = {}) {
  const w = {
    now: T0, sessionStart: T0, me: { id: 'u1', email: 'priya@gmail.com', role: 'user' }, impersonating: false,
    screen: { active: true, keyboard: false, overlay: false }, supported: true,
    store: new Map(), claims: [], shows: [], logs: [], loadFails: false, saveFails: false,
    server: () => ({ ask: true, askedAt: new Date(w.now).toISOString() }),
    /** Things that happen at a given fake time (keyboard closing, a modal opening). */
    timeline: [],
    showFails: false,
    ...over,
  };
  const deps = {
    surface: 'android',
    supported: () => w.supported,
    load: async uid => { if (w.loadFails) throw new Error('keystore'); return w.store.get(uid) ?? null; },
    save: async (uid, raw) => { if (w.saveFails) throw new Error('keystore'); w.store.set(uid, raw); },
    claim: async (surface, trigger) => { w.claims.push({ surface, trigger, uid: w.me?.id, at: w.now }); return w.server(); },
    show: async trigger => { w.shows.push({ trigger, at: w.now, screen: { ...w.screen } }); if (w.showFails) throw new Error('quota'); },
    me: () => w.me,
    impersonating: () => w.impersonating,
    screen: () => w.screen,
    sessionStart: () => w.sessionStart,
    now: () => w.now,
    wait: async ms => { w.now += ms; for (const e of w.timeline) if (!e.done && w.now >= e.at) { e.done = true; e.run(w); } },
    log: line => w.logs.push(line),
    claimTimeoutMs: w.claimTimeoutMs,
  };
  w.trigger = createReviewTrigger(deps);
  w.state = (uid = 'u1') => parseState(w.store.get(uid));
  w.after = (ms, run) => w.timeline.push({ at: w.now + ms, run });
  return w;
}
const MINUTE = 60_000;

describe('review-trigger: the moments', () => {
  test('1st and 2nd sent message: nothing; 3rd: the server agrees and the store sheet is asked for, once', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    assert.equal(await w.trigger.messageSent(), 'not_earned');
    assert.equal(await w.trigger.messageSent(), 'not_earned');
    assert.equal(w.claims.length, 0);
    assert.equal(await w.trigger.messageSent(), 'asked');
    assert.deepEqual(w.claims.map(c => [c.surface, c.trigger]), [['android', 'messages']]);
    assert.equal(w.shows.length, 1);
    assert.ok(w.logs.some(l => l.includes('[review] asking (trigger=messages, surface=android)')));
    assert.equal(typeof w.state().askedAt, 'number');
    assert.equal(await w.trigger.messageSent(), 'cooldown', 'the 4th message asks nothing');
    assert.equal(w.claims.length, 1);
  });

  test('joining a plan asks on its own, after the chat it opens has settled for 2.5 s', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    const start = w.now;
    assert.equal(await w.trigger.planJoined(), 'asked');
    assert.deepEqual(w.claims.map(c => c.trigger), ['plan_join']);
    assert.ok(w.shows[0].at - start >= SETTLE_MS.plan_join, `asked after ${w.shows[0].at - start} ms`);
    assert.equal(w.state().joined, true);
  });

  test('whichever comes first: a join after 2 messages asks, and the 3rd message after that asks nothing', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    await w.trigger.messageSent(); await w.trigger.messageSent();
    assert.equal(await w.trigger.planJoined(), 'asked');
    assert.equal(await w.trigger.messageSent(), 'cooldown');
    assert.equal(w.shows.length, 1);
  });

  test('never in the first minute of a session: the 3rd message at 30 s asks nothing, the 4th at 70 s does', async () => {
    const w = world({ now: T0 + 10_000 });
    await w.trigger.messageSent(); await w.trigger.messageSent();
    w.now = T0 + 30_000;
    assert.equal(await w.trigger.messageSent(), 'session_minute');
    assert.equal(w.claims.length, 0);
    w.now = T0 + 70_000;
    assert.equal(await w.trigger.messageSent(), 'asked');
  });

  test('again after 60 days, not before', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    await w.trigger.planJoined();
    w.now += (COOLDOWN_DAYS - 1) * DAY; w.sessionStart = w.now - 5 * MINUTE;
    assert.equal(await w.trigger.messageSent(), 'cooldown');
    w.now += DAY;
    assert.equal(await w.trigger.messageSent(), 'asked');
    assert.equal(w.shows.length, 2);
  });
});

describe('review-trigger: the screen', () => {
  test('keyboard up after sending: waits, and asks only once it has been down for a moment', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    w.screen.keyboard = true;
    await w.trigger.messageSent(); await w.trigger.messageSent();
    w.after(5000, x => { x.screen.keyboard = false; });
    assert.equal(await w.trigger.messageSent(), 'asked');
    assert.equal(w.shows[0].screen.keyboard, false);
    assert.ok(w.shows[0].at >= T0 + 5 * MINUTE + 5000 + SETTLE_MS.messages);
  });

  test('a keyboard that never goes down within 2 minutes: no ask and no server call; the next message tries again', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    w.screen.keyboard = true;
    await w.trigger.messageSent(); await w.trigger.messageSent();
    assert.equal(await w.trigger.messageSent(), 'screen_busy');
    assert.ok(w.now - (T0 + 5 * MINUTE) >= PENDING_MS);
    assert.equal(w.claims.length, 0);
    w.screen.keyboard = false;
    assert.equal(await w.trigger.messageSent(), 'asked');
  });

  test('a modal or sheet open: waits until it closes; the app in the background: waits until it is back', async () => {
    const w = world({ now: T0 + 5 * MINUTE, screen: { active: true, keyboard: false, overlay: true } });
    w.after(3000, x => { x.screen.overlay = false; x.screen.active = false; });
    w.after(9000, x => { x.screen.active = true; });
    assert.equal(await w.trigger.planJoined(), 'asked');
    assert.deepEqual(w.shows[0].screen, { active: true, keyboard: false, overlay: false });
  });

  test('a sheet that opens while the server is answering: the sheet is not covered; the ask is counted and not repeated', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    w.server = () => { w.screen.overlay = true; return { ask: true }; };
    assert.equal(await w.trigger.planJoined(), 'screen_busy_after_claim');
    assert.equal(w.shows.length, 0);
    w.screen.overlay = false;
    assert.equal(await w.trigger.messageSent(), 'cooldown');
  });
});

describe('review-trigger: who', () => {
  test('demo, test, admin and reviewer accounts: never a server call, never a sheet', async () => {
    for (const me of [{ id: 'd', email: 'x@demo.tablamigo' }, { id: 'q', email: 'free1@qa.test' }, { id: 'a', email: 'j@gmail.com', role: 'admin' }]) {
      const w = world({ now: T0 + 5 * MINUTE, me });
      assert.equal(await w.trigger.planJoined(), 'excluded');
      assert.equal(w.claims.length + w.shows.length, 0);
    }
    // The Play reviewer's login looks like anyone's; only the server knows it, and its no is remembered.
    const w = world({ now: T0 + 5 * MINUTE, server: () => ({ ask: false, reason: 'excluded' }) });
    assert.equal(await w.trigger.planJoined(), 'server_excluded');
    w.now += DAY;
    assert.equal(await w.trigger.messageSent(), 'excluded');
    assert.equal(w.claims.length, 1);
    assert.equal(w.shows.length, 0);
  });

  test('the server switched off (REVIEW_ASK, reason "disabled"): no sheet, one call per 10 minutes at most, works again once on', async () => {
    const w = world({ now: T0 + 5 * MINUTE, server: () => ({ ask: false, reason: 'disabled' }) });
    assert.equal(await w.trigger.planJoined(), 'server_disabled');
    for (let i = 0; i < 20; i++) assert.equal(await w.trigger.messageSent(), 'claim_wait');
    assert.equal(w.claims.length, 1);
    w.now += 10 * MINUTE;
    assert.equal(await w.trigger.messageSent(), 'server_disabled');
    assert.equal(w.claims.length, 2);
    assert.equal(w.shows.length, 0);
    // Never remembered as an excluded account: switching it on reaches this device with no app update.
    w.server = () => ({ ask: true, askedAt: new Date(w.now).toISOString() });
    w.now += 10 * MINUTE;
    assert.equal(await w.trigger.messageSent(), 'asked');
    assert.equal(w.shows.length, 1);
  });

  test('an admin looking through the account (impersonation): nothing', async () => {
    const w = world({ now: T0 + 5 * MINUTE, impersonating: true });
    assert.equal(await w.trigger.planJoined(), 'impersonating');
    assert.equal(w.claims.length, 0);
  });

  test('signed out: nothing, and nothing saved', async () => {
    const w = world({ now: T0 + 5 * MINUTE, me: null });
    assert.equal(await w.trigger.messageSent(), 'signed_out');
    assert.equal(w.store.size, 0);
  });

  test('a device with no store sheet (no Play Store, a TestFlight build): nothing', async () => {
    const w = world({ now: T0 + 5 * MINUTE, supported: false });
    assert.equal(await w.trigger.planJoined(), 'unsupported');
    assert.equal(w.claims.length, 0);
  });
});

describe('review-trigger: trying to break it', () => {
  test('rapid sends: ten at once after the 2nd message make one server call and one sheet', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    await w.trigger.messageSent(); await w.trigger.messageSent();
    const rs = await Promise.all(Array.from({ length: 10 }, () => w.trigger.messageSent()));
    assert.equal(rs.filter(r => r === 'asked').length, 1, rs.join(','));
    assert.equal(w.claims.length, 1);
    assert.equal(w.shows.length, 1);
    assert.equal(w.state().sent, MESSAGES_TO_ASK);
  });

  test('offline: no sheet, no error; the server is asked again only 10 minutes later', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    w.server = () => { throw new TypeError('Network request failed'); };
    assert.equal(await w.trigger.planJoined(), 'offline');
    assert.equal(w.shows.length, 0);
    w.now += 2 * MINUTE;
    assert.equal(await w.trigger.messageSent(), 'claim_wait');
    assert.equal(w.claims.length, 1);
    w.server = () => ({ ask: true });
    w.now += CLAIM_RETRY_MS;
    assert.equal(await w.trigger.messageSent(), 'asked');
  });

  test('a server call that hangs (half-open connection) is given up after the timeout, like offline, and later moments still count', async () => {
    const w = world({ now: T0 + 5 * MINUTE, claimTimeoutMs: 50 });
    w.server = () => new Promise(() => {});
    assert.equal(await w.trigger.planJoined(), 'offline');
    assert.equal(w.shows.length, 0);
    w.server = () => ({ ask: true });
    assert.equal(await w.trigger.messageSent(), 'claim_wait');
    assert.equal(w.state().sent, 1, 'the message after the hang was counted');
    w.now += CLAIM_RETRY_MS;
    assert.equal(await w.trigger.messageSent(), 'asked');
  });

  test('the account changes in the moment before the server call: no call is made for the new account', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    // supported() is read once to decide and once more just before the claim: the switch lands in between.
    let reads = 0;
    Object.defineProperty(w, 'supported', { get() { if (++reads === 2) w.me = { id: 'u9', email: 'other@gmail.com', role: 'user' }; return true; } });
    const r = await w.trigger.planJoined();
    assert.equal(r, 'screen_busy');
    assert.equal(w.claims.length, 0);
  });

  test('account switch: each person counts from their own messages; a wait for one never asks the other', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    await w.trigger.messageSent(); await w.trigger.messageSent();   // Priya: 2
    w.me = { id: 'u2', email: 'ravi@gmail.com', role: 'user' };
    assert.equal(await w.trigger.messageSent(), 'not_earned');      // Ravi: 1, not Priya's 3rd
    assert.equal(w.state('u1').sent, 2);
    assert.equal(w.state('u2').sent, 1);
    // Ravi earns it with the keyboard up, then signs out and Priya signs back in before it goes down.
    w.screen.keyboard = true;
    await w.trigger.messageSent();
    const p = w.trigger.messageSent();
    w.after(1000, x => { x.me = { id: 'u1', email: 'priya@gmail.com', role: 'user' }; x.screen.keyboard = false; });
    assert.equal(await p, 'screen_busy');
    assert.equal(w.claims.length, 0);
    assert.equal(w.state('u1').askedAt, null);
  });

  test('reinstall (a new install, nothing stored): the server still remembers the ask, so no second sheet within 60 days', async () => {
    const w = world({ now: T0 + 5 * MINUTE });
    await w.trigger.planJoined();
    const next = new Date(T0 + 5 * MINUTE + COOLDOWN_DAYS * DAY).toISOString();
    const fresh = world({ now: w.now + DAY, sessionStart: w.now + DAY - 5 * MINUTE, server: () => ({ ask: false, reason: 'cooldown', nextAt: next }) });
    await fresh.trigger.messageSent(); await fresh.trigger.messageSent();
    assert.equal(await fresh.trigger.messageSent(), 'server_cooldown');
    assert.equal(w.shows.length + fresh.shows.length, 1);
    assert.equal(fresh.state().nextAt, Date.parse(next));
    fresh.now += CLAIM_RETRY_MS + DAY;
    assert.equal(await fresh.trigger.messageSent(), 'cooldown', 'remembered without asking the server again');
    assert.equal(fresh.claims.length, 1);
  });

  test('a broken keystore: still asks, once per run from memory, and the server covers the next run', async () => {
    const w = world({ now: T0 + 5 * MINUTE, saveFails: true, loadFails: true });
    assert.equal(await w.trigger.planJoined(), 'asked');
    w.now += CLAIM_RETRY_MS;
    assert.equal(await w.trigger.planJoined(), 'cooldown');
    // The app restarts with the keystore still broken: nothing local, but the server remembers.
    const again = world({ now: w.now, sessionStart: w.now - 5 * MINUTE, saveFails: true, loadFails: true, server: () => ({ ask: false, reason: 'cooldown' }) });
    assert.equal(await again.trigger.planJoined(), 'server_cooldown');
    assert.equal(w.shows.length + again.shows.length, 1);
  });

  test('Google refusing or failing to show its sheet is silent', async () => {
    const w = world({ now: T0 + 5 * MINUTE, showFails: true });
    assert.equal(await w.trigger.planJoined(), 'asked');
  });
});

describe('lib/review-prompt.ts on a phone (store sheet, SecureStore, Keyboard and AppState stubbed)', () => {
  test('the 3rd message calls expo-store-review requestReview once, and logs it', async () => {
    const { reviewTrigger } = await import('../../src/lib/review-prompt.ts');   // the session starts now
    const realNow = Date.now;
    const skew = SESSION_GRACE_MS + 5000;
    Date.now = () => realNow() + skew;   // past the session's first minute without waiting for it
    const { Keyboard, AppState } = await import('react-native');
    const review = await import('expo-store-review');
    const { store } = await import('expo-secure-store');
    const { queryClient } = await import('../../src/lib/query.ts');
    const API = process.env.EXPO_PUBLIC_API_URL;
    const posts = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      posts.push({ path: url.slice(API.length), method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      return new Response(JSON.stringify({ ask: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const lines = [];
    const realLog = console.log;
    console.log = (...a) => { lines.push(a.join(' ')); };
    try {
      queryClient.setQueryData(['me'], { id: 'phone-user', email: 'priya@gmail.com', role: 'user' });
      Keyboard.visible = false; AppState.currentState = 'active';
      assert.equal(await reviewTrigger.messageSent(), 'not_earned');
      assert.equal(await reviewTrigger.messageSent(), 'not_earned');
      assert.equal(await reviewTrigger.messageSent(), 'asked');
      assert.equal(review.calls.requestReview, 1);
      assert.deepEqual(posts.map(p => [p.method ?? 'POST', p.path, p.body]), [['POST', '/me/review-ask', { surface: 'android', trigger: 'messages' }]]);
      assert.ok(lines.some(l => l === '[review] requestReview called (trigger=messages)'), lines.join('\n'));
      assert.equal(typeof JSON.parse(store.get('tablamigo.review.v2.phone-user')).askedAt, 'number');
      assert.equal(await reviewTrigger.messageSent(), 'cooldown');
      assert.equal(review.calls.requestReview, 1);

      // Keyboard up (Keyboard.isVisible), then a modal screen (the paywall route): the sheet waits for both to clear.
      const { setModalRoute } = await import('../../src/lib/overlay.ts');
      queryClient.setQueryData(['me'], { id: 'phone-user-2', email: 'ravi@gmail.com', role: 'user' });
      Keyboard.visible = true;
      await reviewTrigger.messageSent(); await reviewTrigger.messageSent();
      const pending = reviewTrigger.messageSent();
      await new Promise(r => setTimeout(r, 1200));
      assert.equal(review.calls.requestReview, 1, 'asked with the keyboard up');
      Keyboard.visible = false; setModalRoute('/paywall');
      await new Promise(r => setTimeout(r, 1200));
      assert.equal(review.calls.requestReview, 1, 'asked over the paywall');
      setModalRoute('/chat/abc');
      assert.equal(await pending, 'asked');
      assert.equal(review.calls.requestReview, 2);
      // Google not showing its sheet (quota, no Play Store) is silent.
      review.state.fail = true;
      queryClient.setQueryData(['me'], { id: 'phone-user-3', email: 'cy@gmail.com', role: 'user' });
      await reviewTrigger.messageSent(); await reviewTrigger.messageSent();
      assert.equal(await reviewTrigger.messageSent(), 'asked');
      assert.ok(lines.some(l => l.startsWith('[review] requestReview not shown')), lines.join('\n'));
    } finally {
      Date.now = realNow; globalThis.fetch = realFetch; console.log = realLog;
    }
  });
});
