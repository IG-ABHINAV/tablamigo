// City search (src/lib/places.ts), used by "pick a city" and a new trip. Fixtures are Photon's real answers (22 Oct 2026).
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityQueryUrl, parseCities, cityWhere } from '../src/lib/places.ts';

const f = (name, cc, country, state, lng, lat, osm = 'city') => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: { name, countrycode: cc, country, state, osm_value: osm } });
const AGRA = { features: [f('Agra', 'IN', 'India', 'Uttar Pradesh', 78.008, 27.176), f('Agra', 'US', 'United States', 'Oklahoma', -96.86, 35.89, 'town'),
  f('Agrate Brianza', 'IT', 'Italy', 'Lombardy', 9.35, 45.57, 'town')] };
const PARIS = { features: [f('Paris', 'FR', 'France', 'Île-de-France', 2.35, 48.86), f('Paris', 'US', 'United States', 'Texas', -95.55, 33.66, 'town')] };

test("'Agra' from India is Agra, India, and the two Agras read differently", () => {
  const r = parseCities(AGRA);
  assert.deepEqual([r[0].city, r[0].cc], ['Agra', 'IN']);
  assert.equal(cityWhere(r[0]), 'Uttar Pradesh, India');
  assert.equal(cityWhere(r[1]), 'Oklahoma, United States');
});

test("Photon's order is kept: an American typing Paris gets Paris, France first", () => {
  assert.equal(parseCities(PARIS)[0].cc, 'FR');
});

test('the search leans towards the person when there is a point, and only searches cities and towns', () => {
  const u = new URL(cityQueryUrl('Agra', { lat: 32.27, lng: 75.65 }, 6));
  assert.equal(u.searchParams.get('lat'), '32.27');
  assert.equal(u.searchParams.get('lon'), '75.65');
  assert.deepEqual(u.searchParams.getAll('osm_tag'), ['place:city', 'place:town']);
  assert.equal(u.searchParams.get('limit'), '6');
  assert.equal(new URL(cityQueryUrl('Agra', null)).searchParams.get('lat'), null);
});

test('duplicates and nameless or countryless hits are dropped', () => {
  const r = parseCities({ features: [...AGRA.features, AGRA.features[0], { properties: { name: 'X' } }, { properties: { countrycode: 'IN' } }] });
  assert.equal(r.length, 3);
});
