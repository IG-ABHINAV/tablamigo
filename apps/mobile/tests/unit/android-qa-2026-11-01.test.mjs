// Fixes from the Android pre-release QA pass of 1 Nov 2026 (emulator, QA build of main against a local API), one test per
// finding. Only the plain-TypeScript halves are here; the screens that use them were re-checked on the emulator.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planTitleAfterVerb } from '../../src/lib/plan-title.ts';
import { chatPreview } from '../../src/lib/chat-preview.ts';
import { birthdateHint } from '../../src/lib/birthdate.ts';
import { sheetSnaps, sheetHiddenBelow, SHEET_FULL } from '../../src/lib/sheet-snaps.ts';
import { adsNoticeCopy, ADS_NOTICE, ADS_NOTICE_NEW } from '../../src/lib/ads-notice.ts';

test('plan cards: "<host> wants to <title>" lowers an ordinary first word, never an acronym ("qA noodle night")', () => {
  assert.equal(planTitleAfterVerb('Grab street food'), 'grab street food');
  assert.equal(planTitleAfterVerb('Sunset drinks at Octave Rooftop'), 'sunset drinks at Octave Rooftop');
  assert.equal(planTitleAfterVerb('QA noodle night'), 'QA noodle night');
  assert.equal(planTitleAfterVerb('BBQ on the beach'), 'BBQ on the beach');
  assert.equal(planTitleAfterVerb('iPhone photo walk'), 'iPhone photo walk');
  assert.equal(planTitleAfterVerb('F1 watch party'), 'F1 watch party');
  assert.equal(planTitleAfterVerb('already lower'), 'already lower');
  assert.equal(planTitleAfterVerb('🍜 Noodles'), '🍜 Noodles');
  assert.equal(planTitleAfterVerb(''), '');
});

test('chat list: "You:" for my own last message, the sender\'s name for others, media named, empty chats not "2 members"', () => {
  assert.equal(chatPreview({ kind: 'dm', lastMessage: { body: 'hi', kind: 'text', senderName: 'Neha', mine: true } }), 'You: hi');
  assert.equal(chatPreview({ kind: 'activity', lastMessage: { body: 'see you', kind: 'text', senderName: 'Hana', mine: false } }), 'Hana: see you');
  assert.equal(chatPreview({ kind: 'dm', lastMessage: { body: 'https://x/v.m4a', kind: 'voice', senderName: 'Hana' } }), 'Hana: 🎤 Voice note');
  assert.equal(chatPreview({ kind: 'dm', lastMessage: { body: 'https://x/p.jpg', kind: 'image', mine: true } }), 'You: 📷 Photo');
  assert.equal(chatPreview({ kind: 'activity', lastMessage: { body: '📊 Where?', kind: 'poll', senderName: 'Rahul' } }), 'Rahul: 📊 Where?');
  assert.equal(chatPreview({ kind: 'activity', lastMessage: { body: 'Neha joined', kind: 'system' } }), 'Neha joined');
  assert.equal(chatPreview({ kind: 'dm', memberCount: 2, lastMessage: null }), 'No messages yet. Say hi 👋');
  assert.equal(chatPreview({ kind: 'trip', memberCount: 1, lastMessage: null }), '1 member');
  assert.equal(chatPreview({ kind: 'city', memberCount: 12 }), '12 members');
  // A message whose sender is hidden (blocked or deleted) has no name: just the words.
  assert.equal(chatPreview({ kind: 'city', lastMessage: { body: 'hello', kind: 'text', senderName: null } }), 'hello');
});

test('birthday step: a whole date under 18 or 100+ says why Continue stays off', () => {
  const today = new Date(2026, 10, 1);
  assert.equal(birthdateHint({ d: '01', m: '01', y: '2010' }, today), 'You must be 18 or older to use Tablamigo.');
  assert.equal(birthdateHint({ d: '2', m: '11', y: '2008' }, today), 'You must be 18 or older to use Tablamigo.');
  assert.equal(birthdateHint({ d: '01', m: '11', y: '2008' }, today), '');                                 // 18 today
  assert.equal(birthdateHint({ d: '01', m: '01', y: '2030' }, today), 'You must be 18 or older to use Tablamigo.'); // not born yet
  assert.equal(birthdateHint({ d: '01', m: '01', y: '1920' }, today), 'Check the year.');
  assert.equal(birthdateHint({ d: '06', m: '05', y: '1994' }, today), '');
  assert.equal(birthdateHint({ d: '01', m: '01', y: '201' }, today), '');                                    // still typing
});

test('Explore sheet: snaps and list padding follow the window height given, not one read at start', () => {
  assert.deepEqual(sheetSnaps(914, { peek: 150 }), [764, 457, 914 * (1 - SHEET_FULL)]);
  const small = sheetSnaps(640, { peek: 150 });
  assert.deepEqual(small, [490, 320, 640 * (1 - SHEET_FULL)]);
  assert.ok(small[0] < 640 && small[2] < small[1] && small[1] < small[0]);
  assert.equal(sheetHiddenBelow(914), 128);
  assert.equal(sheetHiddenBelow(640), 90);
});

test('ads notice: plain wording for a new account, "a small change" only for accounts that were here before', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  assert.equal(adsNoticeCopy('2026-11-01T09:55:00Z', now), ADS_NOTICE_NEW);
  assert.equal(adsNoticeCopy('2026-10-01T09:55:00Z', now), ADS_NOTICE);
  assert.equal(adsNoticeCopy(undefined, now), ADS_NOTICE_NEW);
  assert.doesNotMatch(ADS_NOTICE_NEW.title + ADS_NOTICE_NEW.body, /change|now see/i);
  // Same promise either way: where the ad is, none with Plus, and the privacy line.
  for (const n of [ADS_NOTICE, ADS_NOTICE_NEW]) { assert.match(n.body, /Explore/); assert.match(n.body, /Plus/); assert.match(n.privacy, /Privacy Policy/); }
});
