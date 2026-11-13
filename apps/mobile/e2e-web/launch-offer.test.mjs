// Unit tests for the launch offer rules and wording (src/lib/launch-offer.ts), run with node's own test runner:
//   npm run test:unit        (node --no-warnings --test e2e-web/launch-offer.test.mjs)
// The module is plain TypeScript with no React in it, which node loads directly. The same two states, offer on and offer
// off, are driven through the real screens by the launchOffer scenario in drive.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NO_OFFER, readLaunchOffer, offerDate, offerHeadline, offerShort, plusIsFromOffer } from '../src/lib/launch-offer.ts';

const UNTIL = '2026-12-31T23:59:59Z';

test('offer off: an API that does not know the field, or says anything but active: true', () => {
  for (const body of [undefined, null, 0, 'x', [], {}, { launchOffer: null }, { launchOffer: 'yes' }, { launchOffer: {} },
    { launchOffer: { active: false, until: UNTIL } }, { launchOffer: { active: 'true', until: UNTIL } }, { launchOffer: { active: 1, until: UNTIL } },
    { launchOffer: { until: UNTIL } }]) {
    assert.deepEqual(readLaunchOffer(body), NO_OFFER, JSON.stringify(body));
  }
  assert.equal(NO_OFFER.active, false);
});

test('offer on: active true, with the end date when it is a real date', () => {
  assert.deepEqual(readLaunchOffer({ launchOffer: { active: true, until: UNTIL } }), { active: true, until: UNTIL });
  assert.deepEqual(readLaunchOffer({ launchOffer: { active: true, until: '2026-12-31' } }), { active: true, until: '2026-12-31' });
  assert.deepEqual(readLaunchOffer({ launchOffer: { active: true, until: Date.parse(UNTIL) } }), { active: true, until: new Date(UNTIL).toISOString() });
  // active but no usable date: still on, and the wording leaves the date out instead of printing "Invalid Date"
  for (const until of [undefined, null, '', 'soon', 'not a date', {}, NaN]) assert.deepEqual(readLaunchOffer({ launchOffer: { active: true, until } }), { active: true, until: null }, String(until));
});

test('the end date is the calendar date in the offer, in every time zone', () => {
  for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
    process.env.TZ = tz;
    assert.equal(offerDate(UNTIL, 'en-GB'), '31 Dec 2026', tz);
    assert.equal(offerDate('2026-12-31', 'en-GB'), '31 Dec 2026', tz);
    assert.equal(offerDate('2026-12-31T23:59:59+05:30', 'en-GB'), '31 Dec 2026', tz);
  }
  assert.equal(offerDate(UNTIL, 'en-US'), 'Dec 31, 2026');
  assert.equal(offerDate(null), null);
  assert.equal(offerDate('nonsense'), null);
});

test('the paywall headline and the profile line, with and without a date', () => {
  const on = { active: true, until: UNTIL };
  assert.equal(offerHeadline(on, 'en-GB'), 'Launch offer: Plus is free for everyone until 31 Dec 2026');
  assert.equal(offerShort(on, 'en-GB'), 'Plus is free until 31 Dec 2026');
  const undated = { active: true, until: null };
  assert.equal(offerHeadline(undated), 'Launch offer: Plus is free for everyone');
  assert.equal(offerShort(undated), 'Plus is free right now');
});

test('whose Plus is the offer\'s: everyone\'s while it runs, but not a paid subscriber who is paid up beyond it', () => {
  const on = { active: true, until: UNTIL };
  assert.equal(plusIsFromOffer(NO_OFFER, null), false);
  assert.equal(plusIsFromOffer(NO_OFFER, '2026-11-01T00:00:00Z'), false);       // offer off: nobody's Plus is the offer's
  assert.equal(plusIsFromOffer(on, null), true);                                // no end date: offer-only Plus
  assert.equal(plusIsFromOffer(on, undefined), true);
  assert.equal(plusIsFromOffer(on, 'garbage'), true);
  assert.equal(plusIsFromOffer(on, '2026-11-05T00:00:00Z'), true);              // a monthly renewal that falls inside the offer
  assert.equal(plusIsFromOffer(on, UNTIL), true);                               // ends with the offer
  assert.equal(plusIsFromOffer(on, '2027-03-01T00:00:00Z'), false);             // a yearly subscriber: their own date
  assert.equal(plusIsFromOffer({ active: true, until: null }, '2027-03-01T00:00:00Z'), false);
});
