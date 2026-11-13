// Self-serve partner sign-up in the app (src/app/partner.tsx, src/lib/partner-terms.ts; API routes/partner.ts). The terms the
// member accepts, the money and payout helpers the screen uses, and that the screen only joins once the terms are ticked.
//   cd apps/mobile && npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PARTNER_TERMS_VERSION, PARTNER_PERCENT, PARTNER_TERMS, partnerMoney, payoutError } from '../../src/lib/partner-terms.ts';

const read = f => fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');

test('the terms: 30% while a partner, monthly by bank or UPI, no paid promotion, never on your own purchases', () => {
  assert.equal(PARTNER_PERCENT, 30);
  assert.match(PARTNER_TERMS_VERSION, /^\d{4}-\d{2}-\d{2}$/);
  const all = PARTNER_TERMS.join(' ');
  for (const need of [/30%/, /as long as you are a partner/i, /monthly/i, /UPI/, /bank/i, /no paid promotion/i, /own purchases/i]) assert.match(all, need);
  for (const bad of [/lifetime/i, /forever/i, /40%/]) assert.doesNotMatch(all, bad);
});

test('money is shown per currency and never added across currencies', () => {
  assert.equal(partnerMoney([]), '—');
  assert.equal(partnerMoney([{ currency: 'INR', amountMinor: 30000 }]), '₹300.00');
  assert.equal(partnerMoney([{ currency: 'INR', amountMinor: 30000 }, { currency: 'USD', amountMinor: 300 }]), '₹300.00 · $3.00');
  assert.equal(partnerMoney([{ currency: 'XYZ', amountMinor: 150 }]), 'XYZ 1.50');
});

test('payout details are checked before they are sent (the API checks them again)', () => {
  assert.equal(payoutError({ method: 'upi', upiId: 'asha.rao@okaxis' }), null);
  assert.equal(payoutError({ method: 'bank', accountName: 'Asha Rao', accountNumber: '5010 0123 4567', ifsc: 'hdfc0001234' }), null);
  assert.match(payoutError({ method: 'upi', upiId: 'asha' }), /UPI ID/);
  assert.match(payoutError({ method: 'upi', upiId: "x' or 1=1@ok" }), /UPI ID/);
  assert.match(payoutError({ method: 'bank', accountName: '', accountNumber: '123456789', ifsc: 'HDFC0001234' }), /name/i);
  assert.match(payoutError({ method: 'bank', accountName: 'Asha', accountNumber: '1234', ifsc: 'HDFC0001234' }), /account number/i);
  assert.match(payoutError({ method: 'bank', accountName: 'Asha', accountNumber: '123456789', ifsc: 'HDFC1234' }), /IFSC/);
});

test('the screen joins only after the terms are ticked, sends the terms version, and has a copy button for the link', () => {
  const src = read('src/app/partner.tsx');
  assert.match(src, /disabled=\{!accepted/);
  assert.match(src, /termsVersion: PARTNER_TERMS_VERSION/);
  assert.match(src, /acceptTerms: true/);
  assert.match(src, /Copy link/);
  assert.match(src, /\/me\/partner\/payout/);
  assert.doesNotMatch(src, /body: \{[^}]*percent/, 'the app never sends a percent');
});

test('Profile opens the partner screen', () => {
  assert.match(read('src/app/(tabs)/profile.tsx'), /router\.push\('\/partner'/);
});
