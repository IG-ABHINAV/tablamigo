// The partner programme terms the member accepts in the app (src/app/partner.tsx). The API accepts a sign-up only with this
// version (apps/api/src/lib/partner-signup.ts PARTNER_TERMS; its unit test holds the two, and the website's partners.html, together).
// Change the wording here, on the website and in the API in one go, with a new date.
export const PARTNER_TERMS_VERSION = '2026-11-04';
export const PARTNER_PERCENT = 30;

export const PARTNER_TERMS: string[] = [
  `You earn ${PARTNER_PERCENT}% of what the people you bring to Tablamigo pay us (after Google Play's or the payment provider's fee), for as long as you are a partner.`,
  'People count as yours when they create their account from your link, install the Android app from it, or enter your code in their first days on Tablamigo. One partner per person: the first one counts.',
  'You never earn on your own purchases or your own account, and two partners cannot be each other\'s referrals.',
  'Refunded or charged-back payments earn nothing; if one was already paid out, it comes off your next payout.',
  'We pay monthly by bank transfer or UPI once you are owed ₹1,000 or $12. Other currencies are paid in INR at the rate on the payout day.',
  'No paid promotion: no ads, sponsored posts or search ads that use the Tablamigo name. No spam, fake reviews or misleading claims, and no cashback or coupon sites.',
  'We can pause or end a partnership that breaks these terms. Commission stops for payments after that; what you already earned fairly is still paid.',
];

type Money = { currency: string; amountMinor: number };
const SYMBOL: Record<string, string> = { INR: '₹', USD: '$', EUR: '€', GBP: '£' };

/** Amounts per currency, never added together: "₹300.00 · $3.00", or "—" for none. */
export function partnerMoney(rows: Money[] | null | undefined): string {
  if (!rows?.length) return '—';
  return rows.map(r => {
    const v = (Number(r.amountMinor) / 100).toFixed(2);
    return SYMBOL[r.currency] ? `${SYMBOL[r.currency]}${v}` : `${r.currency} ${v}`;
  }).join(' · ');
}

export type PayoutForm = { method: 'upi'; upiId: string } | { method: 'bank'; accountName: string; accountNumber: string; ifsc: string };

/** What is wrong with the payout form, in words, or null. The same rules as the API's parsePayout, which checks again. */
export function payoutError(f: PayoutForm): string | null {
  if (f.method === 'upi') {
    return /^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,63}$/.test(f.upiId.trim().toLowerCase()) ? null : 'Enter a UPI ID like name@okaxis.';
  }
  if (!/^[A-Za-z][A-Za-z .'-]{1,79}$/.test(f.accountName.trim().replace(/\s+/g, ' '))) return 'Enter the account holder\'s name as the bank has it.';
  if (!/^\d{9,18}$/.test(f.accountNumber.replace(/[\s-]+/g, ''))) return 'The account number is 9 to 18 digits.';
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(f.ifsc.trim().toUpperCase())) return 'The IFSC code is 11 characters, like HDFC0001234.';
  return null;
}
