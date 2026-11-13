// Self-serve partner sign-up (lib/partner-signup.ts), the pure parts: the code generator, payout details (validation, masking,
// encryption at rest), and that the terms version the API accepts is the one the website and the app show.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newPartnerCode, PARTNER_CODE_ALPHABET, parsePayout, maskPayout, sealPayout, openPayout, PARTNER_TERMS } from '../../lib/partner-signup.js';
import { AFFILIATE_CODE_RE, DEFAULT_PERCENT } from '../../lib/affiliate-ledger.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('newPartnerCode', () => {
  it('is 8 characters from an alphabet without look-alikes (no 0/O, 1/I/L), and passes the affiliate code rule', () => {
    expect(PARTNER_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    expect(PARTNER_CODE_ALPHABET.length).toBe(31);
    for (let i = 0; i < 2000; i++) {
      const c = newPartnerCode();
      expect(c).toMatch(AFFILIATE_CODE_RE);
      expect(c).toHaveLength(8);
      expect([...c].every(ch => PARTNER_CODE_ALPHABET.includes(ch))).toBe(true);
    }
  });

  it('does not repeat (about 40 bits each: guessing one is not practical)', () => {
    const seen = new Set(Array.from({ length: 20_000 }, () => newPartnerCode()));
    expect(seen.size).toBe(20_000);
  });

  it('uses the random source it is given, without modulo bias in the mapping', () => {
    const fixed = (bytes: number[]) => (n: number) => Buffer.from(bytes.slice(0, n));
    // 31 letters: a byte of 248 or more would bias the mapping and is skipped.
    expect(newPartnerCode(fixed([0, 1, 2, 3, 4, 5, 6, 30, 255, 248]))).toBe(PARTNER_CODE_ALPHABET.slice(0, 7) + PARTNER_CODE_ALPHABET[30]);
  });
});

describe('payout details', () => {
  it('accepts a UPI id and masks it', () => {
    const p = parsePayout({ method: 'upi', upiId: '  Rajesh.Kumar-9@okaxis ' });
    expect(p).toEqual({ method: 'upi', upiId: 'rajesh.kumar-9@okaxis' });
    // First 2 and last 1 of the name before the @ (14 characters here), the bank's handle in full.
    expect(maskPayout(p!)).toBe('ra' + '•'.repeat(11) + '9@okaxis');
    expect(maskPayout(parsePayout({ method: 'upi', upiId: 'ab@ybl' })!)).toBe('a•@ybl');
  });

  it('accepts an Indian bank account and masks all but the last 4 digits', () => {
    const p = parsePayout({ method: 'bank', accountName: 'Rajesh Kumar', accountNumber: '0012 3456 7890', ifsc: 'hdfc0001234' });
    expect(p).toEqual({ method: 'bank', accountName: 'Rajesh Kumar', accountNumber: '001234567890', ifsc: 'HDFC0001234' });
    expect(maskPayout(p!)).toBe('Bank ••••7890 (HDFC0001234)');
  });

  it.each([
    [{ method: 'upi', upiId: "' or 1=1 --@okaxis" }],
    [{ method: 'upi', upiId: '<script>alert(1)</script>@ybl' }],
    [{ method: 'upi', upiId: 'nobody' }],
    [{ method: 'upi', upiId: 'a@' }],
    [{ method: 'upi', upiId: 'x'.repeat(300) + '@okaxis' }],
    [{ method: 'bank', accountName: "Robert'); drop table users;--", accountNumber: '123456789012', ifsc: 'HDFC0001234' }],
    [{ method: 'bank', accountName: '<img src=x onerror=alert(1)>', accountNumber: '123456789012', ifsc: 'HDFC0001234' }],
    [{ method: 'bank', accountName: 'Rajesh Kumar', accountNumber: '12345', ifsc: 'HDFC0001234' }],
    [{ method: 'bank', accountName: 'Rajesh Kumar', accountNumber: '1234567890123456789', ifsc: 'HDFC0001234' }],
    [{ method: 'bank', accountName: 'Rajesh Kumar', accountNumber: '123456789012', ifsc: 'HDFC1001234' }],
    [{ method: 'bank', accountName: 'Rajesh Kumar', accountNumber: '12345678901a', ifsc: 'HDFC0001234' }],
    [{ method: 'paypal', email: 'a@b.co' }],
    [null], ['upi'], [{ method: 'upi', upiId: 42 }],
  ])('refuses %j', bad => { expect(parsePayout(bad)).toBeNull(); });

  it('is encrypted at rest: the sealed text holds none of the details, opens to the same details, and refuses tampering', () => {
    const p = parsePayout({ method: 'bank', accountName: 'Rajesh Kumar', accountNumber: '001234567890', ifsc: 'HDFC0001234' })!;
    const sealed = sealPayout(p);
    expect(sealed).toMatch(/^v1:/);
    for (const s of ['Rajesh', '001234567890', '4567', 'HDFC']) expect(sealed).not.toContain(s);
    expect(sealPayout(p)).not.toBe(sealed);           // a fresh IV each time
    expect(openPayout(sealed)).toEqual(p);
    const [v, iv, tag, ct] = sealed.split(':');
    const flipped = Buffer.from(ct, 'base64url'); flipped[0] ^= 1;
    expect(openPayout([v, iv, tag, flipped.toString('base64url')].join(':'))).toBeNull();
    expect(openPayout('garbage')).toBeNull();
  });
});

describe('the terms', () => {
  it('self sign-up is at the default 30% (the 40% tier stays admin-only)', () => {
    expect(PARTNER_TERMS.percent).toBe(DEFAULT_PERCENT);
    expect(PARTNER_TERMS.percent).toBe(30);
  });

  it('the website and the app show the version the API accepts', () => {
    const web = fs.readFileSync(path.join(ROOT, 'apps/web/src/partners.html'), 'utf8');
    expect(web).toContain(`data-terms-version="${PARTNER_TERMS.version}"`);
    const app = fs.readFileSync(path.join(ROOT, 'apps/mobile/src/lib/partner-terms.ts'), 'utf8');
    expect(app).toContain(`PARTNER_TERMS_VERSION = '${PARTNER_TERMS.version}'`);
  });
});
