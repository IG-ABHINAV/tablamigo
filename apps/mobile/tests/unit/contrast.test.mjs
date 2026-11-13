// Text contrast of the light theme (the web app and the Android app are light-only). UI sweep, 2 Nov 2026: ink3 (#9C9CAD, the
// inactive tab labels, hints, "Send a new code") was 2.7:1 on white and go (#10B39F: "2/6 going", white "Join chat") 2.6:1.
// WCAG AA asks 4.5:1 for body text. The brand coral and the women/danger tints (3.1-3.9:1) are a design call, not checked here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C } from '../../src/lib/theme.ts';

const lum = hex => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255].map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0); };
export const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

test('the ratio itself: black on white is 21, a colour on itself 1', () => {
  assert.equal(Math.round(ratio('#000000', '#FFFFFF')), 21);
  assert.equal(ratio('#10B39F', '#10B39F'), 1);
  assert.ok(ratio('#9C9CAD', '#FFFFFF') < 3);   // the old ink3, so the check below can fail
});

test('every ink is at least 4.5:1 on every light surface', () => {
  for (const ink of ['ink', 'ink2', 'ink3']) for (const bg of ['bg', 'bgSoft', 'card']) {
    assert.ok(ratio(C[ink], C[bg]) >= 4.5, `${ink} on ${bg}: ${ratio(C[ink], C[bg]).toFixed(2)}`);
  }
});

test('teal text on the surfaces and its tint, and white text on a teal button, are at least 4.5:1', () => {
  for (const bg of ['bg', 'bgSoft', 'card', 'goSoft']) assert.ok(ratio(C.go, C[bg]) >= 4.5, `go on ${bg}: ${ratio(C.go, C[bg]).toFixed(2)}`);
  assert.ok(ratio('#FFFFFF', C.go) >= 4.5, `white on go: ${ratio('#FFFFFF', C.go).toFixed(2)}`);
});
