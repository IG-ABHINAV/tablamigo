// One-off: creates Plus plans on the shared Razorpay account and prints their ids for
// RAZORPAY_PLAN_MONTHLY / RAZORPAY_PLAN_HALFYEARLY / RAZORPAY_PLAN_YEARLY. Each run makes new plans, so run it once per plan.
// Usage: RAZORPAY_KEY_ID=... RAZORPAY_KEY_SECRET=... npx tsx src/scripts/razorpay-plans.ts [monthly|halfyearly|yearly ...]
// (no argument: all three; on prod, node dist/scripts/razorpay-plans.js halfyearly)
import { rzp, RAZORPAY_PRICES, SERVICE, PERIODS, type Period } from '../lib/razorpay.js';

const PLAN: Record<Period, { period: 'monthly' | 'yearly'; interval: number; label: string }> = {
  monthly: { period: 'monthly', interval: 1, label: '1 month' },
  halfyearly: { period: 'monthly', interval: 6, label: '6 months' },
  yearly: { period: 'yearly', interval: 1, label: '1 year' },
};
const wanted = process.argv.slice(2);
const bad = wanted.filter(w => !PERIODS.includes(w as Period));
if (bad.length) throw new Error(`unknown plan ${bad.join(', ')}: use ${PERIODS.join(', ')}`);
for (const p of (wanted.length ? wanted : PERIODS) as Period[]) {
  const { period, interval, label } = PLAN[p];
  const r = await rzp('POST', '/plans', {
    period, interval,
    item: { name: `Tablamigo Plus · ${label}`, amount: RAZORPAY_PRICES[p], currency: RAZORPAY_PRICES.currency, description: 'Tablamigo Plus subscription' },
    notes: { service: SERVICE, product: `tablamigo_plus_${p}` },
  });
  console.log(`RAZORPAY_PLAN_${p.toUpperCase()}=${r.id}`);
}
