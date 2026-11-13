// The billing rules as pure functions (lib/billing-policy.ts), named after the scenarios of docs/billing-scenarios.md. No
// database, no network. The handlers that use them run against a fake Razorpay and Play in tests/integration/billing-scenarios.test.ts.
import { describe, it, expect } from 'vitest';
import {
  currentCycleUnpaid, paidThrough, haltedPaidThrough, razorpayRow, startsLater, canStillCharge, chargeGuardVerdict, reactivationStartAt,
  REACTIVATE_MIN_LEAD_SECONDS, isDisputeEvent, playVoidKind, isTransient, RAZORPAY_STATE,
} from '../../lib/billing-policy.js';

const NOW = 1_800_000_000, DAY = 86400;
/** A monthly subscription in its second cycle (one paid, one booked). */
const sub = (extra: any = {}) => ({ id: 'sub_x', status: 'active', total_count: 120, remaining_count: 118, paid_count: 2,
  current_start: NOW - 5 * DAY, current_end: NOW + 25 * DAY, charge_at: NOW + 25 * DAY, ended_at: null, ...extra });

describe('paid time (SC-05, SC-06, SC-16)', () => {
  it('active is paid up; a cycle booked but not paid is unpaid; missing counts are never read as unpaid', () => {
    expect(currentCycleUnpaid(sub())).toBe(false);
    expect(currentCycleUnpaid(sub({ status: 'pending', paid_count: 1 }))).toBe(true);
    expect(currentCycleUnpaid(sub({ status: 'cancelled', paid_count: 2 }))).toBe(false);
    expect(currentCycleUnpaid({ status: 'halted', current_start: 1, current_end: 2 })).toBe(false);
    expect(currentCycleUnpaid(null)).toBe(false);
  });

  it('paidThrough is current_end, or current_start when that cycle was never paid', () => {
    expect(paidThrough(sub())).toBe(NOW + 25 * DAY);
    expect(paidThrough(sub({ status: 'cancelled', paid_count: 1 }))).toBe(NOW - 5 * DAY);
    expect(paidThrough({})).toBe(0);
  });

  it('SC-05 a halted subscription without counts is read as unpaid, never as a free cycle', () => {
    expect(haltedPaidThrough({ status: 'halted', current_start: NOW - DAY, current_end: NOW + 29 * DAY })).toBe(NOW - DAY);
    expect(haltedPaidThrough(sub({ status: 'halted', paid_count: 1 }))).toBe(NOW - 5 * DAY);
    // A halt inside a cycle that was paid for keeps that cycle.
    expect(haltedPaidThrough(sub({ status: 'halted', paid_count: 2 }))).toBe(NOW + 25 * DAY);
  });

  it('razorpayRow: pending keeps Plus to the end of the cycle being retried (SC-04); cancelled keeps only the paid time', () => {
    expect(razorpayRow(sub({ status: 'pending', paid_count: 1 }))).toEqual({ status: 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', expiresAt: new Date((NOW + 25 * DAY) * 1000) });
    expect(razorpayRow(sub({ status: 'cancelled' }))).toEqual({ status: 'SUBSCRIPTION_STATE_CANCELED', expiresAt: new Date((NOW + 25 * DAY) * 1000) });
    // SC-16: a mandate revoked while a renewal was failing ends at the start of the unpaid cycle.
    expect(razorpayRow(sub({ status: 'cancelled', paid_count: 1 })).expiresAt).toEqual(new Date((NOW - 5 * DAY) * 1000));
    expect(razorpayRow({ status: 'authenticated', current_end: null })).toEqual({ status: 'SUBSCRIPTION_STATE_ACTIVE', expiresAt: null });
    expect(razorpayRow({ status: 'something_new' }).status).toBe('SUBSCRIPTION_STATE_PENDING');
    expect(RAZORPAY_STATE.halted).toBe('SUBSCRIPTION_STATE_ON_HOLD');
  });
});

describe('charge roka (SC-21) and what can still charge', () => {
  it('canStillCharge: chargeable status, not ended, a debit still to come; the second it is due still counts', () => {
    expect(canStillCharge(sub(), NOW)).toBe(true);
    expect(canStillCharge(sub({ charge_at: NOW }), NOW)).toBe(true);
    expect(canStillCharge(sub({ charge_at: NOW - 1 }), NOW)).toBe(false);
    expect(canStillCharge(sub({ status: 'pending', charge_at: NOW - DAY }), NOW)).toBe(true);
    for (const status of ['halted', 'cancelled', 'completed', 'expired', 'paused', 'created']) expect(canStillCharge(sub({ status }), NOW)).toBe(false);
    expect(canStillCharge(sub({ ended_at: NOW - 10 }), NOW)).toBe(false);
    expect(canStillCharge(null, NOW)).toBe(false);
  });

  it('a Reactivate subscription waiting for its first charge can charge, and starts later', () => {
    const waiting = { status: 'authenticated', current_end: null, start_at: NOW + 10 * DAY, charge_at: null };
    expect(startsLater(waiting, NOW)).toBe(true);
    expect(canStillCharge(waiting, NOW)).toBe(true);
    expect(startsLater({ ...waiting, start_at: NOW - 1 }, NOW)).toBe(false);
  });

  it('cancels only what our row says must stop and Razorpay could still charge', () => {
    const base = { s: sub(), nowSec: NOW, cancelRequested: false, endedReason: null, disputed: false };
    expect(chargeGuardVerdict(base)).toBeNull();                                   // a paying customer is never touched
    expect(chargeGuardVerdict({ ...base, cancelRequested: true })).toBe('cancel');  // a cancel that didn't stick
    expect(chargeGuardVerdict({ ...base, endedReason: 'refund' })).toBe('cancel');  // refunded, Razorpay still live
    expect(chargeGuardVerdict({ ...base, disputed: true })).toBe('cancel');         // account locked by a chargeback
    expect(chargeGuardVerdict({ ...base, cancelRequested: true, s: sub({ status: 'cancelled' }) })).toBeNull();
  });
});

describe('Reactivate (SC-09)', () => {
  it('first charge at the paid end when there is time left; now when there is none or too little', () => {
    const end = new Date((NOW + 10 * DAY) * 1000);
    expect(reactivationStartAt(end, NOW)).toBe(NOW + 10 * DAY);
    expect(reactivationStartAt(new Date((NOW + REACTIVATE_MIN_LEAD_SECONDS) * 1000), NOW)).toBe(NOW + REACTIVATE_MIN_LEAD_SECONDS);
    expect(reactivationStartAt(new Date((NOW + REACTIVATE_MIN_LEAD_SECONDS - 1) * 1000), NOW)).toBeNull();
    expect(reactivationStartAt(new Date((NOW - DAY) * 1000), NOW)).toBeNull();
    expect(reactivationStartAt(null, NOW)).toBeNull();
  });
});

describe('disputes and voided purchases (SC-13)', () => {
  it('every payment.dispute.* event is a dispute, including a type Razorpay adds later', () => {
    for (const t of ['payment.dispute.created', 'payment.dispute.won', 'payment.dispute.lost', 'payment.dispute.closed', 'payment.dispute.under_review', 'payment.dispute.action_required', 'payment.dispute.something_new']) expect(isDisputeEvent(t)).toBe(true);
    for (const t of ['payment.captured', 'refund.processed', 'dispute.created', 'payment.disputed']) expect(isDisputeEvent(t)).toBe(false);
  });

  it("Google's voidedReason 7 is a chargeback; every other reason is a refund", () => {
    expect(playVoidKind(7)).toBe('dispute');
    expect(playVoidKind('7')).toBe('dispute');
    for (const r of [0, 1, 2, 3, 4, 5, 6, 8, undefined, null]) expect(playVoidKind(r)).toBe('refund');
  });
});

describe('isTransient (rule 7: unreadable store -> 5xx and redelivery)', () => {
  it('network failures, 408, 429 and 5xx are retried; 4xx and our own refusals are answers', () => {
    expect(isTransient(new Error('fetch failed'))).toBe(true);
    expect(isTransient({ response: { status: 503 } })).toBe(true);
    expect(isTransient({ response: { status: 429 } })).toBe(true);
    expect(isTransient({ response: { status: 408 } })).toBe(true);
    expect(isTransient(new Error('razorpay_502: bad gateway'))).toBe(true);
    expect(isTransient({ response: { status: 404 } })).toBe(false);
    expect(isTransient(new Error('razorpay_400: not found'))).toBe(false);
    expect(isTransient(new Error('token_owned_by_other_user'))).toBe(false);
    expect(isTransient(new Error('play_not_configured'))).toBe(false);
    // A bug or a bad row would fail on every redelivery: never retried. A postgres error's string code is not an HTTP status.
    expect(isTransient(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isTransient(Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }))).toBe(false);
    expect(isTransient(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true);
  });
});
