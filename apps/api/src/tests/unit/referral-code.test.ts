// Reading an invite code from a sign-up (lib/referral.ts): the web app's ref_code, or `ref` in the Play install referrer.
import { describe, it, expect } from 'vitest';
import { refCodeFrom, cleanRefCode, inviteLink } from '../../lib/referral.js';

describe('reading the code', () => {
  it('the link is the website invite page', () => {
    expect(inviteLink('AB12CD34')).toMatch(/\/invite\?code=AB12CD34$/);
  });

  it('takes 4-16 letters and digits, upper-cases, and ignores anything else', () => {
    expect(cleanRefCode(' ab12cd34 ')).toBe('AB12CD34');
    for (const bad of ['', 'ab', 'AB-12', 'x'.repeat(17), null, 42, '<script>']) expect(cleanRefCode(bad)).toBeNull();
    expect(refCodeFrom({ install_referrer: 'utm_source=invite&ref=Q1W2E3R4' })).toBe('Q1W2E3R4');
    expect(refCodeFrom({ ref_code: 'A1B2C3D4', install_referrer: 'ref=ZZZZ9999' })).toBe('A1B2C3D4');
    expect(refCodeFrom({ install_referrer: 'utm_source=google-play&utm_medium=organic' })).toBeNull();
    expect(refCodeFrom(undefined)).toBeNull();
  });
});
