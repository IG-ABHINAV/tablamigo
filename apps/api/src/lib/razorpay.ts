import crypto from 'node:crypto';
import { config } from './config.js';
import { sql } from './db.js';
import { grantPass, recomputePlus, voidPass, PASS_SKU, PASS_DAYS } from './play.js';
import { ownerSaleAlert, ownerSaleAlertLookup, razorpayTest, razorpayProduct, istDate, unixDate, type SaleKind, type SaleEvent } from './owner-alerts.js';
import { razorpayRow, paidThrough, haltedPaidThrough, razorpayEnded, RAZORPAY_STATE, CHARGEABLE } from './billing-policy.js';
import { HttpError } from './errors.js';
import { emailPlusCancelled, emailPlusPaymentStopped } from './emails/events.js';
import type { OtherPlus } from './emails/templates.js';
import { voidCommission } from './affiliate-ledger.js';

/** Web prices in paise. The Plus amounts must match the Razorpay plans made by scripts/razorpay-plans.ts. */
export const RAZORPAY_PRICES = { currency: 'INR', monthly: 49900, halfyearly: 249900, yearly: 399900, pass: 29900, passDays: PASS_DAYS } as const;
// The Razorpay account is shared: anything without notes.service = SERVICE belongs to another product.
export const SERVICE = 'tablamigo';
const TOTAL_COUNT = { monthly: 120, halfyearly: 20, yearly: 10 };
export type Period = keyof typeof TOTAL_COUNT;
export const PERIODS = Object.keys(TOTAL_COUNT) as Period[];
/** Months in one billing cycle of each Plus plan. */
export const PERIOD_MONTHS: Record<Period, number> = { monthly: 1, halfyearly: 6, yearly: 12 };
/** The Razorpay plan id of each period ('' when not configured). */
export const planIdOf = (period: Period) => ({ monthly: config.razorpay.planMonthly, halfyearly: config.razorpay.planHalfyearly, yearly: config.razorpay.planYearly })[period];
/** The periods the web can sell right now: halfyearly only once RAZORPAY_PLAN_HALFYEARLY is set. */
export const sellablePeriods = () => PERIODS.filter(p => p !== 'halfyearly' || !!planIdOf(p));

export const razorpayOn = () => !!(config.razorpay.keyId && config.razorpay.keySecret);
const enc = encodeURIComponent;

export async function rzp<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  if (!razorpayOn()) throw new Error('razorpay_not_configured');
  const { keyId, keySecret } = config.razorpay;
  const r = await fetch(`https://api.razorpay.com/v1${path}`, {
    method,
    headers: { authorization: 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64'), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`razorpay_${r.status}: ${j?.error?.description ?? 'error'}`);
  return j;
}

export function signatureOk(payload: string, signature: string) {
  const want = Buffer.from(crypto.createHmac('sha256', config.razorpay.keySecret).update(payload).digest('hex'));
  const got = Buffer.from(String(signature));
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const notes = (userId: string, product: string) => ({ service: SERVICE, user_id: userId, product });
export const ours = (n: any, userId: string) => n?.service === SERVICE && n?.user_id === userId;

export async function createPassOrder(userId: string) {
  return rzp('POST', '/orders', { amount: RAZORPAY_PRICES.pass, currency: RAZORPAY_PRICES.currency, receipt: `tm_pass_${Date.now()}_${userId.slice(0, 8)}`, notes: notes(userId, PASS_SKU) });
}

export async function createTicketOrder(userId: string, activityId: string, amountPaise: number, currency = 'INR') {
  return rzp('POST', '/orders', {
    amount: amountPaise,
    currency,
    receipt: `tm_tkt_${Date.now()}_${userId.slice(0, 8)}`,
    notes: { service: SERVICE, user_id: userId, product: 'activity_ticket', activity_id: activityId },
  });
}

export async function verifyRazorpayTicket(userId: string, activityId: string, orderId: string, paymentId: string, signature: string, expectedAmountPaise: number) {
  if (!signatureOk(`${orderId}|${paymentId}`, signature)) throw new Error('bad_signature');
  const [order, payment] = await Promise.all([rzp('GET', `/orders/${enc(orderId)}`), rzp('GET', `/payments/${enc(paymentId)}`)]);
  if (!ours(order.notes, userId) || order.notes.product !== 'activity_ticket' || order.notes.activity_id !== activityId) throw new Error('not_our_order');
  if (payment.notes?.service && !ours(payment.notes, userId)) throw new Error('not_our_order');
  if (payment.order_id !== orderId) throw new Error('order_mismatch');
  if (payment.amount !== expectedAmountPaise || order.amount !== expectedAmountPaise || payment.currency !== order.currency) throw new Error('amount_mismatch');
  const p = payment.status === 'authorized' ? await rzp('POST', `/payments/${enc(paymentId)}/capture`, { amount: payment.amount, currency: payment.currency }) : payment;
  if (p.status !== 'captured') throw new Error('ticket_not_paid');
  return { orderId, paymentId };
}

/**
 * Checkout's signature proves Razorpay saw this payment on this order; the server fetch proves it is
 * paid, ours and this user's. Idempotent per payment: a retry returns the same window.
 */
export async function verifyRazorpayPass(userId: string, orderId: string, paymentId: string, signature: string) {
  if (!signatureOk(`${orderId}|${paymentId}`, signature)) throw new Error('bad_signature');
  const [order, payment] = await Promise.all([rzp('GET', `/orders/${enc(orderId)}`), rzp('GET', `/payments/${enc(paymentId)}`)]);
  if (!ours(order.notes, userId) || order.notes.product !== PASS_SKU) throw new Error('not_our_order');
  if (payment.notes?.service && !ours(payment.notes, userId)) throw new Error('not_our_order');
  if (payment.order_id !== orderId) throw new Error('order_mismatch');
  if (payment.amount !== order.amount || payment.currency !== RAZORPAY_PRICES.currency) throw new Error('amount_mismatch');
  const p = payment.status === 'authorized' ? await rzp('POST', `/payments/${enc(paymentId)}/capture`, { amount: payment.amount, currency: payment.currency }) : payment;
  if (p.status !== 'captured') throw new Error('pass_not_paid');
  const expiresAt = await grantPass(userId, `rzp:${paymentId}`, orderId, p);
  // Same key as the forwarded payment.captured / order.paid (razorpay-webhook.ts): one alert, whichever arrives first.
  ownerSaleAlert(`rzp:pay:${paymentId}`, () => ({
    kind: 'pass_purchase', provider: 'razorpay', userId, product: razorpayProduct(PASS_SKU), amountMinor: Number(p.amount), currency: p.currency,
    ids: { paymentId, orderId }, test: razorpayTest(), details: [['Plus until', istDate(expiresAt ? new Date(expiresAt) : null)]],
  }));
  return { active: true, expiresAt };
}

/**
 * A new web subscription. With `startAt` (Reactivate, SC-09: a cancelled subscription still has paid time) its first charge is
 * at that second, so nothing is charged today and nothing twice; notes.replaces names the subscription whose time it follows.
 */
export async function createSubscription(userId: string, period: Period, reactivate?: { startAt: number; replaces: string }, coupon?: { code: string; offerId: string | null }) {
  const plan = planIdOf(period);
  if (!plan) throw new Error('plan_not_configured');
  return rzp('POST', '/subscriptions', {
    plan_id: plan, total_count: TOTAL_COUNT[period], customer_notify: 1,
    ...(reactivate ? { start_at: reactivate.startAt } : {}),
    // A partner's code given as a coupon (lib/affiliates.ts couponAffiliate): notes.affiliate_code attributes the customer to them
    // when the first charge is recorded, and their Razorpay offer, if they have one, is the discount.
    ...(coupon?.offerId ? { offer_id: coupon.offerId } : {}),
    notes: { ...notes(userId, `tablamigo_plus_${period}`), ...(reactivate ? { replaces: reactivate.replaces } : {}), ...(coupon ? { affiliate_code: coupon.code } : {}) },
  });
}

const ACTIVE = RAZORPAY_STATE.active;

/** A chargeback locks web checkout (SC-13) until an admin clears it. */
export async function assertCanBuyOnWeb(userId: string) {
  const [u] = await sql`select billing_disputed_at from users where id = ${userId}`;
  if (u?.billingDisputedAt) throw new HttpError(409, 'billing_disputed', 'A payment on this account is disputed, so web purchases are paused. Please contact support@hookstep.in.');
}

/**
 * Cancel at Razorpay now (cancel_at_cycle_end 0, never at the cycle end: the 11 Nov race). Access is kept by our row, not by
 * Razorpay. A subscription Razorpay already ended is fine; any other refusal throws.
 */
export async function cancelAtRazorpay(subId: string) {
  try { return await rzp('POST', `/subscriptions/${enc(subId)}/cancel`, { cancel_at_cycle_end: 0 }); }
  catch (e) {
    const s = await rzp('GET', `/subscriptions/${enc(subId)}`).catch(() => null);
    if (s && !CHARGEABLE.includes(s.status) && s.status !== 'halted' && s.status !== 'paused') return s;
    throw e;
  }
}

/**
 * Store a Razorpay subscription's state (fetched unless given) and recompute Plus. Paid-up access ends at current_end.
 * Then the owner's alerts for what changed since the stored copy (alertRazorpayChanges); `skipStatusAlert` when the caller sends
 * its own alert for the status change (a start, a new charge or a new plan seen by the same sync is still alerted).
 */
export async function syncRazorpaySubscription(userId: string, subId: string, given?: any, opts: { skipStatusAlert?: boolean } = {}) {
  const s = given ?? await rzp('GET', `/subscriptions/${enc(subId)}`);
  if (s.id !== subId || !ours(s.notes, userId)) throw new Error('not_our_subscription');
  const token = `rzp:${subId}`;
  const [existing] = await sql`select user_id, ended_reason, raw->>'tablamigo_refund_id' as refund_id,
      raw->>'status' as old_status, raw->>'paid_count' as old_paid, raw->>'plan_id' as old_plan
    from subscriptions where purchase_token = ${token}`;
  if (existing && existing.userId !== userId) throw new Error('token_owned_by_other_user');
  // Ended by a refund, a chargeback or a halt (endSubscriptionRow): Razorpay still reports a paid-up current_end, which must not
  // bring Plus back. The copy of Razorpay's state is still refreshed, for the charge guard (lib/billing-reconcile.ts).
  if (existing?.endedReason || existing?.refundId) {
    await sql`update subscriptions set raw = ${sql.json({ ...s, ...(existing.refundId ? { tablamigo_refund_id: existing.refundId } : {}) })}, updated_at = now() where purchase_token = ${token}`;
    return { active: false, status: s.status as string, expiresAt: null };
  }
  const { status, expiresAt: expires } = razorpayRow(s);
  await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, raw)
    values (${token}, ${userId}, 'razorpay', 'tablamigo_plus', ${status}, ${expires}, ${sql.json(s)})
    on conflict (purchase_token) do update set status = excluded.status, expires_at = excluded.expires_at, raw = excluded.raw, updated_at = now()`;
  await recomputePlus(userId);
  alertRazorpayChanges(userId, s, existing ? { oldStatus: existing.oldStatus, oldPaid: existing.oldPaid, oldPlan: existing.oldPlan } : null, !!opts.skipStatusAlert);
  await applyRazorpayRules(userId, s);
  const cancelledNow = s.status === 'halted' || s.status === 'paused';
  return { active: !cancelledNow && status === ACTIVE && !!expires && expires > new Date(), status: s.status as string, expiresAt: expires };
}

const periodOfNotes = (n: any) => String(n?.product ?? '').replace(/^tablamigo_plus_/, '') || null;

/** Plus the user has beyond `from` (a Trip Pass or a comp), after recomputePlus: the emails name it so nobody thinks it's gone. */
export async function otherPlus(userId: string, from: Date | null): Promise<OtherPlus> {
  const [u] = await sql`select plus_until, comp_until from users where id = ${userId}`;
  const until = u?.plusUntil ? new Date(u.plusUntil) : null;
  const floor = Math.max(Date.now(), from?.getTime() ?? 0) + 60_000;
  if (!until || until.getTime() <= floor) return null;
  const comp = u.compUntil && Math.abs(new Date(u.compUntil).getTime() - until.getTime()) < 1000;
  return { until, source: comp ? 'comp' : 'pass' };
}

/**
 * What a Razorpay state means for us, beyond storing it. Runs after every sync (webhook, app, hourly reconcile), so each step
 * is idempotent and its email goes once per subscription. We never pause, and Razorpay never cancels a halted subscription by
 * itself, so both are cancelled at Razorpay now (rule 1) and stored as cancelled, which keeps exactly the time paid for:
 * - halted (SC-05): retries used up. The unpaid period gives no Plus (ended_reason 'halted'); one "renewal didn't go through"
 *   email. A halt inside a paid period (rare) keeps that period, with the usual cancelled email.
 * - paused (SC-16): the customer paused the mandate at their bank or UPI app. Paid time kept; one cancelled email naming it.
 */
async function applyRazorpayRules(userId: string, s: any) {
  if (s.status !== 'halted' && s.status !== 'paused') return;
  const c = await cancelAtRazorpay(s.id);
  const after = c?.id === s.id && razorpayEnded(c) ? c : { ...s, ...(c?.id === s.id ? c : {}), status: 'cancelled' };
  const status = RAZORPAY_STATE.cancelled;
  const end = s.status === 'halted' ? haltedPaidThrough(s) : paidThrough(s);
  const expiresAt = end > 0 ? new Date(end * 1000) : null;
  const until = expiresAt && expiresAt > new Date() ? expiresAt : null;
  await sql`update subscriptions set status = ${status}, expires_at = ${expiresAt}, raw = ${sql.json(after)},
      ended_reason = ${s.status === 'halted' && !until ? 'halted' : null}, updated_at = now()
    where purchase_token = ${'rzp:' + s.id} and ended_reason is null`;
  await recomputePlus(userId);
  const period = periodOfNotes(s.notes);
  if (s.status === 'paused') {
    await emailPlusCancelled(userId, s.id, { period, until, endedAt: new Date(), otherPlus: await otherPlus(userId, until), paused: true });
    alertRazorpaySubscription('cancelled', `rzp:cancelled:${s.id}`, userId, s.id, [['Why', 'the customer paused the mandate; we cancelled it'], ['Plus until', until ? istDate(until) : 'ended now']], after);
    return;
  }
  // The owner's "Renewal halted" alert (alertRazorpayChanges) covers the halt. The customer hears of a halt that is news (the
  // cycle it failed at ended in the last 10 days, as for that alert), not of one the hourly sync finds in history.
  if (Number(s.current_end) * 1000 < Date.now() - HALT_NEWS_MS) return;
  if (!until) await emailPlusPaymentStopped(userId, s.id, { period, otherPlus: await otherPlus(userId, null) });
  else await emailPlusCancelled(userId, s.id, { period, until, endedAt: new Date(), otherPlus: await otherPlus(userId, until) });
}
const HALT_NEWS_MS = 10 * 86400_000;

// --- owner sale alerts (lib/owner-alerts.ts) -----------------------------------------------------------------------------------
/** A status Razorpay moved a subscription to, and the alert (kind, key) it gets. One per billing cycle where it can repeat. */
const STATUS_ALERTS: Record<string, (s: any) => [SaleKind, string]> = {
  pending: s => ['renewal_failed', `rzp:pending:${s.id}:${Number(s.current_end) || 0}`],
  halted: s => ['halted', `rzp:halted:${s.id}:${Number(s.current_end) || 0}`],
  cancelled: s => ['cancelled', `rzp:cancelled:${s.id}`],
  completed: s => ['ended', `rzp:ended:${s.id}`],
  expired: s => ['ended', `rzp:ended:${s.id}`],
};

/**
 * Only news is alerted: a subscription first seen, a charge, or an end Razorpay dates more than this long ago (a stored copy that
 * fell behind, a checkout verified long after it was paid) is history, not a sale to hear about now.
 */
const RECENT_SECONDS = 3 * 86400;
const recent = (unix: unknown) => Number(unix) > Date.now() / 1000 - RECENT_SECONDS;
/** At most this many charges are alerted from one sync that finds several (paid_count jumped while every forward was lost). */
const MAX_CHARGES_PER_SYNC = 5;

/**
 * The owner's alerts for what changed since the stored copy of a subscription: started, new charges (paid_count went up), a new
 * status, a new plan. Every path that stores Razorpay's state comes through syncRazorpaySubscription (the app's verify call, the
 * forwarded webhook, GET /billing/plans and the 6-hourly pull), so a renewal still alerts when Hookpost's forward is down. The
 * keys are the same whichever path sees the change first; a redelivered event finds nothing changed. A stored copy without a
 * status or paid_count is no baseline: nothing is compared with it.
 */
function alertRazorpayChanges(userId: string, s: any, before: { oldStatus: string | null; oldPaid: string | null; oldPlan: string | null } | null, skipStatus: boolean) {
  const paid = Number(s.paid_count) || 0;
  if (!before && ['authenticated', 'active'].includes(s.status) && recent(s.created_at)) {
    alertRazorpaySubscription('subscription_started', `rzp:sub_started:${s.id}`, userId, s.id, [], s);
  }
  const oldPaid = before ? (before.oldPaid == null ? null : Number(before.oldPaid) || 0) : 0;
  if (oldPaid != null && paid > oldPaid) alertNewCharges(userId, s.id, Math.min(paid - oldPaid, MAX_CHARGES_PER_SYNC));
  // An end is dated by ended_at. A failed or halted renewal has no date of its own: the cycle it failed at (current_end) must
  // have ended in the last 10 days (Razorpay retries a failed charge for a few days, then halts).
  const ended = ['cancelled', 'completed', 'expired'].includes(s.status);
  const stuck = ['pending', 'halted'].includes(s.status);
  const fresh = ended ? !Number(s.ended_at) || recent(s.ended_at) : stuck ? !Number(s.current_end) || Number(s.current_end) > Date.now() / 1000 - 10 * 86400 : true;
  const change = !skipStatus && before?.oldStatus && before.oldStatus !== s.status && fresh ? STATUS_ALERTS[s.status]?.(s) : null;
  if (change) alertRazorpaySubscription(change[0], change[1], userId, s.id, [], s);
  if (before?.oldPlan && typeof s.plan_id === 'string' && s.plan_id !== before.oldPlan) {
    alertRazorpaySubscription('plan_change', `rzp:plan:${s.id}:${paid}:${s.plan_id}`, userId, s.id, [['Previous plan', planProduct(before.oldPlan) ?? 'another plan']], s);
  }
}

/** Our Plus plans by Razorpay plan id. */
const planPeriod = (planId: unknown): Period | null => (typeof planId === 'string' && planId ? PERIODS.find(p => planIdOf(p) === planId) : null) ?? null;
const planProduct = (planId: unknown) => { const p = planPeriod(planId); return p ? razorpayProduct(`tablamigo_plus_${p}`) : null; };
const periodOf = (s: any): Period | null => {
  const n = String(s?.notes?.product ?? '').replace(/^tablamigo_plus_/, '');
  return planPeriod(s?.plan_id) ?? (PERIODS.includes(n as Period) ? n as Period : null);
};

/**
 * Charge alerts for the newest `count` paid invoices of a subscription, recent ones only (the sync knows charges happened, not
 * which). Each is keyed on its payment, so one already alerted by subscription.charged or another path is a duplicate.
 */
function alertNewCharges(userId: string, subId: string, count: number) {
  ownerSaleAlertLookup(async () => {
    const inv = await rzp('GET', `/invoices?subscription_id=${enc(subId)}&count=${Math.min(count + 5, 50)}`);
    return (inv?.items ?? []).filter((i: any) => typeof i?.payment_id === 'string' && i.status === 'paid')
      .sort((a: any, b: any) => (Number(b.paid_at) || 0) - (Number(a.paid_at) || 0)).slice(0, count)
      .filter((i: any) => recent(i.paid_at))
      .map((i: any) => ({ key: `rzp:pay:${i.payment_id}`, build: () => subscriptionChargeEvent(userId, subId, i.payment_id) }));
  });
}

/** The charge alert for one subscription payment (subscription.charged names it). Keyed on the payment id. */
export function alertSubscriptionCharge(userId: string, subId: string, payId: string) {
  ownerSaleAlert(`rzp:pay:${payId}`, () => subscriptionChargeEvent(userId, subId, payId));
}

/**
 * Razorpay is asked for the payment (it must be captured), the subscription (ours, this user's) and the invoice that ties them
 * together; anything else is not alerted.
 */
async function subscriptionChargeEvent(userId: string, subId: string, payId: string): Promise<SaleEvent | null> {
  const [pay, s] = await Promise.all([rzp('GET', `/payments/${enc(payId)}`), rzp('GET', `/subscriptions/${enc(subId)}`)]);
  if (pay?.id !== payId || pay.status !== 'captured' || s?.id !== subId || !ours(s.notes, userId)) return null;
  const inv = pay.invoice_id ? await rzp('GET', `/invoices/${enc(pay.invoice_id)}`).catch(() => null) : null;
  if (inv ? inv.subscription_id !== subId : !ours(pay.notes, userId)) return null;
  // Which charge this is, from its place among the subscription's paid invoices (not from paid_count now, which a later renewal
  // may already have moved on). Without an invoice list, paid_count is the best guess.
  const list = await rzp('GET', `/invoices?subscription_id=${enc(subId)}&count=100`).catch(() => null);
  const paidOrder = (list?.items ?? []).filter((i: any) => i?.status === 'paid' && typeof i.payment_id === 'string')
    .sort((a: any, b: any) => (Number(a.paid_at) || 0) - (Number(b.paid_at) || 0)).map((i: any) => i.payment_id as string);
  const n = paidOrder.includes(payId) ? paidOrder.indexOf(payId) + 1 : Number(s.paid_count) || null;
  return {
    kind: n != null && n > 1 ? 'renewal' : 'first_charge', provider: 'razorpay', userId, product: planProduct(s.plan_id) ?? razorpayProduct(s.notes?.product),
    amountMinor: Number(pay.amount), currency: pay.currency, ids: { paymentId: payId, subscriptionId: subId, invoiceId: pay.invoice_id, orderId: pay.order_id },
    test: razorpayTest(), at: Number(pay.created_at) > 0 ? new Date(Number(pay.created_at) * 1000) : null,
    details: [['Charge number', n != null ? String(n) : null], ['Paid up until', unixDate(s.current_end)], ['Next charge', unixDate(s.charge_at)]],
  };
}

/**
 * End a subscription's Plus now, for good: a refund (any amount, SC-10), a chargeback (SC-13) or a halted renewal (SC-05).
 * ended_reason keeps later syncs (which see Razorpay's paid-up current_end) from bringing it back. `refundId` is kept on the row
 * for support. Returns false when the row was already ended.
 */
export async function endSubscriptionRow(userId: string, subId: string, reason: 'refund' | 'dispute' | 'halted', refundId?: string) {
  const rows = await sql`update subscriptions set status = 'SUBSCRIPTION_STATE_EXPIRED', expires_at = least(coalesce(expires_at, now()), now()),
      ended_reason = coalesce(ended_reason, ${reason}),
      raw = coalesce(raw, '{}'::jsonb) || ${sql.json(refundId ? { tablamigo_refund_id: refundId } : {})}, updated_at = now()
    where purchase_token = ${'rzp:' + subId} and user_id = ${userId} and ended_reason is null returning 1`;
  await recomputePlus(userId);
  return rows.length > 0;
}

export async function verifyRazorpaySubscription(userId: string, subId: string, paymentId: string, signature: string) {
  if (!signatureOk(`${paymentId}|${subId}`, signature)) throw new Error('bad_signature');
  // One verify per account at a time, so two checkouts finished at once can't each see the other and both be refused.
  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtext(${'rzp-verify:' + userId}))`;
    const [before] = await sql`select cancel_requested_at, ended_reason from subscriptions where purchase_token = ${'rzp:' + subId}`;
    // The sync alerts the start and the first charge (alertRazorpayChanges), with the keys the forwarded webhook uses.
    const result = await syncRazorpaySubscription(userId, subId);
    if (!before?.cancelRequestedAt && !before?.endedReason && (await refuseSecondSubscription(userId, subId, paymentId))) return { ...result, active: false, refused: 'second_subscription' };
    return result;
  });
}

/** A second subscription is only refused while it is this new; an older one replayed through verify is left alone. */
export const SECOND_SUB_WINDOW_SECONDS = 86400;

/**
 * Two checkouts finished side by side (two tabs, a double click that opened two): only one web subscription may renew. The one
 * verified second (verifies are serialised per account) is cancelled at Razorpay now and, if it took a charge, that charge is
 * refunded in full (our mistake, so no fee is kept) and its Plus ended. Only a subscription and payment made in the last
 * SECOND_SUB_WINDOW_SECONDS qualify, so replaying an old checkout's saved signature never refunds time already used. A
 * Reactivate subscription following a cancelled one is not a second one. Returns whether it refused this one.
 */
async function refuseSecondSubscription(userId: string, subId: string, paymentId: string): Promise<boolean> {
  const nowSec = Math.floor(Date.now() / 1000);
  const [mine] = await sql`select (raw->>'created_at')::bigint as created_at from subscriptions where purchase_token = ${'rzp:' + subId}`;
  if (!(Number(mine?.createdAt) > nowSec - SECOND_SUB_WINDOW_SECONDS)) return false;
  const [other] = await sql`select purchase_token from subscriptions s where s.user_id = ${userId} and s.platform = 'razorpay'
      and s.purchase_token <> ${'rzp:' + subId} and s.cancel_requested_at is null and s.ended_reason is null
      and ((s.status in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') and s.expires_at > now()) or ${waitingToStart()})
    order by s.updated_at limit 1`;
  if (!other) return false;
  const s = await cancelAtRazorpay(subId);
  await sql`update subscriptions set cancel_requested_at = coalesce(cancel_requested_at, now()) where purchase_token = ${'rzp:' + subId}`;
  await syncRazorpaySubscription(userId, subId, s?.id === subId ? s : undefined, { skipStatusAlert: true });
  let refund: string | null = null;
  const pay = Number(s?.paid_count ?? 0) > 0 ? await rzp('GET', `/payments/${enc(paymentId)}`).catch(() => null) : null;
  if (pay?.status === 'captured' && Number(pay.created_at) > nowSec - SECOND_SUB_WINDOW_SECONDS && !(Number(pay.amount_refunded) > 0)) {
    refund = await rzp('POST', `/payments/${enc(paymentId)}/refund`, { notes: { service: SERVICE, reason: 'second_subscription' } })
      .then(async r => { await endSubscriptionRow(userId, subId, 'refund', r?.id); return `refunded in full (${r?.id ?? 'refund'})`; },
        e => `refund FAILED (${String(e?.message ?? e).slice(0, 100)}): refund it by hand`);
  } else if (Number(s?.paid_count ?? 0) > 0) refund = 'not refunded automatically (payment not readable, not captured or not new): check it';
  alertRazorpaySubscription('cancelled', `rzp:cancelled:${subId}`, userId, subId,
    [['Why', `a second web subscription; ${other.purchaseToken.slice(4)} already renews`], ['Its charge', refund ?? 'none taken']], s?.id === subId ? s : undefined);
  return true;
}

/** Kinds whose alert shows the plan's price (they move no money themselves); a charge or refund shows the payment instead. */
const PLAN_PRICE_KINDS: SaleKind[] = ['subscription_started', 'plan_change', 'cancel_requested', 'cancelled', 'ended', 'renewal_failed', 'halted'];

/**
 * Owner alert about one of our Razorpay subscriptions, built from Razorpay's own copy of it (fetched when the alert is built,
 * off the caller's path, unless `given` is that copy): nothing is sent unless it is ours and this user's.
 */
export function alertRazorpaySubscription(kind: SaleKind, key: string, userId: string, subId: string, extra: [string, string | null | undefined][] = [], given?: any) {
  ownerSaleAlert(key, async () => {
    const s = given ?? await rzp('GET', `/subscriptions/${enc(subId)}`);
    if (s?.id !== subId || !ours(s.notes, userId)) return null;
    const period = periodOf(s);
    const price = PLAN_PRICE_KINDS.includes(kind) && period ? RAZORPAY_PRICES[period] : null;
    return {
      kind, provider: 'razorpay', userId, product: planProduct(s.plan_id) ?? razorpayProduct(s.notes?.product),
      amountMinor: price, currency: price ? RAZORPAY_PRICES.currency : null,
      amountNote: price ? `plan price per ${period === 'yearly' ? 'year' : period === 'halfyearly' ? '6 months' : 'month'}; not a charge` : null,
      ids: { subscriptionId: subId }, test: razorpayTest(),
      at: (kind === 'cancelled' || kind === 'ended') && Number(s.ended_at) > 0 ? new Date(Number(s.ended_at) * 1000) : null,
      details: [['Razorpay status', String(s.status ?? '')], ['Charges paid', s.paid_count != null ? String(s.paid_count) : null],
        ['Paid up until', unixDate(s.current_end)], ['Next charge', ['active', 'authenticated', 'pending'].includes(s.status) ? unixDate(s.charge_at) : null], ...extra],
    };
  });
}

/**
 * A Reactivate subscription waiting for its first charge (startsLater) as SQL: it renews, but has no expires_at of its own yet.
 * `s` is the subscriptions row alias.
 */
export const waitingToStart = (alias = 's') => sql`(${sql(alias)}.platform = 'razorpay' and ${sql(alias)}.status = ${ACTIVE} and ${sql(alias)}.expires_at is null
  and ${sql(alias)}.ended_reason is null and ${sql(alias)}.raw->>'status' = 'authenticated' and (${sql(alias)}.raw->>'start_at')::bigint > extract(epoch from now()))`;

/**
 * The caller's web subscription: the one that renews (a Reactivate one still waiting for its first charge counts, with the
 * date it starts), else the latest one with paid time left. `paidEnd` is where the time paid for so far ends.
 */
export async function liveRazorpaySub(userId: string) {
  const rows = await sql`select purchase_token, status, expires_at, cancel_requested_at, (s.raw->>'start_at')::bigint as start_at, ${waitingToStart()} as waiting
    from subscriptions s where s.user_id = ${userId} and s.ended_reason is null
      and ((s.platform = 'razorpay' and s.expires_at > now() and s.status in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED')) or ${waitingToStart()})
    order by expires_at desc nulls last`;
  const paid = rows.find(r => !r.waiting);
  const pick = rows.find(r => r.waiting && !r.cancelRequestedAt) ?? rows.find(r => !r.waiting && r.status !== 'SUBSCRIPTION_STATE_CANCELED' && !r.cancelRequestedAt) ?? paid;
  if (!pick) return null;
  const expiresAt = (pick.waiting ? new Date(Number(pick.startAt) * 1000) : pick.expiresAt) as Date;
  return { id: (pick.purchaseToken as string).slice(4), expiresAt, cancelled: pick.status === 'SUBSCRIPTION_STATE_CANCELED' || !!pick.cancelRequestedAt,
    waiting: !!pick.waiting, paidEnd: (paid?.expiresAt as Date | undefined) ?? null };
}

/**
 * Cancel (SC-06): stopped at Razorpay now, Plus kept to the end of the paid period, one email. If the current period's payment
 * was refunded (a refund webhook that never arrived, SC-11), Plus ends now instead. `email: false` when the caller's own email
 * says it (account deletion).
 */
export async function cancelRazorpaySubscription(userId: string, { email = true }: { email?: boolean } = {}) {
  const live = await liveRazorpaySub(userId);
  if (!live) throw new Error('no_subscription');
  if (live.cancelled) return { ok: true, expiresAt: live.expiresAt };
  const refundId = await currentPeriodRefund(live.id);
  const s = await cancelAtRazorpay(live.id);
  await sql`update subscriptions set cancel_requested_at = coalesce(cancel_requested_at, now()) where purchase_token = ${'rzp:' + live.id}`;
  // Its "cancelled" alert is this one (same key as the webhook's): one alert for one cancel.
  alertRazorpaySubscription('cancel_requested', `rzp:cancelled:${live.id}`, userId, live.id,
    [['Plus until', refundId ? 'ended now (the current period was refunded)' : istDate(live.paidEnd)], ['Requested in', 'the Tablamigo app']], s?.id === live.id ? s : undefined);
  await syncRazorpaySubscription(userId, live.id, s?.id === live.id ? s : undefined, { skipStatusAlert: true });
  if (refundId) await endSubscriptionRow(userId, live.id, 'refund', refundId);
  // A Reactivate subscription that never charged has no time of its own: Plus runs to the end of the one it followed.
  const [row] = await sql`select expires_at, ended_reason from subscriptions where purchase_token = ${'rzp:' + live.id}`;
  const end = refundId || row?.endedReason ? null : live.waiting ? live.paidEnd : row?.expiresAt ? new Date(row.expiresAt) : null;
  const until = end && end > new Date() ? end : null;
  if (email) await emailPlusCancelled(userId, live.id, { period: periodOfNotes(s?.notes), until, endedAt: new Date(), otherPlus: await otherPlus(userId, until) });
  return { ok: true, expiresAt: until ?? live.paidEnd ?? live.expiresAt };
}

/** A refund on the payment for this subscription's current, unfinished period, if there is one (SC-11). */
export async function currentPeriodRefund(subId: string): Promise<string | null> {
  // Unreadable counts as none: the hourly refund sweep (lib/billing-reconcile.ts) still finds the refund and ends the plan.
  const inv = await rzp('GET', `/invoices?subscription_id=${enc(subId)}&count=10`).catch(() => null);
  for (const i of inv?.items ?? []) {
    if (!i?.payment_id || Number(i.billing_end ?? 0) * 1000 <= Date.now()) continue;
    const pay = await rzp('GET', `/payments/${enc(i.payment_id)}`).catch(() => null);
    if (Number(pay?.amount_refunded ?? 0) > 0) {
      const refunds = await rzp('GET', `/payments/${enc(i.payment_id)}/refunds`).catch(() => null);
      return refunds?.items?.[0]?.id ?? `payment:${i.payment_id}`;
    }
  }
  return null;
}

/**
 * Pull Razorpay's state of open subscriptions (Hookpost's forward can be lost). With a user id, only that user's subs not
 * checked in the last 5 minutes (GET /billing/plans); without, everything still open (the hourly lib/billing-reconcile.ts).
 */
export async function syncRazorpay(userId?: string) {
  if (!razorpayOn()) return;
  const subs = await sql`select purchase_token, user_id from subscriptions where platform = 'razorpay' and ended_reason is null
    and status <> 'SUBSCRIPTION_STATE_EXPIRED' and (status <> 'SUBSCRIPTION_STATE_CANCELED' or expires_at > now())
    ${userId ? sql`and user_id = ${userId} and (updated_at < now() - interval '5 minutes' or expires_at is null)` : sql``}`;
  for (const s of subs) await syncRazorpaySubscription(s.userId, s.purchaseToken.slice(4)).catch(e => console.error('razorpay sync failed', s.purchaseToken, e.message));
  if (userId) return;
  const passes = await sql`select purchase_token from passes where purchase_token like 'rzp:%' and voided_at is null and expires_at > now()`;
  for (const p of passes) {
    const pay = await rzp('GET', `/payments/${enc(p.purchaseToken.slice(4))}`).catch(() => null);
    if (pay?.status === 'refunded') {
      await voidPass(p.purchaseToken, false);
      await voidCommission(`rzp:pay:${pay.id}`, 'refund');
    }
  }
}
