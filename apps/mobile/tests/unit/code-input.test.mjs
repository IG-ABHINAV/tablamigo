// lib/code-input.ts and the sign-in code screen (8 Nov 2026): after the keyboard was closed, tapping the code boxes never
// brought it back on Android, and a pasted code was cut by maxLength before the screen read it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Platform } from 'react-native';
import { openCodeKeyboard, codeFromInput } from '../../src/lib/code-input.ts';

const fakeField = focused => {
  const calls = [];
  return { calls, isFocused: () => focused, focus: () => calls.push('focus'), blur: () => calls.push('blur') };
};

const never = () => assert.fail('no second tick needed');

test('a field without focus is just focused', () => {
  const f = fakeField(false);
  openCodeKeyboard(f, never);
  assert.deepEqual(f.calls, ['focus']);
});

test('a field that still has focus (keyboard closed by the person) is blurred, then focused on the next tick (Android)', () => {
  const f = fakeField(true);
  let pending;
  openCodeKeyboard(f, fn => { pending = fn; });
  assert.deepEqual(f.calls, ['blur']);
  pending();
  assert.deepEqual(f.calls, ['blur', 'focus']);
});

test('the default next tick really refocuses', async () => {
  const f = fakeField(true);
  openCodeKeyboard(f);
  assert.deepEqual(f.calls, ['blur']);
  await new Promise(r => setTimeout(r, 120));
  assert.deepEqual(f.calls, ['blur', 'focus']);
});

test('web app: always a plain focus inside the tap, never a delayed one', () => {
  Platform.OS = 'web';
  try {
    const f = fakeField(true);
    openCodeKeyboard(f, never);
    assert.deepEqual(f.calls, ['focus']);
  } finally { Platform.OS = 'android'; }
});

test('no field yet: nothing happens, nothing throws', () => {
  openCodeKeyboard(null);
  openCodeKeyboard(undefined);
});

test('typed and pasted codes come out as the six digits', () => {
  assert.equal(codeFromInput('12'), '12');
  assert.equal(codeFromInput('123456'), '123456');
  assert.equal(codeFromInput('123 456'), '123456');
  assert.equal(codeFromInput('Your Tablamigo code is 482913'), '482913');
  assert.equal(codeFromInput('482913 is your code, valid for 10 minutes'), '482913');
  assert.equal(codeFromInput('1234567'), '123456');
  assert.equal(codeFromInput('abc'), '');
});

test('the code screen uses both, and no longer cuts a paste with maxLength', () => {
  const src = fs.readFileSync(new URL('../../src/app/(auth)/code.tsx', import.meta.url), 'utf8');
  assert.match(src, /openCodeKeyboard\(input\.current\)/);
  assert.match(src, /codeFromInput\(t\)/);
  assert.doesNotMatch(src, /maxLength=\{6\}/);
  // The field sits over the boxes, so a tap reaches the native field itself (keyboard, and a long-press Paste).
  assert.match(src, /testID="code-field"[\s\S]*?position: 'absolute', left: 0, right: 0, top: 0, bottom: 0/);
});

test("a tap on the field is left to Android: no JS blur and re-focus fighting the native keyboard show", () => {
  // 8 Nov 2026, 1.4.3 release APK on the emulator: with onPressIn={() => openCodeKeyboard(...)} on the field, Android's own
  // show from the tap was followed by the JS blur (hide) and re-focus (show), and the IME animation ended hidden on 7 of
  // 12 taps (ImeTracker: HIDE_SOFT_INPUT_ON_ANIMATION_STATE_CHANGED). The boxes' Pressable keeps it for a tap beside the field.
  const src = fs.readFileSync(new URL('../../src/app/(auth)/code.tsx', import.meta.url), 'utf8');
  const field = src.match(/<TextInput ref=\{input\}[^]*?\/>/)?.[0] ?? '';
  assert.match(field, /testID="code-field"/);
  assert.doesNotMatch(field, /onPressIn|onPress=|onFocus=\{[^}]*blur/);
  assert.match(src, /<Pressable onPress=\{\(\) => openCodeKeyboard\(input\.current\)\}/);
});
