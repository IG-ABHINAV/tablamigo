// Wide web windows (lib/wide.ts): every screen but the Explore map is a centred column; phones and the native apps untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnStyle, isWide, COLUMN_MAX, WIDE_FROM } from '../../src/lib/wide.ts';

test('native apps never get a column, whatever the width (tablets, foldables)', () => {
  for (const p of ['ios', 'android']) for (const w of [390, 820, 1440]) assert.equal(columnStyle(p, w), undefined);
});
test('web: phones and the 768 iPad stay full width; wider windows get the centred column', () => {
  assert.equal(columnStyle('web', 390), undefined);
  assert.equal(columnStyle('web', 768), undefined);
  assert.equal(isWide('web', WIDE_FROM - 1), false);
  const c = columnStyle('web', 1440, '#ccc');
  assert.deepEqual(c, { width: '100%', maxWidth: COLUMN_MAX, alignSelf: 'center', borderLeftWidth: 1, borderRightWidth: 1, borderColor: '#ccc' });
  assert.ok(COLUMN_MAX >= 768 - 8, 'an iPad portrait layout fits the column');
});
