// Welcome screen "Example plan" bubbles (lib/bubble-layout.ts): never overlap each other (including the float animation),
// never leave their area, and drop out instead of piling up when the screen is short (iPhone SE, Safari with toolbars).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bubbleLayout, BUBBLE_H, FLOAT, MIN_GAP, MAX_STEP } from '../../src/lib/bubble-layout.ts';

const check = (h, slots) => {
  for (const [i, s] of slots.entries()) {
    assert.ok(s.top - FLOAT >= 0, `bubble ${i} floats above the area (h=${h})`);
    assert.ok(s.top + BUBBLE_H <= h, `bubble ${i} runs past the area (h=${h})`);
    if (i) assert.ok(s.top - (slots[i - 1].top + BUBBLE_H) >= MIN_GAP - 1, `bubbles ${i - 1}/${i} too close (h=${h})`);
  }
};

test('every height from 0 to 900: no overlap, inside the area', () => {
  for (let h = 0; h <= 900; h += 1) check(h, bubbleLayout(h, 4));
});

test('short areas show fewer bubbles, not squashed ones', () => {
  assert.equal(bubbleLayout(40, 4).length, 0);
  assert.equal(bubbleLayout(BUBBLE_H + FLOAT, 4).length, 1);
  assert.equal(bubbleLayout(170, 4).length, 2);   // iPhone 15 Pro in Safari, toolbars showing
  assert.equal(bubbleLayout(400, 4).length, 4);
});

test('never more than asked for; tall areas keep a compact group, centred', () => {
  const s = bubbleLayout(900, 4);
  assert.equal(s.length, 4);
  assert.ok(s[1].top - s[0].top <= MAX_STEP);
  const above = s[0].top - FLOAT, below = 900 - (s[3].top + BUBBLE_H);
  assert.ok(Math.abs(above - below) <= 1, 'centred');
});

test('alternate sides, starting on the left', () => {
  assert.deepEqual(bubbleLayout(400, 4).map(s => s.side), ['left', 'right', 'left', 'right']);
});

test('bad input gives nothing', () => {
  for (const h of [NaN, -5, 0]) assert.deepEqual(bubbleLayout(h, 4), []);
  assert.deepEqual(bubbleLayout(400, 0), []);
});
