// Explore's live counts (src/lib/social-proof.ts): only a city the API published (10+ upcoming trips from real travellers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveCity, liveLine } from '../../src/lib/social-proof.ts';

const P = { minTrips: 10, cities: [{ cityKey: 'goa-in', city: 'Goa', countryCode: 'IN', upcomingTrips: 14, plansThisWeek: 3 }, { cityKey: 'sao-paulo-br', city: 'São Paulo', countryCode: 'BR', upcomingTrips: 10, plansThisWeek: 0 }], trending: [] };

test("the person's city, case and accents aside", () => {
  assert.equal(liveCity(P, 'goa')?.cityKey, 'goa-in');
  assert.equal(liveCity(P, ' Sao Paulo ')?.cityKey, 'sao-paulo-br');
});

test('nothing for a city not in the answer, no city, no answer, or a count under the threshold', () => {
  assert.equal(liveCity(P, 'Manali'), null);
  assert.equal(liveCity(P, null), null);
  assert.equal(liveCity(undefined, 'Goa'), null);
  assert.equal(liveCity({ minTrips: 10, cities: [{ ...P.cities[0], upcomingTrips: 9 }], trending: [] }, 'Goa'), null);
});

test('the line leaves a zero out', () => {
  assert.equal(liveLine(P.cities[0]), '14 upcoming trips · 3 plans this week');
  assert.equal(liveLine(P.cities[1]), '10 upcoming trips');
  assert.equal(liveLine({ ...P.cities[0], plansThisWeek: 1 }), '14 upcoming trips · 1 plan this week');
});
