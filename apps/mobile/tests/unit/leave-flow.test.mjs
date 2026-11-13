// Profile > Delete account (src/components/LeaveSheet.tsx, src/lib/leave-flow.ts): the reasons match the API, the offer only
// for an empty city, the body sent, and deletion stays 2 taps after the Profile row whatever is picked (Google Play policy).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LEAVE_REASONS, offerFor, deleteBody, TAPS_TO_DELETE } from '../../src/lib/leave-flow.ts';

const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test("the reasons are exactly the API's DELETION_REASONS, in order", () => {
  const api = read('../../../api/src/routes/me.ts').match(/DELETION_REASONS = \[([^\]]+)\]/)[1].match(/'([a-z_]+)'/g).map(s => s.slice(1, -1));
  assert.deepEqual(LEAVE_REASONS.map(([c]) => c), api);
});

test('only "No one near me" gets the offer', () => {
  assert.equal(offerFor('no_one_near'), 'nearby');
  for (const [c] of LEAVE_REASONS.filter(([c]) => c !== 'no_one_near')) assert.equal(offerFor(c), null, c);
  assert.equal(offerFor(null), null);
});

test('DELETE /me gets the picked reason, or nothing; never an unknown one', () => {
  assert.deepEqual(deleteBody('no_one_near'), { reason: 'no_one_near' });
  assert.deepEqual(deleteBody(null), {});
  assert.deepEqual(deleteBody('made_up'), {});
});

test('the sheet: no reason is required, and "Delete anyway" then "Delete my account" delete (2 taps)', () => {
  assert.equal(TAPS_TO_DELETE, 2);
  const src = read('../../src/components/LeaveSheet.tsx');
  // The way on from the "why" screen is never disabled and never waits for a reason.
  const cont = src.match(/<Button title="Delete anyway".*\/>/)[0];
  assert.doesNotMatch(cont, /disabled/);
  assert.match(cont, /onPress=\{\(\) => setStage\('confirm'\)\}/);
  const final = src.match(/<Button title="Delete my account".*\/>/)[0];
  assert.match(final, /onPress=\{del\}/);
  assert.doesNotMatch(final, /disabled/);
  // Profile's row opens the sheet straight away.
  const profile = read('../../src/app/(tabs)/profile.tsx');
  assert.match(profile, /label="Delete account" onPress=\{del\}/);
  assert.match(profile, /const del = \(\) => setDeleting\(true\);/);
});

test('12 Nov 2026: the first screen offers snooze and new-plan alerts, says so plainly, and adds no screen', async () => {
  const { RETENTION } = await import('../../src/lib/leave-flow.ts');
  assert.equal(RETENTION.line, 'Wait, new travellers join every week. You can come back to people near you in a few weeks.');
  const src = read('../../src/components/LeaveSheet.tsx');
  assert.match(src, /title=\{RETENTION\.snooze\} kind="soft" onPress=\{\(\) => \{ close\(\); onSnooze\(\); \}\}/);
  assert.match(src, /nearbyPlanAlerts: on/);
  // Still exactly two stages: no extra screen between the offers and the confirm.
  assert.deepEqual([...src.matchAll(/setStage\('(\w+)'\)/g)].map(m => m[1]).filter((v, i, a) => a.indexOf(v) === i).sort(), ['confirm', 'why']);
  assert.match(src, /Deleting cancels it, on Google Play and on the website/);
  const profile = read('../../src/app/(tabs)/profile.tsx');
  assert.match(profile, /onSnooze=\{\(\) => setSnoozing\(true\)\}/);
});
