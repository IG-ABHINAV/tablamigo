/**
 * Billing rules as pure functions: no database, no network, no clock (callers pass `nowSec`). Every billing decision that
 * isn't a plain fetch or write is made here, so it can be tested on its own. The scenarios they implement are Hookpost's
 * docs/billing/SCENARIOS.md (SC-01 to SC-24), mapped to Tablamigo in docs/billing-scenarios.md.
 *
 * Ported from Hookpost's libraries/nestjs-libraries/src/services/razorpay.mapping.ts (currentCycleUnpaid, paidThrough,
 * canStillCharge) at ac5479f7c, 2 Nov 2026. A fix to one should be made to the other.
 */

/** Razorpay status -> the Play state recomputePlus already understands (lib/play.ts derivedPlusUntil). */
export const RAZORPAY_STATE: Record<string, string> = {
  created: 'SUBSCRIPTION_STATE_PENDING', authenticated: 'SUBSCRIPTION_STATE_ACTIVE', active: 'SUBSCRIPTION_STATE_ACTIVE',
  // A renewal that failed and is being retried (SC-04): Plus stays on while Razorpay retries.
  pending: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  cancelled: 'SUBSCRIPTION_STATE_CANCELED',
  // We never pause, so a pause is the customer's (SC-16) and is cancelled at once (lib/razorpay.ts applyRazorpayRules).
  paused: 'SUBSCRIPTION_STATE_PAUSED',
  // Retries used up (SC-05): no Plus, and the subscription is cancelled at once.
  halted: 'SUBSCRIPTION_STATE_ON_HOLD',
  completed: 'SUBSCRIPTION_STATE_EXPIRED', expired: 'SUBSCRIPTION_STATE_EXPIRED',
};

/** Razorpay states in which it can still take money. `halted` has stopped retrying; `created` was never approved. */
export const CHARGEABLE = ['active', 'authenticated', 'pending'];
const TERMINAL = ['cancelled', 'completed', 'expired'];

/**
 * Has Razorpay started a billing cycle on this subscription that was never paid? A renewal that failed (pending, halted, or
 * cancelled from there) already has current_start and current_end on the new cycle. Razorpay books a cycle off
 * remaining_count when it starts and paid_count counts the cycles paid, so more booked than paid means the current one is
 * unpaid. `active` is paid up by definition; a payload without the three counts is never read as unpaid.
 */
export function currentCycleUnpaid(s: any): boolean {
  if (!s || s.status === 'active') return false;
  const { total_count, remaining_count, paid_count } = s;
  if ([total_count, remaining_count, paid_count].some(n => n == null)) return false;
  const booked = Number(total_count) - Number(remaining_count);
  return Number.isFinite(booked) && booked > Number(paid_count);
}

/** Where the time paid for ends, unix seconds (0 when no cycle): current_end, or current_start when that cycle is unpaid. */
export function paidThrough(s: any): number {
  if (currentCycleUnpaid(s)) return Number(s.current_start || 0);
  return Number(s?.current_end || 0);
}

/**
 * Where the paid time of a halted subscription ends (SC-05). Razorpay halts when every retry of a renewal failed, so the
 * current cycle is unpaid unless the counts prove otherwise: a payload without them is read as unpaid (current_start), never
 * as a free cycle.
 */
export function haltedPaidThrough(s: any): number {
  const { total_count, remaining_count, paid_count } = s ?? {};
  if ([total_count, remaining_count, paid_count].some(n => n == null)) return Number(s?.current_start || 0);
  return paidThrough(s);
}

/**
 * The row stored for a Razorpay subscription: its state and the second its Plus ends. While a failed renewal is retried
 * (`pending`) Plus runs to the end of the cycle being retried; in every other state only to the end of what was paid
 * (paidThrough), so a subscription cancelled or halted on an unpaid cycle never gives that cycle away.
 */
export function razorpayRow(s: any): { status: string; expiresAt: Date | null } {
  const status = RAZORPAY_STATE[s?.status] ?? 'SUBSCRIPTION_STATE_PENDING';
  const end = s?.status === 'pending' ? Number(s.current_end || 0) : paidThrough(s);
  return { status, expiresAt: end > 0 ? new Date(end * 1000) : null };
}

/**
 * A replacement subscription opened by Reactivate (SC-09) whose first charge is still ahead: `authenticated`, no cycle yet,
 * start_at in the future. It renews, but gives no Plus of its own until it charges; the subscription it replaces covers the
 * time up to start_at.
 */
export const startsLater = (s: any, nowSec: number) => s?.status === 'authenticated' && !s.current_end && Number(s.start_at || 0) > nowSec;

/**
 * Can Razorpay still take money off this subscription? A chargeable status, not ended, and a debit still to come: charge_at
 * at or after now, or `pending` (a retry is under way and the date may have passed). The second the charge is due counts.
 */
export function canStillCharge(s: any, nowSec: number): boolean {
  if (!s || !CHARGEABLE.includes(s.status) || Number(s.ended_at || 0) > 0) return false;
  return Number(s.charge_at || 0) >= nowSec || s.status === 'pending' || startsLater(s, nowSec);
}

/**
 * Charge roka (SC-21): our row says this subscription must not charge again (we cancelled it, a refund or a dispute ended it,
 * or the account is locked by a chargeback), but Razorpay could still charge it. Then it is cancelled at Razorpay now; the
 * access the row already grants is kept. Anything Razorpay can't charge is left alone.
 */
export function chargeGuardVerdict(input: { s: any; nowSec: number; cancelRequested: boolean; endedReason: string | null; disputed: boolean }): 'cancel' | null {
  const { s, nowSec, cancelRequested, endedReason, disputed } = input;
  if (!canStillCharge(s, nowSec)) return null;
  return cancelRequested || !!endedReason || disputed ? 'cancel' : null;
}

/** Reactivate needs this much lead: a start_at closer than this is just a new subscription that charges now. */
export const REACTIVATE_MIN_LEAD_SECONDS = 15 * 60;

/**
 * Where a new web subscription should make its first charge (SC-09): at the paid end of a cancelled one that still has paid
 * time, so nothing is charged today and nothing twice. null = charge now (no paid time left, or too little to bother).
 */
export function reactivationStartAt(paidEnd: Date | null, nowSec: number): number | null {
  if (!paidEnd) return null;
  const at = Math.floor(paidEnd.getTime() / 1000);
  return at - nowSec >= REACTIVATE_MIN_LEAD_SECONDS ? at : null;
}

/** Any Razorpay dispute event, matched by prefix so a new dispute event type still locks the account (SC-13). */
export const isDisputeEvent = (type: string) => type.startsWith('payment.dispute.');

/** Has Razorpay ended this subscription for good? */
export const razorpayEnded = (s: any) => TERMINAL.includes(s?.status);

/**
 * Google's voidedReason for a voided Play purchase (Voided Purchases API). 7 is a chargeback; every other reason is a refund
 * Google or we issued. Both end the purchase's Plus now (rule 4); only a chargeback is a dispute for the owner.
 */
export const PLAY_CHARGEBACK_REASON = 7;
export const playVoidKind = (voidedReason: unknown): 'dispute' | 'refund' => Number(voidedReason) === PLAY_CHARGEBACK_REASON ? 'dispute' : 'refund';

/**
 * Should a failed call to Google or Razorpay be retried (answer 5xx so the push or webhook is delivered again), rather than
 * written off? Only what a retry can fix: an HTTP 408, 429 or 5xx, or a network failure (no response: refused, reset, timed
 * out, DNS). A 4xx is the store's answer, and any other error (a bug, a bad row) would only fail again on every redelivery.
 */
const NETWORK = /ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket|fetch failed|network|timeout|aborted/i;
export function isTransient(e: any): boolean {
  const status = Number(e?.response?.status ?? e?.status);
  const m = /razorpay_(\d{3})/.exec(String(e?.message ?? ''));
  const code = Number.isFinite(status) && status >= 100 ? status : m ? Number(m[1]) : NaN;
  if (Number.isFinite(code)) return code === 408 || code === 429 || code >= 500;
  return NETWORK.test(`${typeof e?.code === 'string' ? e.code : ''} ${e?.name ?? ''} ${e?.message ?? ''}`);
}
