/**
 * Razorpay events for Tablamigo, forwarded by Hookpost's webhook (one Razorpay account serves Hookpost,
 * Tablamigo and VetNow, and only Hookpost has a webhook). Hookpost signs the raw body with
 * TABLAMIGO_FORWARD_SECRET.
 *
 * The event is only a nudge: every object is re-read from Razorpay and must carry
 * notes.service = 'tablamigo' before anything changes (a renewal charge has none of its own, so its
 * subscription must). Handlers are idempotent (email_log keys, upserts),
 * because Razorpay retries and sends refund.created and refund.processed for the same refund.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { sql } from './db.js';
import { rzp, SERVICE, ours, syncRazorpaySubscription, endSubscriptionRow, alertRazorpaySubscription, alertSubscriptionCharge, cancelAtRazorpay, currentPeriodRefund, otherPlus } from './razorpay.js';
import { recomputePlus, voidPass, PASS_SKU } from './play.js';
import { emailPlusCancelled, emailRefundIssued } from './emails/events.js';
import { money } from './emails/templates.js';
import { ownerSaleAlert, razorpayTest, razorpayProduct, istDate } from './owner-alerts.js';
import { razorpayRow, razorpayEnded, isDisputeEvent, isTransient } from './billing-policy.js';
import { handleDispute } from './billing-disputes.js';
import { voidCommission, hasAffiliateReferral } from './affiliate-ledger.js';
import { accrueRazorpayPayment } from './affiliates.js';

const enc = encodeURIComponent;

export function forwardSignatureOk(rawBody: string, signature: unknown) {
  if (!config.razorpay.forwardSecret || typeof signature !== 'string') return false;
  const want = Buffer.from(crypto.createHmac('sha256', config.razorpay.forwardSecret).update(rawBody).digest('hex'));
  const got = Buffer.from(signature);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

const periodOf = (notes: any) => String(notes?.product ?? '').replace(/^tablamigo_plus_/, '') || null;
const at = (unix: unknown) => (Number(unix) > 0 ? new Date(Number(unix) * 1000) : null);

const userExists = async (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)
  && !!(await sql`select 1 from users where id = ${id}`)[0];

/**
 * subscription.cancelled: store the state (Plus runs on to the end of the paid period, as the app's own cancel does) and
 * email once (the app's Cancel sends the same email under the same key). If that period's payment was already refunded, Plus
 * from the subscription ends now instead. A subscription a refund, a chargeback or a halt already ended has had its email.
 */
export async function handleSubscriptionCancelled(subId: string) {
  const s = await rzp('GET', `/subscriptions/${enc(subId)}`);
  const userId = s?.notes?.user_id;
  if (s?.notes?.service !== SERVICE || !(await userExists(userId))) return 'not_ours';
  if (s.status !== 'cancelled') return 'not_cancelled';
  const [row] = await sql`select ended_reason from subscriptions where purchase_token = ${'rzp:' + subId} and user_id = ${userId}`;
  if (row?.endedReason) { await syncRazorpaySubscription(userId, subId, s, { skipStatusAlert: true }); return `cancelled:${row.endedReason}`; }

  const refundId = await currentPeriodRefund(subId);
  // The owner's alert for this cancellation is the one below, with what the sync can't know (skipStatusAlert); a charge or a
  // start the same sync finds is still alerted.
  if (refundId) {
    // The row may not exist yet if the checkout was never verified; sync creates it, then end it.
    await syncRazorpaySubscription(userId, subId, s, { skipStatusAlert: true }).catch(() => undefined);
    await endSubscriptionRow(userId, subId, 'refund', refundId);
  } else {
    await syncRazorpaySubscription(userId, subId, s, { skipStatusAlert: true });
  }
  const paidEnd = razorpayRow(s).expiresAt;
  const until = !refundId && paidEnd && paidEnd.getTime() > Date.now() ? paidEnd : null;
  const outcome = await emailPlusCancelled(userId, subId, {
    period: periodOf(s.notes), until, endedAt: at(s.ended_at) ?? new Date(), otherPlus: await otherPlus(userId, until),
  });
  alertRazorpaySubscription('cancelled', `rzp:cancelled:${subId}`, userId, subId,
    [['Plus until', until ? istDate(until) : 'ended now'], ['Current period refunded', refundId ? 'yes' : null]], s);
  return `cancelled:${outcome}`;
}

/** The refunded payment as the owner reads it (the refund entity has no notes; the payment's decide). */
function alertRefund(userId: string, r: any, pay: any, product: string, extra: [string, string | null | undefined][] = [], subscriptionId?: string) {
  ownerSaleAlert(`rzp:refund:${r.id}`, () => ({
    kind: 'refund', provider: 'razorpay', userId, product, amountMinor: Number(r.amount), currency: r.currency ?? 'INR',
    amountNote: Number(pay.amount) > Number(r.amount) ? `partial, of a ${money(Number(pay.amount), pay.currency ?? 'INR')} payment` : null,
    ids: { refundId: r.id, paymentId: pay.id, orderId: pay.order_id, invoiceId: pay.invoice_id, subscriptionId },
    test: razorpayTest(), at: at(r.created_at), details: extra,
  }));
}

/**
 * refund.processed (or refund.created that Razorpay already reports as processed); the hourly sweep replays missed ones.
 * A Trip Pass is voided. Any refund on a subscription payment, of any amount and any period, ends that subscription now
 * (rule 4, owner 29 Oct: "refund means refund"): cancelled at Razorpay and its Plus ended. If Razorpay refuses the cancel,
 * Plus still ends here and the charge guard (lib/billing-reconcile.ts) retries the cancel every hour.
 * The mandate check Razorpay takes and refunds by itself when a Reactivate subscription is approved has no invoice: not ours to act on.
 */
export async function handleRefund(refundId: string, type = 'refund.processed') {
  const r = await rzp('GET', `/refunds/${enc(refundId)}`);
  if (r?.status !== 'processed') return type === 'refund.created' ? 'pending' : `refund_${r?.status}`;
  const pay = await rzp('GET', `/payments/${enc(r.payment_id)}`);
  // Razorpay sends notes as [] when there are none.
  const notes = pay?.notes && typeof pay.notes === 'object' && !Array.isArray(pay.notes) ? pay.notes : {};
  if (notes.service && notes.service !== SERVICE) return 'not_ours';
  const inv = pay?.invoice_id ? await rzp('GET', `/invoices/${enc(pay.invoice_id)}`).catch(() => null) : null;
  const sub = inv?.subscription_id ? await rzp('GET', `/subscriptions/${enc(inv.subscription_id)}`).catch(() => null) : null;
  // Only a subscription's first charge carries our notes (Checkout passes them). Razorpay does not copy a subscription's notes
  // onto its renewal charges (live, 26 Oct: every later charge on the account has notes []), so an untagged payment is ours
  // only when its invoice's subscription is.
  const userId = notes.service ? notes.user_id : sub?.notes?.service === SERVICE ? sub.notes.user_id : undefined;
  // Any refund on a payment voids a partner's commission on it (clawed back if already paid out). Only our payments can have one.
  if (notes.service === SERVICE || sub?.notes?.service === SERVICE) await voidCommission(`rzp:pay:${pay.id}`, 'refund');
  if (!(await userExists(userId))) return 'not_ours';

  const base = { amountMinor: Number(r.amount), currency: r.currency ?? 'INR', refundId: r.id, paymentId: pay.id, refundedAt: at(r.created_at) ?? new Date() };
  if (notes.product === PASS_SKU) {
    await voidPass(`rzp:${pay.id}`, false);
    await recomputePlus(userId);
    alertRefund(userId, r, pay, razorpayProduct(PASS_SKU), [['Trip Pass', 'voided']]);
    return `pass:${await emailRefundIssued(userId, { ...base, what: 'pass', plus: 'ended', otherPlus: await otherPlus(userId, null) })}`;
  }

  if (!sub && !pay?.invoice_id && /^tablamigo_plus_/.test(String(notes.product ?? ''))) return 'mandate_check';
  if (!sub || sub.notes?.service !== SERVICE || sub.notes?.user_id !== userId) {
    // Money still went back to a Tablamigo customer (an event ticket, or a payment we can't place): the owner hears of it.
    alertRefund(userId, r, pay, razorpayProduct(notes.product));
    return 'no_subscription';
  }

  let cancelNote: string | null = null;
  if (!razorpayEnded(sub)) {
    await cancelAtRazorpay(sub.id).catch(e => { cancelNote = `Razorpay refused the cancel (${String(e?.message ?? e).slice(0, 120)}): cancel it by hand; the hourly guard retries`; });
  }
  // The row may not exist yet (a checkout never verified): sync creates it, then it is ended.
  await syncRazorpaySubscription(userId, sub.id, sub, { skipStatusAlert: true }).catch(() => undefined);
  await endSubscriptionRow(userId, sub.id, 'refund', r.id);
  alertRefund(userId, r, pay, razorpayProduct(sub.notes?.product), [['Plus from it', 'ended now; subscription cancelled'], ['Cancel', cancelNote]], sub.id);
  return `subscription:${await emailRefundIssued(userId, {
    ...base, what: 'subscription', period: periodOf(sub.notes), plus: 'ended', renewsOn: null, otherPlus: await otherPlus(userId, null),
  })}`;
}

/**
 * payment.captured / order.paid for a one-time purchase (Trip Pass, event ticket): keyed on the payment id, like the app's own
 * verify call, so the owner hears of the sale even if the buyer closed the page before the app confirmed it. The order Razorpay
 * holds (made by our API, notes.service = 'tablamigo') decides what was bought and by whom. Subscription payments are left to
 * subscription.charged.
 */
function alertOneTimePayment(payId: string) {
  ownerSaleAlert(`rzp:pay:${payId}`, async () => {
    const pay = await rzp('GET', `/payments/${enc(payId)}`);
    if (pay?.id !== payId || pay.status !== 'captured' || !pay.order_id) return null;
    const order = await rzp('GET', `/orders/${enc(pay.order_id)}`);
    const userId = order?.notes?.user_id;
    if (order?.id !== pay.order_id || order.notes?.service !== SERVICE || !(await userExists(userId))) return null;
    if (pay.notes?.service && !ours(pay.notes, userId)) return null;
    const product = order.notes.product;
    if (product !== PASS_SKU && product !== 'activity_ticket') return null;
    const [plan] = product === 'activity_ticket' && /^[0-9a-f-]{36}$/.test(String(order.notes.activity_id ?? ''))
      ? await sql`select title from activities where id = ${order.notes.activity_id}` : [];
    return {
      kind: product === PASS_SKU ? 'pass_purchase' : 'ticket_purchase', provider: 'razorpay', userId, product: razorpayProduct(product),
      amountMinor: Number(pay.amount), currency: pay.currency, ids: { paymentId: payId, orderId: pay.order_id }, test: razorpayTest(), at: at(pay.created_at),
      details: [['Event', plan?.title ?? null]],
    };
  });
}

/** Route entry point. Unknown or foreign events are acknowledged and ignored. */
export async function handleRazorpayEvent(event: any): Promise<string> {
  const type = String(event?.event ?? '');
  const p = event?.payload ?? {};
  if (type === 'subscription.cancelled' && p.subscription?.entity?.id) return handleSubscriptionCancelled(p.subscription.entity.id);
  if ((type === 'refund.processed' || type === 'refund.created') && p.refund?.entity?.id) return handleRefund(p.refund.entity.id, type);
  if (isDisputeEvent(type) && typeof p.dispute?.entity?.id === 'string') return handleDispute(p.dispute.entity.id);
  // Renewals, halts and the rest: store the fresh state now instead of waiting for the 6-hourly sync. The sync's owner alerts
  // cover what changed (started, a new charge, a failed or halted renewal, the end, a new plan); subscription.charged also names
  // its payment, which is alerted directly (same key as the sync's).
  const sub = p.subscription?.entity;
  if (type.startsWith('subscription.') && sub?.id && sub.notes?.service === SERVICE && (await userExists(sub.notes.user_id))) {
    await syncRazorpaySubscription(sub.notes.user_id, sub.id);
    const payId = p.payment?.entity?.id;
    if (type === 'subscription.charged' && typeof payId === 'string' && /^pay_[A-Za-z0-9]{6,40}$/.test(payId)) {
      alertSubscriptionCharge(sub.notes.user_id, sub.id, payId);
      // Only a partner's customer (or a coupon on the subscription) is worth asking Razorpay about.
      if (sub.notes.affiliate_code || (await hasAffiliateReferral(sub.notes.user_id))) await affiliateCommission(payId, true);
    }
    return 'synced';
  }
  // A one-time purchase (Trip Pass, ticket): only the owner alert; the app's verify call grants what was bought.
  const payId = p.payment?.entity?.id;
  if ((type === 'payment.captured' || type === 'order.paid') && typeof payId === 'string' && /^pay_[A-Za-z0-9]{6,40}$/.test(payId)) {
    alertOneTimePayment(payId);
    // A web Trip Pass: the checkout's verify call records it too, so an outage here is only logged.
    await affiliateCommission(payId, false);
  }
  return 'ignored';
}

/**
 * A partner's commission on a payment (lib/affiliates.ts re-reads it from Razorpay; idempotent on the payment id). With `retry`,
 * Razorpay unreachable is thrown, so the event is answered 500 and forwarded again. Anything else is logged and never fails the event.
 */
async function affiliateCommission(payId: string, retry: boolean) {
  await accrueRazorpayPayment(payId).catch(e => {
    if (retry && isTransient(e)) throw e;
    console.error('affiliate commission failed', payId, (e as Error).message);
  });
}
