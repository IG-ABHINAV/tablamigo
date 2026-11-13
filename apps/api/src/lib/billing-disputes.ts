/**
 * Chargebacks on web (Razorpay) payments: SC-13 to SC-15 of Hookpost's docs/billing/SCENARIOS.md, mapped in
 * docs/billing-scenarios.md. Google Play chargebacks are Google's to fight; lib/play.ts handlePlayVoidedSubscription ends the
 * Plus they paid for.
 *
 * A dispute reaches us two ways: a forwarded payment.dispute.* event (if Hookpost forwards it) and the hourly sweep of
 * Razorpay's disputes list (lib/billing-reconcile.ts), so a lost or never-forwarded event is still caught within the hour.
 * Either way the dispute is re-read from Razorpay, and the payment must be ours (its notes, or its invoice's subscription).
 *
 * The first time we see a dispute (until that work has once fully succeeded, billing_disputes.handled_at): the account is locked (users.billing_disputed_at: no Plus from web purchases or comps, web
 * checkout refused), the subscription it paid is ended now (ended_reason 'dispute') and every web subscription of the account
 * that could still charge is cancelled at Razorpay, a Trip Pass it paid is voided, one neutral email goes to the customer and
 * the owner is alerted. Later events of the same dispute (under_review, won, lost) only alert the owner: winning never
 * restores anything by itself, and only an admin clears the lock (routes/admin.ts).
 */
import { sql } from './db.js';
import { rzp, SERVICE, cancelAtRazorpay, endSubscriptionRow } from './razorpay.js';
import { recomputePlus, voidPass, PASS_SKU } from './play.js';
import { CHARGEABLE, isTransient } from './billing-policy.js';
import { emailBillingDisputed } from './emails/events.js';
import { ownerSaleAlert, razorpayTest, razorpayProduct, istDate } from './owner-alerts.js';
import { voidCommission } from './affiliate-ledger.js';

const enc = encodeURIComponent;
const at = (unix: unknown) => (Number(unix) > 0 ? new Date(Number(unix) * 1000) : null);
const plainNotes = (n: any) => (n && typeof n === 'object' && !Array.isArray(n) ? n : {});
/** A Razorpay read where "not there" (4xx) is an answer and an outage throws, so the caller answers 5xx and is retried. */
const read = (path: string) => rzp('GET', path).catch(e => { if (isTransient(e)) throw e; return null; });
const isUser = async (id: unknown) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) && !!(await sql`select 1 from users where id = ${id}`)[0];

/** Whose payment is this, and what did it pay for? null when it isn't one of ours. */
export async function placePayment(pay: any): Promise<{ userId: string; sub: any | null; product: string | null } | null> {
  const notes = plainNotes(pay?.notes);
  if (notes.service && notes.service !== SERVICE) return null;
  const inv = pay?.invoice_id ? await read(`/invoices/${enc(pay.invoice_id)}`) : null;
  const sub = inv?.subscription_id ? await read(`/subscriptions/${enc(inv.subscription_id)}`) : null;
  if (sub) {
    // Renewal charges carry no notes of their own: the subscription's decide. A tagged payment must agree with it.
    if (sub.notes?.service !== SERVICE || (notes.service && notes.user_id !== sub.notes.user_id)) return null;
    return (await isUser(sub.notes.user_id)) ? { userId: sub.notes.user_id, sub, product: sub.notes.product ?? null } : null;
  }
  // A one-time payment (Trip Pass, ticket): its notes, else its order's (our API made the order).
  const order = !notes.service && pay?.order_id ? await read(`/orders/${enc(pay.order_id)}`) : null;
  const n = notes.service ? notes : plainNotes(order?.notes);
  if (n.service !== SERVICE || !(await isUser(n.user_id))) return null;
  return { userId: n.user_id, sub: null, product: n.product ?? null };
}

/** Handle one Razorpay dispute by id. Returns what happened (for logs and tests); throws only when Razorpay can't be read. */
export async function handleDispute(disputeId: string): Promise<string> {
  const d = await read(`/disputes/${enc(disputeId)}`);
  if (d?.id !== disputeId || typeof d.payment_id !== 'string') return 'not_found';
  const pay = await read(`/payments/${enc(d.payment_id)}`);
  if (!pay) return 'not_found';
  const placed = await placePayment(pay);
  if (!placed) return 'not_ours';
  const { userId, sub, product } = placed;
  const status = String(d.status ?? 'open').slice(0, 40);

  const [first] = await sql`insert into billing_disputes (id, user_id, payment_id, status, amount_minor, currency, respond_by)
    values (${d.id}, ${userId}, ${pay.id}, ${status}, ${Number(d.amount) || null}, ${d.currency ?? pay.currency ?? 'INR'}, ${at(d.respond_by)})
    on conflict (id) do update set status = excluded.status, respond_by = coalesce(excluded.respond_by, billing_disputes.respond_by), updated_at = now()
    returning handled_at is null as todo`;
  let ended: string[] = [];
  // The first sighting's work, until it has all succeeded once: a Razorpay outage half way leaves handled_at null, so the next
  // delivery or the hourly sweep does it again (each step is idempotent; the email goes once).
  const todo = !!first?.todo;
  if (todo) {
    // Locked before anything is ended, so the account can't buy again in between.
    await sql`update users set billing_disputed_at = coalesce(billing_disputed_at, now()), billing_dispute_ref = ${d.id} where id = ${userId}`;
    ended = await endWebPlus(userId, sub);
    if (product === PASS_SKU) await voidPass(`rzp:${pay.id}`, false);
    // A partner's commission on the disputed payment is void (clawed back if it was already paid out).
    await voidCommission(`rzp:pay:${pay.id}`, 'chargeback');
    await recomputePlus(userId);
    await emailBillingDisputed(userId, d.id, { amountMinor: Number(d.amount) || null, currency: d.currency ?? pay.currency ?? 'INR', paymentId: pay.id });
    await sql`update billing_disputes set handled_at = now() where id = ${d.id}`;
  }
  alertDispute(userId, d, pay, product, todo ? ended : null);
  return todo ? `disputed:${ended.length}` : `dispute_${status}`;
}

/**
 * The disputed subscription is ended now, and so is every other web subscription of the account that could still charge: we
 * won't serve a locked account, so we mustn't bill it. Returns the subscription ids ended.
 */
async function endWebPlus(userId: string, disputed: any | null): Promise<string[]> {
  const canCharge = (status: unknown) => CHARGEABLE.includes(String(status)) || status === 'halted' || status === 'paused';
  const rows = await sql`select substr(purchase_token, 5) as id, raw->>'status' as status from subscriptions
    where user_id = ${userId} and platform = 'razorpay' and ended_reason is null`;
  const subs = new Map<string, unknown>(rows.map(r => [r.id as string, r.status]));
  if (disputed?.id) subs.set(disputed.id, disputed.status);
  const ended: string[] = [];
  for (const [id, status] of subs) {
    if (!canCharge(status) && id !== disputed?.id) continue;
    if (canCharge(status)) await cancelAtRazorpay(id);
    await endSubscriptionRow(userId, id, 'dispute');
    ended.push(id);
  }
  return ended;
}

/** One owner alert per dispute status (opened, under review, won, lost...). */
function alertDispute(userId: string, d: any, pay: any, product: string | null, ended: string[] | null) {
  ownerSaleAlert(`rzp:dispute:${d.id}:${String(d.status ?? 'open')}`, () => ({
    kind: 'dispute', provider: 'razorpay', userId, product: razorpayProduct(product), amountMinor: Number(d.amount) || null, currency: d.currency ?? pay.currency ?? 'INR',
    amountNote: `disputed, ${d.status ?? 'open'}`, ids: { disputeId: d.id, paymentId: pay.id, invoiceId: pay.invoice_id, orderId: pay.order_id }, test: razorpayTest(), at: at(d.created_at),
    details: [['Status', String(d.status ?? '')], ['Reason', d.reason_code ? String(d.reason_code).slice(0, 120) : null],
      ['Respond by', at(d.respond_by) ? `${istDate(at(d.respond_by))} (Razorpay dashboard → Disputes)` : 'see the Razorpay dashboard → Disputes'],
      ['What changed', ended ? `account locked for web purchases; ${ended.length ? `subscription ${ended.join(', ')} cancelled and ended` : 'no live web subscription'}` : 'nothing (already handled; winning never restores Plus by itself)'],
      ['To unlock', 'Admin → the user → Clear billing dispute']],
  }));
}

/** Admin: lift the lock (SC-14/15). Plus from comps and passes comes back; ended subscriptions stay ended (a new checkout). */
export async function clearBillingDispute(userId: string) {
  const [u] = await sql`update users set billing_disputed_at = null where id = ${userId} returning id`;
  if (u) await recomputePlus(userId);
  return !!u;
}
