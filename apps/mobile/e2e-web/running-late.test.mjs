// "Running late" only around a plan's start (src/lib/running-late.ts, same window as the API).
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runningLateOpen } from '../src/lib/running-late.ts';

const at = (mins) => new Date(Date.UTC(2026, 9, 22, 12, 0) + mins * 60_000).toISOString();
const NOW = Date.UTC(2026, 9, 22, 12, 0);

test('hidden right after posting a plan that starts later today or in days', () => {
  assert.equal(runningLateOpen(at(4.5 * 60), NOW), false);    // a 19:30 plan seen at 15:00
  assert.equal(runningLateOpen(at(5 * 24 * 60), NOW), false); // five days out
  assert.equal(runningLateOpen(at(61), NOW), false);
});

test('shown from an hour before the start until an hour after', () => {
  for (const m of [60, 30, 0, -30, -60]) assert.equal(runningLateOpen(at(m), NOW), true, String(m));
  assert.equal(runningLateOpen(at(-61), NOW), false);
});

test('no start time, no button', () => {
  assert.equal(runningLateOpen(null, NOW), false);
  assert.equal(runningLateOpen('not a date', NOW), false);
});
