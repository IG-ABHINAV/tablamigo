// The pure parts of the creator-partner ledger (lib/affiliate-ledger.ts): codes, UTRs, commission rounding, minimum payouts per
// currency, Play net-of-fee amounts, sign-up attribution parsing and the partner's links. No database.
import { describe, it, expect } from 'vitest';
import { cleanAffiliateCode, normalizeUtr, commissionOf, payoutDue, razorpayNet, inrEquivalent, playNet, signupAffiliateCode, affiliateLinks, playOrderKey, MIN_PAYOUT, COOKIE_DAYS } from '../../lib/affiliate-ledger.js';

const m = (amountMinor: number, currency = 'INR') => ({ amountMinor, currency });

describe('codes and references', () => {
  it('a partner code is 4-16 letters and digits, upper-cased; nothing else is', () => {
    expect(cleanAffiliateCode(' raj1 ')).toBe('RAJ1');
    expect(cleanAffiliateCode('LostLeBlanc')).toBe('LOSTLEBLANC');
    for (const bad of ['', 'ab', 'abc', 'A'.repeat(17), 'RAJ-1', 'RAJ 1', '<script>', 'RAJ1\u0000', null, undefined, 42, {}]) expect(cleanAffiliateCode(bad), String(bad)).toBeNull();
  });

  it('a UTR or UPI RRN is 12-22 letters and digits once spaces and dashes go; anything else is refused', () => {
    expect(normalizeUtr('hdfc r5 2026 1103 0001')).toBe('HDFCR5202611030001');
    expect(normalizeUtr('430912345678')).toBe('430912345678');
    expect(normalizeUtr('AXIS-1234-5678-90')).toBe('AXIS1234567890');
    for (const bad of ['', '   ', '12345678901', 'A'.repeat(23), 'UTR_123456789012', 'UTR12345678901;DROP', '१२३४५६७८९०१२', null, 123456789012]) expect(normalizeUtr(bad), String(bad)).toBeNull();
  });

  it('Play order keys accept Google order ids (renewals too) and nothing that could collide with another key', () => {
    expect(playOrderKey('GPA.3312-5678-9012-34567')).toBe('play:order:GPA.3312-5678-9012-34567');
    expect(playOrderKey('GPA.3312-5678-9012-34567..2')).toBe('play:order:GPA.3312-5678-9012-34567..2');
    for (const bad of ['', 'GPA', 'a b c d e f', 'GPA.1:rzp:pay', null, 7]) expect(playOrderKey(bad), String(bad)).toBeNull();
  });
});

describe('commission arithmetic', () => {
  it('rounds down to the paisa or cent, never up', () => {
    expect(commissionOf(49900, 30)).toBe(14970);
    expect(commissionOf(49900, 33.33)).toBe(16631);   // 16631.67
    expect(commissionOf(849, 30)).toBe(254);           // 254.7
    expect(commissionOf(1, 30)).toBe(0);
    expect(commissionOf(99, '40.00')).toBe(39);        // numeric comes back from Postgres as a string
  });

  it('pays nothing on zero, negative, fractional, NaN or absurd input', () => {
    for (const [net, pct] of [[0, 30], [-100, 30], [10.5, 30], [NaN, 30], [Infinity, 30], [100, 0], [100, -5], [100, NaN], [Number.MAX_SAFE_INTEGER + 2, 30]] as const)
      expect(commissionOf(net, pct), `${net} @ ${pct}`).toBe(0);
  });

  it('a payout is due only in a currency with a minimum, once that much is owed (₹1,000; $12)', () => {
    expect(MIN_PAYOUT).toEqual({ INR: 100_000, USD: 1_200 });
    expect(payoutDue(99_999, 'INR')).toBe(false);
    expect(payoutDue(100_000, 'INR')).toBe(true);
    expect(payoutDue(1_199, 'USD')).toBe(false);
    expect(payoutDue(1_200, 'USD')).toBe(true);
    expect(payoutDue(10_000_000, 'ZAR')).toBe(false);   // no rate yet: can't know
    expect(payoutDue(10_000_000, 'EUR')).toBe(false);
    expect(payoutDue(20_834, 'ZAR', 4.8)).toBe(true);    // ₹1,000.03
    expect(payoutDue(20_833, 'ZAR', 4.8)).toBe(false);   // ₹999.98
    expect(payoutDue(1_000, 'EUR', 0)).toBe(false);
    expect(payoutDue(-500, 'INR')).toBe(false);
  });
});

describe('Play net of Google\'s fee', () => {
  it('uses Google\'s developer revenue when the order states it', () => {
    expect(playNet({ total: m(49900), tax: m(7612), developerRevenue: m(35941) }, m(49900), 15))
      .toEqual({ grossMinor: 49900, feeMinor: 13959, netMinor: 35941, currency: 'INR', source: 'play_developer_revenue' });
  });

  it('else total less tax less the fee (rounded up, so the net is never overstated)', () => {
    expect(playNet({ total: m(999, 'USD') }, null, 15)).toEqual({ grossMinor: 999, feeMinor: 150, netMinor: 849, currency: 'USD', source: 'play_order_total' });
    expect(playNet({ total: m(49900), tax: m(7612) }, null, 15)).toMatchObject({ netMinor: 35944, feeMinor: 6344 + 7612 });
  });

  it('ignores a tax or developer revenue in another currency rather than mixing currencies', () => {
    expect(playNet({ total: m(999, 'USD'), tax: m(100, 'INR'), developerRevenue: m(500, 'EUR') }, null, 15)).toMatchObject({ netMinor: 849, currency: 'USD', source: 'play_order_total' });
  });

  it('falls back to the list price when the order is unreadable, and to nothing when there is no amount', () => {
    expect(playNet(null, m(49900), 15)).toMatchObject({ netMinor: 42415, source: 'play_list_price' });
    expect(playNet(null, null, 15)).toBeNull();
    expect(playNet({ total: m(0) }, m(49900), 15)).toBeNull();   // a free trial's order: nothing earned
    expect(playNet({ total: m(500), tax: m(600) }, null, 15)).toBeNull();
  });
});

describe('sign-up attribution', () => {
  it('reads the Play install referrer first (ref=, or utm_source=affiliate + utm_campaign), else the web ref_code', () => {
    expect(signupAffiliateCode({ installReferrer: 'utm_source=affiliate&utm_medium=partner&utm_campaign=RAJ1&ref=RAJ1' })).toEqual({ code: 'RAJ1', source: 'play_install_referrer' });
    expect(signupAffiliateCode({ installReferrer: 'utm_source=affiliate&utm_campaign=fabian' })).toEqual({ code: 'FABIAN', source: 'play_install_referrer' });
    expect(signupAffiliateCode({ installReferrer: 'utm_source=google-play&utm_medium=organic', refCode: 'MDFIZZ' })).toEqual({ code: 'MDFIZZ', source: 'web_link' });
    expect(signupAffiliateCode({ installReferrer: 'utm_source=meta&utm_campaign=SUMMER' })).toBeNull();   // an ad campaign is not a partner
    expect(signupAffiliateCode({ installReferrer: '%%%not a query', refCode: null })).toBeNull();
    expect(signupAffiliateCode(undefined)).toBeNull();
  });

  it('each partner gets a web link and a Play link carrying their code; the cookie lasts 60 days', () => {
    const l = affiliateLinks('LOSTLEBLANC');
    expect(l.web).toMatch(/\/\?ref=LOSTLEBLANC$/);
    const r = new URLSearchParams(new URL(l.play).searchParams.get('referrer')!);
    expect(Object.fromEntries(r)).toEqual({ utm_source: 'affiliate', utm_medium: 'partner', utm_campaign: 'LOSTLEBLANC', ref: 'LOSTLEBLANC' });
    expect(new URL(l.play).searchParams.get('id')).toBe('com.tablamigo.app');
    expect(COOKIE_DAYS).toBe(60);
  });
});

describe('owner decisions, 3 Nov 2026', () => {
  it('Razorpay net: the payment\'s own fee, else 2.36% rounded up; a fee that can\'t be right is not believed', () => {
    expect(razorpayNet({ amount: 49900, fee: 1178 })).toEqual({ grossMinor: 49900, feeMinor: 1178, netMinor: 48722, source: 'razorpay_payment' });
    expect(razorpayNet({ amount: 49900, fee: 0 })).toMatchObject({ netMinor: 49900, source: 'razorpay_payment' });
    expect(razorpayNet({ amount: 49900 })).toMatchObject({ feeMinor: 1178, netMinor: 48722, source: 'razorpay_fee_estimated' });
    for (const fee of [-1, 49901, 1.5, '1178', null]) expect(razorpayNet({ amount: 49900, fee })!.source, String(fee)).toBe('razorpay_fee_estimated');
    for (const amount of [0, -100, 10.5, '49900', undefined]) expect(razorpayNet({ amount, fee: 0 }), String(amount)).toBeNull();
  });

  it('INR equivalent at the payout day\'s rate, rounded down; refuses a missing or absurd rate', () => {
    expect(inrEquivalent(24_220, 4.8)).toBe(116_256);
    expect(inrEquivalent(1_249, 88.73)).toBe(110_823);
    for (const r of [0, -4.8, NaN, Infinity, 1e6]) expect(inrEquivalent(100, r), String(r)).toBeNull();
    expect(inrEquivalent(10.5, 4.8)).toBeNull();
  });
});
