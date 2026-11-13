// lib/tap-target.ts: the web box behind IconButton, BackButton and ReportButton (UI sweep, 2 Nov 2026: the plan and profile
// "More options" were 24pt, chat search/media 30pt, Report flags 18-20pt and the trip Delete 22pt on the web app).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webTapBox, MIN_TAP } from '../../src/lib/tap-target.ts';


test('every icon gets at least a 44pt box', () => {
  for (const [size, pad] of [[16, 0], [20, 0], [22, 4], [24, 0], [28, 0], [36, 4], [50, 0]]) {
    const b = webTapBox(size, pad, 'none');
    assert.ok(b.width >= MIN_TAP && b.height >= MIN_TAP, `${size}+${pad}`);
    assert.equal(b.width, Math.max(MIN_TAP, size + 2 * pad));
  }
});

test('the footprint in the layout stays what the icon and its padding took before', () => {
  for (const [size, pad] of [[16, 0], [22, 4], [24, 0], [28, 0]]) {
    const was = size + 2 * pad;
    const none = webTapBox(size, pad, 'none');
    assert.equal(none.width + 2 * none.marginHorizontal, was);
    assert.equal(none.height + 2 * none.marginVertical, was);
    // At the end of a row the box grows into the row's padding on that side only; the icon stays where it was.
    const left = webTapBox(size, pad, 'left'), right = webTapBox(size, pad, 'right');
    assert.equal(left.marginRight, undefined); assert.equal(right.marginLeft, undefined);
    const iconCentre = b => (b.marginLeft ?? 0) + b.width / 2;
    assert.equal(iconCentre(left), was / 2);   // same centre as the old footprint, measured from where it started
  }
});

test("edge 'right' pulls only the right side, 'left' only the left, both by the same amount as the vertical", () => {
  const right = webTapBox(24, 0, 'right'), left = webTapBox(24, 0, 'left');
  assert.equal(right.marginRight, -10); assert.equal(right.marginVertical, -10); assert.equal(right.marginLeft, undefined); assert.equal(right.marginHorizontal, undefined);
  assert.equal(left.marginLeft, -10); assert.equal(left.marginRight, undefined);
  const padded = webTapBox(22, 4, 'right');   // chat "Photos and links": 22 + 2 * 4 = 30, so 7 each way
  assert.equal(padded.width, 44); assert.equal(padded.marginRight, -7); assert.equal(padded.marginVertical, -7);
});

test('native: IconButton keeps the old padding and hitSlop, no web box', async () => {
  const fs = await import('node:fs');
  const ui = fs.readFileSync(new URL('../../src/components/ui.tsx', import.meta.url), 'utf8');
  const fn = ui.slice(ui.indexOf('export function IconButton'), ui.indexOf('export function BackButton'));
  assert.match(fn, /Platform\.OS === 'web' \? webTapBox\(size, pad, edge\) : pad \? \{ padding: pad \} : null/);
  assert.match(fn, /hitSlop=\{12\}/);
});

test('an icon already 44 or bigger is left alone', () => {
  const b = webTapBox(40, 4, 'none');
  assert.equal(b.width, 48); assert.ok(b.marginHorizontal === 0 && b.marginVertical === 0);
});
