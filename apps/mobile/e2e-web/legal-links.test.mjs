// The welcome screen says "By continuing you agree to the Terms and Privacy Policy". Until 1.2.0 both were plain text, so
// nobody could read what they were agreeing to before signing in. This fails if either word stops opening its page.
//   npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { TERMS_URL, PRIVACY_URL } from '../src/lib/legal.ts';

const src = f => fs.readFileSync(new URL(`../src/app/${f}`, import.meta.url), 'utf8');

test('the legal pages are the website Terms and Privacy Policy', () => {
  assert.equal(TERMS_URL, 'https://tablamigo.hookstep.in/terms');
  assert.equal(PRIVACY_URL, 'https://tablamigo.hookstep.in/privacy');
});

for (const f of ['(auth)/welcome.tsx', '(tabs)/profile.tsx']) {
  test(`${f} opens both pages`, () => {
    const s = src(f);
    assert.match(s, /onPress=\{\(\) => Linking\.openURL\(TERMS_URL\)\}/);
    assert.match(s, /onPress=\{\(\) => Linking\.openURL\(PRIVACY_URL\)\}/);
  });
}

test('the welcome line names the Terms and the Privacy Policy as links, not plain text', () => {
  const s = src('(auth)/welcome.tsx');
  assert.match(s, /openURL\(TERMS_URL\)\}[^>]*>Terms</);
  assert.match(s, /openURL\(PRIVACY_URL\)\}[^>]*>Privacy Policy</);
  assert.doesNotMatch(s, /agree to the Terms and Privacy Policy\./);
});
