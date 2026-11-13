// The sign-in code screen ((auth)/code.tsx) draws six boxes over one hidden text field. Two ways that left people stuck
// (8 Nov 2026: from 4 Nov, 31 code requests on Android and 3 sign-ins; reproduced on 1.4.2):
//  - once the keyboard was closed (Back, the keyboard's own hide key, a trip to the mail app), tapping the boxes called
//    focus() on a field that still had focus, which on Android does not bring the keyboard back. The only live control
//    left was "Send a new code", so people asked for code after code and never typed one.
//  - a pasted code was cut by maxLength={6} before the screen saw it ("Your code is 123456" kept "Your c").
// The field now lies over the boxes, so a tap lands on the native field and Android re-opens the keyboard itself. The blur
// and re-focus below is only for a tap that lands on the boxes beside the field: run during a tap on the field, it raced
// Android's own show and left the keyboard closed on 7 of 12 taps (8 Nov 2026, emulator).

import { Platform } from 'react-native';

/** The parts of a TextInput the screen needs; a fake in the unit tests. */
export type CodeField = { isFocused(): boolean; focus(): void; blur(): void };

/**
 * Brings the keyboard up for the code field. A field that still has focus is blurred and focused again on the next tick,
 * because Android ignores focus() (and a tap) on the focused view and the keyboard would stay closed. Keyboard.isVisible()
 * can't be trusted to skip this: on the 1.4.2 emulator it still said "open" after the keyboard's own hide key, and the
 * keyboard never came back. Re-focusing an open keyboard only makes it blink once.
 */
export function openCodeKeyboard(field: CodeField | null | undefined, later: (fn: () => void) => void = fn => { setTimeout(fn, 80); }) {
  if (!field) return;
  // A browser opens its keyboard only inside the tap itself, so the web app never waits a tick (and the tap on the field
  // already does it there).
  if (!field.isFocused() || Platform.OS === 'web') { field.focus(); return; }
  field.blur(); later(() => field.focus());
}

/**
 * The code from whatever landed in the field: typed digits, a pasted "123456", "123 456" or a whole line from the email
 * ("Your Tablamigo code is 123456"). A run of exactly six digits wins; otherwise the digits in order, at most six.
 */
export function codeFromInput(text: string): string {
  const six = text.match(/(?<!\d)\d{6}(?!\d)/);
  if (six) return six[0];
  return text.replace(/\D/g, '').slice(0, 6);
}
