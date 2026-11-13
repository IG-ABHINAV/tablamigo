// Unit tests for the birthday step's own calendar check (src/lib/birthdate.ts), with node's own test runner:
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCalendarDate, ageOn, birthdateHint } from '../src/lib/birthdate.ts';

test('only dates that exist pass', () => {
  for (const s of ['1977-03-24', '2000-02-29', '1994-12-31']) assert.equal(isCalendarDate(s), true, s);
  for (const s of ['1977-24-03', '1977-02-30', '1977-00-10', '1977-13-01', '2001-02-29', '1977-3-24', '', 'yesterday']) assert.equal(isCalendarDate(s), false, s);
});

test('age counts full years and is 0 for a date that does not exist', () => {
  const today = new Date(2026, 9, 20);
  assert.equal(ageOn('2008-10-20', today), 18);
  assert.equal(ageOn('2008-10-21', today), 17);
  assert.equal(ageOn('1977-24-03', today), 0);
});

test('the hint names the mistake and stays quiet while typing', () => {
  assert.equal(birthdateHint({ d: '03', m: '24', y: '1977' }), 'Day goes first, then the month (01-12).');
  assert.equal(birthdateHint({ d: '25', m: '13', y: '' }), 'The month goes 01-12.');
  assert.equal(birthdateHint({ d: '32', m: '', y: '' }), 'The day goes 01-31.');
  assert.equal(birthdateHint({ d: '30', m: '02', y: '1977' }), "That month doesn't have that day.");
  assert.equal(birthdateHint({ d: '3', m: '2', y: '19' }), '');
  assert.equal(birthdateHint({ d: '24', m: '03', y: '1977' }), '');
});
