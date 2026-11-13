// 12 Nov 2026: with no plan within 50 km (19 of 22 new people, 2-12 Nov), Explore offers a one-tap prefilled plan for the
// person's city, the nearest cities that have plans with their distance, and "Notify me when someone near me posts".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { suggestedPlan, createInCityLabel, cityLine } from '../../src/lib/empty-nearby.ts';

test('the prefilled plan fits the time of day and names the city', () => {
  assert.deepEqual(suggestedPlan('Satara', 8), { title: 'Morning coffee in Satara', emoji: '☕', category: 'food' });
  assert.equal(suggestedPlan('Satara', 13).title, 'Lunch together in Satara');
  assert.equal(suggestedPlan('Satara', 16).title, 'Sunset walk in Satara');
  assert.equal(suggestedPlan('Satara', 20).title, 'Grab dinner in Satara');
  assert.equal(suggestedPlan(null, 20).title, 'Grab dinner');
  // The API takes titles up to 80 characters: a very long place name falls back to the plain idea.
  assert.equal(suggestedPlan('X'.repeat(90), 20).title, 'Grab dinner');
});

test('button and city lines', () => {
  assert.equal(createInCityLabel('Satara'), 'Create a plan in Satara');
  assert.equal(createInCityLabel(null), 'Create a plan here');
  assert.equal(cityLine({ city: 'Goa', distanceKm: 480, plans: 3, activityId: 'a' }), 'Goa · 480 km · 3 plans');
  assert.equal(cityLine({ city: 'Bangkok', distanceKm: 2240, plans: 1, activityId: 'a' }), 'Bangkok · 2,240 km · 1 plan');
  assert.equal(cityLine({ city: 'Panaji', distanceKm: 0, plans: 2, activityId: 'a' }), 'Panaji · 1 km · 2 plans');
});

test('Explore passes the API fields to the empty state, which shows all three parts only past 50 km', () => {
  const explore = fs.readFileSync(new URL('../../src/app/(tabs)/index.tsx', import.meta.url), 'utf8');
  assert.match(explore, /nearestCities=\{acts\.data\?\.nearestCities\}/);
  assert.match(explore, /nearbyAlerts=\{acts\.data\?\.nearbyAlerts\}/);
  const starter = fs.readFileSync(new URL('../../src/components/MapStarter.tsx', import.meta.url), 'utf8');
  assert.match(starter, /const empty50 = !!nearestCities/);
  assert.match(starter, /createInCityLabel\(city\)/);
  assert.match(starter, /Notify me when someone near me posts/);
  assert.match(starter, /nearbyPlanAlerts: on/);
  assert.match(starter, /testID="nearest-cities"/);
});
