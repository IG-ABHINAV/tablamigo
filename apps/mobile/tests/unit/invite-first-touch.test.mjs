// The web app keeps the invite code (?ref=) and utm_* values it was opened with and sends them with the sign-in that creates the
// account (src/lib/install-referrer.web.ts), so a friend's invite is redeemed without typing the code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const store = new Map();
globalThis.window = {
  location: { search: '?ref=ab12cd34&utm_source=invite&utm_medium=referral', pathname: '/app/' },
  localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
};
const { touchFromSearch, mergeTouch, signupExtras, captureFirstTouch } = await import('../../src/lib/install-referrer.web.ts');

test('an invite link\'s code and utm values are read from the address', () => {
  assert.deepEqual(touchFromSearch('?ref=ab12cd34&utm_source=invite', '/app/'),
    { ref_code: 'AB12CD34', utm_source: 'invite', landing: '/app/?ref=ab12cd34&utm_source=invite' });
});

test('junk is not a code, and an address with nothing in it records nothing', () => {
  assert.deepEqual(touchFromSearch('?ref=<script>'), {});
  assert.deepEqual(touchFromSearch('?ref=ab'), {});
  assert.deepEqual(touchFromSearch(''), {});
});

test('the first visit wins, except that a newer invite code replaces an older one', () => {
  const first = { utm_source: 'meta', landing: '/app/?utm_source=meta' };
  assert.equal(mergeTouch(first, {}), first);
  assert.deepEqual(mergeTouch(first, { utm_source: 'google' }), first);
  assert.deepEqual(mergeTouch(first, { ref_code: 'NEWCODE1' }), { ...first, ref_code: 'NEWCODE1' });
  assert.deepEqual(mergeTouch(null, { ref_code: 'X1Y2' }), { ref_code: 'X1Y2' });
});

test('the sign-in carries what the web app was opened with, even after the address changes', async () => {
  window.location = { search: '', pathname: '/app/(auth)/email' };
  captureFirstTouch();
  const extras = await signupExtras();
  assert.equal(extras.ref_code, 'AB12CD34');
  assert.equal(extras.utm_source, 'invite');
  assert.equal(extras.utm_medium, 'referral');
});

test('no storage (private mode) never breaks a sign-in', async () => {
  window.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  window.location = { search: '?ref=AB12CD34', pathname: '/app/' };
  captureFirstTouch();
  assert.deepEqual(await signupExtras(), {});
});

test('the root layout loads it at start, before the router redirects /app/?ref= to /app/welcome and drops the query', () => {
  const src = fs.readFileSync(new URL('../../src/app/_layout.tsx', import.meta.url), 'utf8');
  assert.match(src, /^import '..\/lib\/install-referrer';/m);
});

// Creator partners: the website's tm_aff cookie (set from ?ref=CODE, apps/web/build.py) is the partner code when the web app was
// opened without one in its own address.
test('a partner code is read from the tm_aff cookie, and nothing else is', async () => {
  const { refFromCookie } = await import('../../src/lib/install-referrer.web.ts');
  assert.equal(refFromCookie('tm_aff=RAJ1'), 'RAJ1');
  assert.equal(refFromCookie('a=1; tm_aff=LOSTLEBLANC; b=2'), 'LOSTLEBLANC');
  assert.equal(refFromCookie('xtm_aff=RAJ1'), undefined);
  assert.equal(refFromCookie('tm_aff=raj1'), undefined);
  assert.equal(refFromCookie('tm_aff=<script>'), undefined);
  assert.equal(refFromCookie(''), undefined);
});
