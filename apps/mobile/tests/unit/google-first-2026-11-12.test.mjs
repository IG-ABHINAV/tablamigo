// 12 Nov 2026 (owner): sign-in friction gone. "Continue with Google" is the big main button on the welcome screen (Android and
// web app); email is the smaller second option, "Use email instead", and still works. No backend change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = p => fs.readFileSync(new URL(p, import.meta.url), 'utf8');

test('welcome: Google first and prominent, email second as a ghost button that still opens the email screen', () => {
  const w = read('../../src/app/(auth)/welcome.tsx');
  const g = w.indexOf('<GoogleButton prominent'), e = w.indexOf('title="Use email instead"');
  assert.ok(g > 0 && e > g, 'Google comes first and is marked prominent');
  assert.match(w, /title="Use email instead" kind="ghost" onPress=\{\(\) => router\.push\('\/\(auth\)\/email'\)\}/);
  assert.doesNotMatch(w, /Continue with email/);
});

test('the prominent Google button stays inside Google branding: dark theme on Android, filled_black on the web', () => {
  const n = read('../../src/components/GoogleButton.tsx');
  assert.match(n, /prominent \? \{ up: '#131314'.*line: '#8E918F', ink: '#E3E3E3' \}/);
  assert.match(n, /Continue with Google/);
  const w = read('../../src/components/GoogleButton.web.tsx');
  assert.match(w, /theme: prominent \? 'filled_black' : 'outline'/);
  assert.match(w, /\[width, prominent\]/);
});

test('the browser pass and the Maestro sign-in flow tap the new email label', () => {
  assert.doesNotMatch(read('../../e2e-web/drive.mjs'), /Continue with email/);
  assert.match(read('../../maestro/subflows/sign-in.yaml'), /tapOn: "Use email instead"/);
});
