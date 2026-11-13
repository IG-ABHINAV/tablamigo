/**
 * Creator partners (affiliates), the money side: who referred whom, what each charge earns, voids and clawbacks. Database only,
 * so billing code anywhere can call it without import cycles; lib/affiliates.ts reads Razorpay and runs the admin side.
 *
 * Terms (owner, 3 Nov 2026): each partner gets a share (commission_percent, 30 by default, at most 50) of what the people they
 * bring pay, while they are a partner (status 'active'), or for commission_months from each referral when that is set. Play
 * charges count net of Google's fee. Every amount is in hundredths of the currency the customer paid in (paise, cents) and is
 * never converted: what is owed is kept per currency, and each currency has its own minimum payout.
 *
 * How a customer becomes a partner's referral (one partner per customer, first touch wins):
 * - web_link: the account was created from a ?ref=CODE visit (website cookie or /app/?ref=, sent with the sign-up);
 * - play_install_referrer: the Android app was installed from the partner's Play link (install referrer `ref=CODE`, or
 *   utm_source=affiliate&utm_campaign=CODE), sent with the sign-up;
 * - signup_code: the person typed the code (Profile > Invite friends) within SIGNUP_CODE_DAYS of signing up;
 * - coupon: the code was given at web checkout (any account age), carried in the Razorpay subscription's notes.
 * A partner never earns on their own account (same user id or same email), and two partners can't be each other's referrals.
 */
import { sql } from './db.js';
import { config } from './config.js';
import { REFERRAL } from './plus.js';
import { PASS_SKU } from './play-client.js';

export const AFFILIATE_CODE_RE = /^[A-Z0-9]{4,16}$/;
export const DEFAULT_PERCENT = 30;
export const MAX_PERCENT = 50;
/** A typed code attributes only this new an account (the same window as a friend's invite code). */
export const SIGNUP_CODE_DAYS = REFERRAL.redeemWithinDays;
/** How long the website remembers a ?ref= visit (apps/web/build.py PLAY_JS sets the tm_aff cookie for this long). */
export const COOKIE_DAYS = 60;
/**
 * Payouts are made once what is owed in a currency reaches this (₹1,000; $12). Any other currency (Play charges in the buyer's
 * currency) is paid in INR at the payout day's rate, once its INR equivalent reaches ₹1,000 (owner, 3 Nov 2026).
 */
export const MIN_PAYOUT: Record<string, number> = { INR: 100_000, USD: 1_200 };
/** Razorpay's fee when a payment doesn't state its own yet: 2% plus 18% GST on it. */
export const RAZORPAY_FEE_ESTIMATE_PERCENT = 2.36;

/** What owed `minor` of another currency is in paise at `inrPerUnit` (the payout day's rate), rounded down. Null for a bad rate. */
export function inrEquivalent(minor: number, inrPerUnit: number): number | null {
  if (!Number.isSafeInteger(minor) || !(Number.isFinite(inrPerUnit) && inrPerUnit > 0 && inrPerUnit <= 100_000)) return null;
  return Math.floor(minor * inrPerUnit);
}

/**
 * A web charge net of Razorpay's fee (owner, 3 Nov 2026): the payment's own `fee` (Razorpay's fee including GST, in paise) when it
 * states one, else an estimate (RAZORPAY_FEE_ESTIMATE_PERCENT, rounded up), which the admin shows as an estimate.
 */
export function razorpayNet(pay: { amount?: unknown; fee?: unknown }) {
  const gross = typeof pay?.amount === 'number' ? pay.amount : NaN;
  if (!Number.isSafeInteger(gross) || gross <= 0) return null;
  const stated = typeof pay.fee === 'number' && Number.isSafeInteger(pay.fee) && pay.fee >= 0 && pay.fee <= gross;
  const fee = stated ? (pay.fee as number) : Math.ceil((gross * RAZORPAY_FEE_ESTIMATE_PERCENT) / 100);
  return { grossMinor: gross, feeMinor: fee, netMinor: gross - fee, source: stated ? 'razorpay_payment' : 'razorpay_fee_estimated' };
}

/** Amount sources the admin marks as estimates. */
export const ESTIMATED_SOURCES = ['play_list_price', 'razorpay_fee_estimated'];

export type ReferralSource = 'web_link' | 'play_install_referrer' | 'signup_code' | 'coupon';

export function cleanAffiliateCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return AFFILIATE_CODE_RE.test(c) ? c : null;
}

/**
 * A bank UTR (NEFT/RTGS/IMPS) or a UPI RRN: 12 to 22 letters and digits once spaces and dashes are taken out, upper case. Anything
 * else (empty, too short, punctuation) is not a reference and can't mark a payout as paid.
 */
export function normalizeUtr(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const u = raw.replace(/[\s-]+/g, '').toUpperCase();
  return /^[A-Z0-9]{12,22}$/.test(u) ? u : null;
}

/** The commission on `netMinor` at `percent` (two decimals), rounded down: never a fraction of a paisa more than earned. */
export function commissionOf(netMinor: number, percent: number | string): number {
  const bp = Math.round(Number(percent) * 100);
  if (!Number.isSafeInteger(netMinor) || netMinor <= 0 || !(bp > 0)) return 0;
  return Math.floor((netMinor * bp) / 10_000);
}

/**
 * Whether `owedMinor` in `currency` can be paid out: INR or USD at their own minimum; any other currency once its INR equivalent at
 * `inrPerUnit` reaches ₹1,000 (without a rate it can't be known, so it isn't due).
 */
export function payoutDue(owedMinor: number, currency: string, inrPerUnit?: number | null): boolean {
  if (currency in MIN_PAYOUT) return owedMinor >= MIN_PAYOUT[currency];
  const inr = inrPerUnit == null ? null : inrEquivalent(owedMinor, inrPerUnit);
  return inr != null && inr >= MIN_PAYOUT.INR;
}

/**
 * The partner's links. The web link sets the website's cookie and the web app's first touch; the website's Play buttons then carry
 * the code into the install referrer, so one link works on every device. The Play link is for places that link to Play directly.
 */
export function affiliateLinks(code: string) {
  const referrer = `utm_source=affiliate&utm_medium=partner&utm_campaign=${code}&ref=${code}`;
  return {
    web: `${config.siteUrl}/?ref=${encodeURIComponent(code)}`,
    play: `https://play.google.com/store/apps/details?id=${config.playPackage}&referrer=${encodeURIComponent(referrer)}`,
  };
}

/** The partner code a new account arrived with, and how: the Play install referrer, else the web sign-up's ref_code. */
export function signupAffiliateCode(a: { refCode?: string | null; installReferrer?: string | null } | undefined): { code: string; source: ReferralSource } | null {
  if (a?.installReferrer) {
    try {
      const q = new URLSearchParams(a.installReferrer.slice(0, 500));
      const code = cleanAffiliateCode(q.get('ref')) ?? (q.get('utm_source') === 'affiliate' ? cleanAffiliateCode(q.get('utm_campaign')) : null);
      if (code) return { code, source: 'play_install_referrer' };
    } catch { /* not a query string */ }
  }
  const code = cleanAffiliateCode(a?.refCode);
  return code ? { code, source: 'web_link' } : null;
}

export type AttributeResult = 'attributed' | 'already_referred' | 'not_found' | 'inactive' | 'self_referral' | 'referral_loop' | 'too_late' | 'no_user';

/**
 * A referral loop: the partner whose code `userId` is using came to Tablamigo through `userId`'s own partner code. Two people
 * referring each other would each earn on the other's payments (a 30% discount ring), so the second link is refused.
 */
export async function isReferralLoop(tx: typeof sql, partnerUserId: string | null, userId: string) {
  if (!partnerUserId) return false;
  return !!(await tx`select 1 from affiliate_referrals r join affiliates a on a.id = r.affiliate_id where r.user_id = ${partnerUserId} and a.user_id = ${userId}`)[0];
}

/**
 * A partner who joined from the app (source 'self') and whose own account is since banned or deleted earns nothing more and gets
 * no new referrals, as if paused. Partners the admin added are the admin's call.
 */
export const PARTNER_GONE = sql`(a.source = 'self' and (a.user_id is null or pu.banned_at is not null or pu.deleted_at is not null))`;

const sameEmail = (a: unknown, b: unknown) => typeof a === 'string' && typeof b === 'string' && a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Make `userId` a referral of the partner with `code`. `maxAgeDays`: only an account at most that old (null: any age, the coupon).
 * Never throws for a bad code; the result says what happened. Safe to call twice: the first partner stays.
 */
export async function attributeReferral(userId: string, rawCode: unknown, source: ReferralSource, maxAgeDays: number | null): Promise<AttributeResult> {
  const code = cleanAffiliateCode(rawCode);
  if (!code) return 'not_found';
  return sql.begin(async tx => {
    const [a] = await tx`select a.id, a.user_id, a.email, a.status, ${PARTNER_GONE} as gone from affiliates a left join users pu on pu.id = a.user_id where a.code = ${code}`;
    if (!a) return 'not_found';
    if (a.status !== 'active' || a.gone) return 'inactive';
    const [u] = await tx`select id, email, deleted_at, created_at > now() - ${(maxAgeDays ?? 36500) + ' days'}::interval as fresh from users where id = ${userId}`;
    if (!u || u.deletedAt) return 'no_user';
    if (a.userId === userId || sameEmail(a.email, u.email)) return 'self_referral';
    if (await isReferralLoop(tx as unknown as typeof sql, a.userId, userId)) return 'referral_loop';
    if (!u.fresh) return 'too_late';
    const rows = await tx`insert into affiliate_referrals (user_id, affiliate_id, source) values (${userId}, ${a.id}, ${source})
      on conflict (user_id) do nothing returning 1`;
    return rows.length ? 'attributed' : 'already_referred';
  }) as Promise<AttributeResult>;
}

/** Sign-up: the partner code the new account arrived with, if any. Never stops a sign-up. */
export async function attributeAtSignup(userId: string, attribution: { refCode?: string | null; installReferrer?: string | null } | undefined) {
  const found = signupAffiliateCode(attribution);
  if (!found) return null;
  return attributeReferral(userId, found.code, found.source, 1).catch(e => { console.error('affiliate attribution failed', (e as Error).message); return null; });
}

export const hasAffiliateReferral = async (userId: string) => !!(await sql`select 1 from affiliate_referrals where user_id = ${userId}`)[0];

export type Charge = {
  provider: 'razorpay' | 'google_play';
  /** 'rzp:pay:<payment id>' or 'play:order:<order id>': one commission per charge, however often it is reported. */
  eventKey: string;
  userId: string;
  product: string | null;
  grossMinor: number; feeMinor: number; netMinor: number;
  currency: string;
  amountSource: string;
  occurredAt: Date;
};
export type AccrueResult = 'recorded' | 'duplicate' | 'voided' | 'no_referral' | 'inactive' | 'self_referral' | 'window_closed' | 'zero' | 'invalid';

/**
 * Record the commission on one charge by a referred customer. Idempotent on eventKey (a replayed webhook, the app's verify call and
 * an RTDN for the same charge record one row). A charge already refunded or charged back (affiliate_voided_events) records nothing.
 */
export async function accrueCommission(c: Charge): Promise<AccrueResult> {
  const ints = [c.grossMinor, c.feeMinor, c.netMinor];
  if (!/^(rzp:pay:|play:order:)[A-Za-z0-9._-]{4,80}$/.test(c.eventKey) || !/^[A-Z]{3}$/.test(c.currency)
    || !ints.every(Number.isSafeInteger) || c.feeMinor < 0 || c.netMinor > c.grossMinor || !(c.occurredAt instanceof Date) || isNaN(c.occurredAt.getTime())) return 'invalid';
  if (c.netMinor <= 0) return 'zero';
  return sql.begin(async tx => {
    if ((await tx`select 1 from affiliate_voided_events where event_key = ${c.eventKey}`)[0]) return 'voided';
    const [r] = await tx`select r.affiliate_id, a.status, a.commission_percent, a.user_id as partner_user, a.email as partner_email, u.email,
        (a.commission_months is not null and ${c.occurredAt}::timestamptz >= r.created_at + make_interval(months => a.commission_months)) as closed,
        ${PARTNER_GONE} as gone
      from affiliate_referrals r join affiliates a on a.id = r.affiliate_id join users u on u.id = r.user_id left join users pu on pu.id = a.user_id
      where r.user_id = ${c.userId}`;
    if (!r) return 'no_referral';
    if (r.status !== 'active' || r.gone) return 'inactive';
    if (r.partnerUser === c.userId || sameEmail(r.partnerEmail, r.email)) return 'self_referral';
    if (r.closed) return 'window_closed';
    const commission = commissionOf(c.netMinor, r.commissionPercent);
    if (commission <= 0) return 'zero';
    const rows = await tx`insert into affiliate_commissions (affiliate_id, user_id, provider, kind, event_key, product, gross_minor, fee_minor, net_minor,
        currency, amount_source, percent, commission_minor, occurred_at)
      values (${r.affiliateId}, ${c.userId}, ${c.provider}, 'charge', ${c.eventKey}, ${c.product}, ${c.grossMinor}, ${c.feeMinor}, ${c.netMinor},
        ${c.currency}, ${c.amountSource}, ${r.commissionPercent}, ${commission}, ${c.occurredAt})
      on conflict (event_key) do nothing returning 1`;
    return rows.length ? 'recorded' : 'duplicate';
  }) as Promise<AccrueResult>;
}

/** The ledger key of a Play order id (GPA.1234-5678-9012-34567, renewals ..0, ..1), or null for anything that isn't one. */
export const playOrderKey = (orderId: unknown) => (typeof orderId === 'string' && /^[A-Za-z0-9._-]{6,64}$/.test(orderId) ? `play:order:${orderId}` : null);

/** voidCommission for a voided Play order (refund or chargeback, from an RTDN or the hourly sweep). */
export async function voidPlayOrder(orderId: unknown, chargeback: boolean) {
  const key = playOrderKey(orderId);
  return key ? voidCommission(key, chargeback ? 'chargeback' : 'refund') : 'none';
}

export type VoidResult = 'voided' | 'clawback' | 'already_void' | 'none';

/**
 * A charge was refunded (any amount) or charged back: its commission is void. Still unpaid: it is never paid. Already paid out: a
 * negative clawback row comes off the partner's next payout. No commission yet: remembered, so a late accrual records nothing.
 * Idempotent.
 */
export async function voidCommission(eventKey: string, reason: string): Promise<VoidResult> {
  return sql.begin(async tx => {
    await tx`insert into affiliate_voided_events (event_key, reason) values (${eventKey}, ${reason}) on conflict (event_key) do nothing`;
    const [c] = await tx`select * from affiliate_commissions where event_key = ${eventKey} and kind = 'charge' for update`;
    if (!c) return 'none';
    if (c.status === 'void' || c.voidedAt) return 'already_void';
    if (c.status === 'pending') {
      await tx`update affiliate_commissions set status = 'void', void_reason = ${reason}, voided_at = now() where id = ${c.id}`;
      return 'voided';
    }
    await tx`update affiliate_commissions set void_reason = ${reason}, voided_at = now() where id = ${c.id}`;
    await tx`insert into affiliate_commissions (affiliate_id, user_id, provider, kind, event_key, product, gross_minor, fee_minor, net_minor,
        currency, amount_source, percent, commission_minor, void_reason, occurred_at)
      values (${c.affiliateId}, ${c.userId}, ${c.provider}, 'clawback', ${'clawback:' + eventKey}, ${c.product}, ${-Number(c.grossMinor)}, ${-Number(c.feeMinor)},
        ${-Number(c.netMinor)}, ${c.currency}, ${c.amountSource}, ${c.percent}, ${-Number(c.commissionMinor)}, ${reason}, now())
      on conflict (event_key) do nothing`;
    return 'clawback';
  }) as Promise<VoidResult>;
}

// --- Google Play -------------------------------------------------------------------------------------------------------------
type Money = { amountMinor: number; currency: string } | null | undefined;
/** What lib/play.ts reads from Google's Orders API for one order (null when it couldn't be read). */
export type PlayOrderAmounts = { total: Money; tax?: Money; developerRevenue?: Money; refunded?: Money; state?: string | null } | null;

/**
 * What one Play charge earns us, best source first: Google's own developer revenue for the order (after its fee and the taxes it
 * collects); else the order total less tax, less Google's fee (AFFILIATE_PLAY_FEE_PERCENT, 15 for subscriptions); else, the order
 * unreadable, the plan's list price less the fee (shown as an estimate).
 */
export function playNet(order: PlayOrderAmounts, listPrice: Money, feePercent = config.affiliatePlayFeePercent) {
  const total = order?.total;
  if (total && order?.developerRevenue && order.developerRevenue.currency === total.currency) {
    const net = order.developerRevenue.amountMinor;
    return { grossMinor: total.amountMinor, feeMinor: Math.max(0, total.amountMinor - net), netMinor: Math.min(net, total.amountMinor), currency: total.currency, source: 'play_developer_revenue' };
  }
  const base = total ? total.amountMinor - (order?.tax && order.tax.currency === total.currency ? order.tax.amountMinor : 0) : listPrice?.amountMinor;
  const currency = total?.currency ?? listPrice?.currency;
  if (!currency || !Number.isSafeInteger(base) || (base as number) <= 0) return null;
  const fee = Math.ceil(((base as number) * feePercent) / 100);
  return { grossMinor: total ? total.amountMinor : (base as number), feeMinor: fee + (total ? total.amountMinor - (base as number) : 0), netMinor: (base as number) - fee, currency, source: total ? 'play_order_total' : 'play_list_price' };
}

export type PlayChargeResult = AccrueResult | 'no_order' | 'test_purchase' | 'promo_code' | 'order_unreadable' | 'refunded' | 'no_amount';

/**
 * Commission on one Play order (a subscription purchase or renewal, or a Trip Pass). The caller (lib/play.ts) has Google's own copy
 * of the purchase, so nothing here trusts the app or the push. Test purchases and promo codes move no money and earn nothing; an
 * intro-offer charge whose order can't be read isn't guessed from the full list price.
 */
export async function accruePlayCharge(userId: string, productId: string, orderId: string | null,
  o: { order: PlayOrderAmounts; listPrice?: Money; test?: boolean; promo?: boolean; offerId?: string | null; at?: Date | null }): Promise<PlayChargeResult> {
  if (!orderId) return 'no_order';
  if (o.test) return 'test_purchase';
  if (o.promo) return 'promo_code';
  if (o.order?.refunded || ['CANCELED', 'REFUNDED', 'PARTIALLY_REFUNDED', 'CHARGEBACK'].includes(String(o.order?.state ?? ''))) return 'refunded';
  if (!o.order && (o.offerId || productId === PASS_SKU)) return 'order_unreadable';
  const amount = playNet(o.order, o.listPrice);
  if (!amount) return 'no_amount';
  return accrueCommission({ provider: 'google_play', eventKey: `play:order:${orderId}`, userId, product: productId, grossMinor: amount.grossMinor, feeMinor: amount.feeMinor,
    netMinor: amount.netMinor, currency: amount.currency, amountSource: amount.source, occurredAt: o.at ?? new Date() });
}
