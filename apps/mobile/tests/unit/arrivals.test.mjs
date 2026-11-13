// "Lands today" on a city page and the "You've landed" card on the map (src/lib/arrivals.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivalLabel, byArrival, landedTrip, daysBetween, localDay } from '../../src/lib/arrivals.ts';

const TODAY = '2026-11-02';

test('labels: here now, lands today, lands tomorrow, then the date', () => {
  assert.equal(arrivalLabel('2026-10-30', TODAY), 'Here now');
  assert.equal(arrivalLabel('2026-11-02', TODAY), 'Lands today');
  assert.equal(arrivalLabel('2026-11-03', TODAY), 'Lands tomorrow');
  assert.equal(arrivalLabel('2026-11-12', TODAY), 'Arrives 12 Nov');
  assert.equal(arrivalLabel('2027-01-05T00:00:00.000Z', TODAY), 'Arrives 5 Jan');   // the API's ISO date
  assert.equal(arrivalLabel(null, TODAY), null);
});

test('days between calendar dates, across a month and a year end', () => {
  assert.equal(daysBetween('2026-10-31', '2026-11-01'), 1);
  assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.equal(daysBetween('2026-11-02', '2026-11-02T18:30:00.000Z'), 0);
  assert.match(localDay(new Date(2026, 10, 2, 23, 59)), /^2026-11-02$/);
});

test('travellers already there or landing soonest come first', () => {
  const r = byArrival([{ id: 'c', tripStartDate: '2026-11-20' }, { id: 'a', tripStartDate: '2026-10-28' }, { id: 'x' }, { id: 'b', tripStartDate: '2026-11-02' }]);
  assert.deepEqual(r.map(p => p.id), ['a', 'b', 'c', 'x']);
});

const trip = (id, startDate, endDate, over = {}) => ({ id, city: 'Goa', countryCode: 'IN', cityKey: 'goa-in', startDate, endDate, ...over });

test('the landed card: a trip that started today or yesterday and has not ended', () => {
  assert.equal(landedTrip([trip('t', '2026-11-02', '2026-11-06')], TODAY)?.id, 't');
  assert.equal(landedTrip([trip('t', '2026-11-01', '2026-11-06')], TODAY)?.id, 't');
  assert.equal(landedTrip([trip('t', '2026-10-31', '2026-11-06')], TODAY), null);   // 2 days in: not "just landed"
  assert.equal(landedTrip([trip('t', '2026-11-03', '2026-11-06')], TODAY), null);   // tomorrow
  assert.equal(landedTrip([trip('t', '2026-11-01', '2026-11-01')], TODAY), null);   // already over
  assert.equal(landedTrip([trip('t', '2026-11-02T00:00:00.000Z', '2026-11-04T00:00:00.000Z')], TODAY)?.id, 't');
  assert.equal(landedTrip(null, TODAY), null);
});

test('the landed card: the latest start wins, and a closed card stays closed for that trip', () => {
  const trips = [trip('y', '2026-11-01', '2026-11-08'), trip('t', '2026-11-02', '2026-11-04', { city: 'Mapusa' })];
  assert.equal(landedTrip(trips, TODAY)?.id, 't');
  assert.equal(landedTrip(trips, TODAY, ['t'])?.id, 'y');
  assert.equal(landedTrip(trips, TODAY, ['t', 'y']), null);
});
