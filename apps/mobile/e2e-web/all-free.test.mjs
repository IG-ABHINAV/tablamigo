// Unit tests for the everything-free switch the app reads from the API (src/lib/all-free.ts), with node's own test runner:
//   npm run test:unit
// The allFree scenario in drive.mjs drives the same switch through the real paywall, profile and invite screens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAllFree, ALL_FREE_HEADLINE, ALL_FREE_BODY, ALL_FREE_SHORT } from '../src/lib/all-free.ts';

test('only allFree: true means everything is free; an older API without the field means paid plans', () => {
  for (const body of [undefined, null, 0, 'x', [], {}, { allFree: false }, { allFree: 'true' }, { allFree: 1 }, { allFree: null }, { plus: true }]) {
    assert.equal(readAllFree(body), false, JSON.stringify(body));
  }
  assert.equal(readAllFree({ allFree: true }), true);
  assert.equal(readAllFree({ interests: [], allFree: true }), true);
});

test('the wording says free, with no prices, no Plus, no end date and no "forever"', () => {
  assert.equal(ALL_FREE_HEADLINE, 'Everything in Tablamigo is free right now');
  for (const s of [ALL_FREE_HEADLINE, ALL_FREE_BODY, ALL_FREE_SHORT]) {
    assert.doesNotMatch(s, /₹|\$|Plus|Trip Pass|until|forever|always free|launch offer/i, s);
  }
  assert.match(ALL_FREE_BODY, /no ads, nothing to buy/);
});
