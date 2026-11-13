/**
 * The soft paywall right after onboarding (the paywall screens with ?intro=1; the API's lib/plus-intro.ts decides who sees it,
 * once per account) and the yearly plan's numbers on every paywall: its price per month and its saving against paying monthly,
 * both computed from the real prices (Play's for the person's country on Android, the API's Razorpay prices on the web), never
 * typed in. The yearly free trial exists only when the API names a Play offer (PLAY_YEARLY_TRIAL_OFFER_ID) AND Play returns that
 * offer for this person; otherwise there is no trial text and no trial purchase.
 */

/**
 * Where the soft paywall goes: the API's answer to POST /me/plus-intro decides; any failure goes straight to the app. The API
 * marks the account when it answers, so an answer that arrives too late (or a closed app) loses the one showing: on purpose,
 * since showing it twice is the thing that must never happen.
 */
export async function afterStart(api: (path: string, init: { body: unknown }) => Promise<any>, timeoutMs = 4000): Promise<'/paywall?intro=1' | '/(tabs)'> {
  try {
    const r = await Promise.race([api('/me/plus-intro', { body: {} }), new Promise(ok => setTimeout(() => ok(null), timeoutMs))]) as { show?: boolean } | null;
    return r?.show === true ? '/paywall?intro=1' : '/(tabs)';
  } catch { return '/(tabs)'; }
}

/**
 * A plan of `months` months per month (rounded UP to the cent, or to the whole unit from 100 up, so it never reads cheaper than it
 * is) and the saving against that many months of the monthly plan (rounded DOWN to a whole percent, so it is never overstated).
 * Null when a price is missing or the plan saves nothing.
 */
export function planDeal(monthly: number | null | undefined, price: number | null | undefined, months: number): { perMonth: number; savePct: number } | null {
  if (!(typeof monthly === 'number' && monthly > 0 && typeof price === 'number' && price > 0 && months > 1)) return null;
  const raw = price / months;
  const perMonth = raw >= 100 ? Math.ceil(raw - 1e-9) : Math.ceil(raw * 100 - 1e-6) / 100;
  const savePct = Math.floor((1 - price / (monthly * months)) * 100 + 1e-9);
  return savePct >= 1 ? { perMonth, savePct } : null;
}
/** The yearly plan's deal (planDeal over 12 months). */
export const yearlyDeal = (monthly: number | null | undefined, yearly: number | null | undefined) => planDeal(monthly, yearly, 12);
/** The 6-month plan's deal (planDeal over 6 months). */
export const halfYearDeal = (monthly: number | null | undefined, halfyearly: number | null | undefined) => planDeal(monthly, halfyearly, 6);

/** An amount in a currency, the way the phone's language writes it (₹334, $7.50); whole amounts without decimals. */
export function money(amount: number, currency: string, locale?: string): string {
  const whole = Number.isInteger(amount);
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: whole ? 0 : 2 }).format(amount); }
  catch { return `${currency} ${whole ? amount : amount.toFixed(2)}`; }
}

/** "₹334/month · save 33%", or null. The same line for the 6-month plan. */
export function yearlyBadge(deal: ReturnType<typeof planDeal>, currency: string, locale?: string): string | null {
  return deal ? `${money(deal.perMonth, currency, locale)}/month · save ${deal.savePct}%` : null;
}

/** Days in an ISO 8601 period Play uses for a trial phase (P3D, P1W); null for anything else. */
export function isoDays(period: string | null | undefined): number | null {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?$/.exec(period ?? '');
  if (!m || (!m[1] && !m[2])) return null;
  const d = Number(m[1] ?? 0) * 7 + Number(m[2] ?? 0);
  return d > 0 ? d : null;
}

type Phase = { billingPeriod?: string; priceAmountMicros?: string | number; priceCurrencyCode?: string; formattedPrice?: string; billingCycleCount?: number };
type Offer = { id?: string | null; basePlanIdAndroid?: string | null; displayPrice?: string; offerTokenAndroid?: string | null; price?: number; currency?: string | null; pricingPhasesAndroid?: { pricingPhaseList?: Phase[] } | null };
export type PlayPlan = { basePlan: string; price: string; token: string | null; amount: number | null; currency: string | null };
/** A discounted first period: Play's own price string for it (formattedPrice) and the token that buys it. */
export type PlayIntro = { token: string; price: string };
/** The yearly free trial; `intro` is the discounted first year after the free days, when the trial offer has one. */
export type PlayTrial = { token: string; days: number; intro?: string | null };

/**
 * The intro offers in Play Console (infra/play/intro-offers.mjs): new customers only, so Play returns one only to someone who
 * never had Plus on Google Play. Turned off by deactivating it in Play; then Play stops returning it and the row shows the
 * normal price. The yearly free trial (yearly-trial-3d) is separate: the API's PLAY_YEARLY_TRIAL_OFFER_ID switches it.
 */
export const INTRO_OFFERS: Record<string, string> = { monthly: 'monthly-intro-50', yearly: 'yearly-launch-20' };

const micros = (p: Phase | undefined) => Number(p?.priceAmountMicros);
/** One discounted, single-period phase as long as the base plan's own period, cheaper than it but not free. */
const discountPhase = (p: Phase | undefined, base: Phase | undefined) => !!p && !!base && p.billingPeriod === base.billingPeriod
  && (p.billingCycleCount ?? 1) === 1 && micros(p) > 0 && micros(p) < micros(base) && !!p.formattedPrice;

/**
 * Play's subscription offers, as expo-iap returns them, to one plan per base plan (the base plan's own price, never an offer),
 * each base plan's intro offer (INTRO_OFFERS: that exact offer id, one discounted period, then the base plan's own price) and,
 * when `trialOfferId` names one, the yearly free trial: that exact offer id on the yearly base plan, whose first phase costs 0
 * for a whole number of days, optionally followed by one discounted year, and whose last phase is the yearly base plan's own
 * price. Anything else about an offer (another base plan, other phases, another price after) means it is not shown or sold.
 */
export function pickPlayOffers(offers: Offer[] | null | undefined, trialOfferId: string | null | undefined): { plans: PlayPlan[]; trial: PlayTrial | null; intros: Record<string, PlayIntro> } {
  const plans: PlayPlan[] = []; let trial: (PlayTrial & { after: number }) | null = null;
  const intros: Record<string, PlayIntro & { after: number }> = {};
  for (const o of offers ?? []) {
    const base = o.basePlanIdAndroid; if (!base) continue;
    const phases = o.pricingPhasesAndroid?.pricingPhaseList ?? [];
    const last = phases[phases.length - 1];
    if (trialOfferId && o.id === trialOfferId) {
      const first = phases[0]; const days = isoDays(first?.billingPeriod);
      const after = micros(last);
      const mid = phases.length === 3 ? phases[1] : null;
      if (base === 'yearly' && (phases.length === 2 || (mid && discountPhase(mid, last))) && micros(first) === 0 && days && o.offerTokenAndroid && after > 0)
        trial = { token: o.offerTokenAndroid, days, intro: mid?.formattedPrice ?? null, after: after / 1e6 };
      continue;
    }
    if (o.id && INTRO_OFFERS[base] === o.id) {
      if (phases.length === 2 && discountPhase(phases[0], last) && o.offerTokenAndroid) intros[base] = { token: o.offerTokenAndroid, price: phases[0].formattedPrice!, after: micros(last) / 1e6 };
      continue;
    }
    // Only the base plan itself: one pricing phase (Play's base plan), never an offer with a free or discounted start.
    if (o.id?.includes('trial') || phases.length > 1 || plans.some(p => p.basePlan === base)) continue;
    const amount = last?.priceAmountMicros != null ? Number(last.priceAmountMicros) / 1e6 : typeof o.price === 'number' ? o.price : null;
    plans.push({ basePlan: base, price: o.displayPrice ?? '', token: o.offerTokenAndroid ?? null, amount: Number.isFinite(amount) ? amount : null, currency: last?.priceCurrencyCode ?? o.currency ?? null });
  }
  // What an offer charges after its first period must be its base plan row's price: the screen says "then <price>/<period>".
  const same = (basePlan: string, after: number) => { const p = plans.find(x => x.basePlan === basePlan); return p?.amount != null && Math.abs(after - p.amount) < 0.005; };
  const okIntros: Record<string, PlayIntro> = {};
  for (const [b, i] of Object.entries(intros)) if (same(b, i.after)) okIntros[b] = { token: i.token, price: i.price };
  return { plans, intros: okIntros, trial: trial && same('yearly', trial.after) ? { token: trial.token, days: trial.days, intro: trial.intro } : null };
}

const UNIT: Record<string, string> = { monthly: 'month', halfyearly: '6 months', yearly: 'year' };
/** A row's intro line: "₹249 for your first month, then ₹499/month". */
export const introLine = (basePlan: string, introPrice: string, price: string) => { const u = UNIT[basePlan] ?? 'period'; return `${introPrice} for your first ${u}, then ${price}/${u}`; };

/** The yearly row's line while a trial is offered: "3 days free, then ₹3,999/year", or with a discounted first year
 * "3 days free, then ₹3,199 for your first year, then ₹3,999/year". */
export const trialLine = (days: number, yearlyPrice: string, introPrice?: string | null) =>
  introPrice ? `${days} days free, then ${introLine('yearly', introPrice, yearlyPrice)}` : `${days} days free, then ${yearlyPrice}/year`;

/**
 * The one offer a purchase of `basePlan` carries: the yearly trial while it is offered (it already holds the discounted year),
 * else the base plan's intro offer, else the base plan itself. Never two: Play takes exactly one offer token per purchase.
 */
export function purchaseToken(basePlan: string, baseToken: string | null | undefined, trial: PlayTrial | null, intros: Record<string, PlayIntro>): string | null {
  if (basePlan === 'yearly' && trial) return trial.token;
  return intros[basePlan]?.token ?? baseToken ?? null;
}

/** The intro's plans in order: yearly first (highlighted and chosen), then 6 months, then monthly, then the Trip Pass. No weekly plan. */
export function introOrder<P extends { basePlan: string }>(plans: P[]): P[] {
  return ['yearly', 'halfyearly', 'monthly', 'pass'].map(b => plans.find(p => p.basePlan === b)).filter(Boolean) as P[];
}

/** The full paywall's plans in order: the 6-month plan sits between monthly and yearly. Unknown base plans are left out. */
export const PLAN_ORDER = ['weekly', 'monthly', 'halfyearly', 'yearly', 'pass'];
export function planOrder<P extends { basePlan: string }>(plans: P[]): P[] {
  return PLAN_ORDER.map(b => plans.find(p => p.basePlan === b)).filter(Boolean) as P[];
}
