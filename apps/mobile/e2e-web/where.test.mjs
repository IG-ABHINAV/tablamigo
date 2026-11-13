// Which place the screens use without a location fix (src/lib/where.ts). The app used to show a fixed Bangkok point to anyone
// without a fix: people in Istanbul, Sydney and Casablanca saw only Bangkok plans, then deleted their accounts.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pickHere, isRealPlace, COUNTRY_CITIES } from '../src/lib/where.ts';

const IST = { lat: 41.0082, lng: 28.9784 };

test('the order is a picked city, the phone, the saved place, then the home country', () => {
  const picked = { lat: 38.72, lng: -9.14, city: 'Lisbon' };
  const saved = { lat: 41.01, lng: 28.97, city: 'Istanbul' };
  assert.equal(pickHere({ picked, device: IST, saved, homeCountry: 'AU', settled: true }).source, 'picked');
  assert.deepEqual(pickHere({ device: IST, deviceCity: 'Istanbul', saved, homeCountry: 'AU', settled: true }), { ...IST, source: 'device', city: 'Istanbul' });
  assert.deepEqual(pickHere({ device: null, saved, homeCountry: 'AU', settled: true }), { lat: 41.01, lng: 28.97, source: 'saved', city: 'Istanbul' });
  assert.deepEqual(pickHere({ device: null, saved: { lat: null, lng: null, city: null }, homeCountry: 'au', settled: true }),
    { lat: COUNTRY_CITIES.AU.lat, lng: COUNTRY_CITIES.AU.lng, source: 'country', city: 'Sydney' });
});

test('with nothing to go on there is no place (the screen asks), never Bangkok', () => {
  assert.equal(pickHere({ device: null, saved: null, homeCountry: null, settled: true }), null);
  assert.equal(pickHere({ device: null, saved: null, homeCountry: 'ZZ', settled: true }), null);
  // Until the phone answers the home-country guess waits, so a slow GPS doesn't flash another city first.
  assert.equal(pickHere({ device: null, saved: null, homeCountry: 'TR', settled: false }), null);
  for (const cc of ['TR', 'AU', 'ES', 'MA', 'IN', 'US', 'GB'])
    assert.notEqual(pickHere({ device: null, saved: null, homeCountry: cc, settled: true })?.city, 'Bangkok', cc);
});

test('"the chat where I am" is only offered for the phone\'s fix or the saved place', () => {
  assert.equal(isRealPlace(pickHere({ device: IST, settled: true })), true);
  assert.equal(isRealPlace(pickHere({ saved: { ...IST, city: 'Istanbul' }, settled: true })), true);
  assert.equal(isRealPlace(pickHere({ homeCountry: 'TR', settled: true })), false);
  assert.equal(isRealPlace(pickHere({ picked: { ...IST, city: 'Istanbul' }, settled: true })), false);
  assert.equal(isRealPlace(null), false);
});

test('every home-country city is a real coordinate', () => {
  for (const [cc, c] of Object.entries(COUNTRY_CITIES)) {
    assert.match(cc, /^[A-Z]{2}$/);
    assert.ok(Math.abs(c.lat) <= 90 && Math.abs(c.lng) <= 180 && c.city, cc);
  }
});

test('no screen falls back to the old Bangkok point any more', () => {
  const src = new URL('../src/', import.meta.url).pathname;
  const files = fs.readdirSync(src, { recursive: true }).filter(f => /\.(ts|tsx)$/.test(f));
  const hits = files.filter(f => /13\.7466|100\.5346|\bFALLBACK\b/.test(fs.readFileSync(path.join(src, f), 'utf8')));
  assert.deepEqual(hits, []);
});
