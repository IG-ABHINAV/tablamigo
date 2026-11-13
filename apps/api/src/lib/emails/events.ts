/** Emails triggered by something the user or an admin just did. All fire after the change has committed. */
import { deliver } from './send.js';
import { welcome, verification, accountDeleted, plusCancelled, plusPaymentStopped, billingDisputed, refundIssued, money, type OtherPlus } from './templates.js';
import { REASON_TEXT, type Reason } from '../verification.js';

export const emailWelcome = (userId: string) =>
  deliver({ kind: 'welcome', userId, periodKey: 'once', build: u => welcome({ name: u.name }) });

/** `reason` is a key of REASON_TEXT (lib/verification.ts) when the automatic check rejected the selfie. */
export const emailVerification = (userId: string, requestId: string, approved: boolean, reason?: string | null) =>
  deliver({ kind: approved ? 'verification_approved' : 'verification_rejected', userId, periodKey: requestId, ref: requestId,
    meta: reason ? { reason } : undefined,
    build: u => verification({ name: u.name, approved, reason: reason ? REASON_TEXT[reason as Reason] ?? null : null }) });

/** The account row is already anonymised, so the address and name are captured before deletion. */
export const emailAccountDeleted = (userId: string, before: { email: string; name: string | null; googleSub: boolean; googleCancelled?: boolean; webSub: boolean; webCancelled?: boolean }) =>
  deliver({ kind: 'account_deleted', userId, periodKey: 'once', to: before.email,
    build: () => accountDeleted({ name: before.name, deletedAt: new Date(), googleSub: before.googleSub, googleCancelled: before.googleCancelled, webSub: before.webSub, webCancelled: before.webCancelled }) });

/** A Razorpay subscription cancelled: by the app's Cancel, subscription.cancelled, or a pause we cancelled. One per subscription. */
export const emailPlusCancelled = (userId: string, subId: string, d: { period: string | null; until: Date | null; endedAt: Date; otherPlus: OtherPlus; paused?: boolean }) =>
  deliver({ kind: 'plus_cancelled', userId, periodKey: `rzp:${subId}`, ref: `rzp:${subId}`, meta: { until: d.until?.toISOString() ?? null, paused: !!d.paused },
    build: u => plusCancelled({ name: u.name, ...d }) });

/** A Razorpay renewal halted and we cancelled it (lib/razorpay.ts applyRazorpayRules). One per subscription. */
export const emailPlusPaymentStopped = (userId: string, subId: string, d: { period: string | null; otherPlus: OtherPlus }) =>
  deliver({ kind: 'plus_payment_stopped', userId, periodKey: `rzp:${subId}`, ref: `rzp:${subId}`, build: u => plusPaymentStopped({ name: u.name, ...d }) });

/** A chargeback on a web payment (lib/billing-disputes.ts). One per dispute. */
export const emailBillingDisputed = (userId: string, disputeId: string, d: { amountMinor: number | null; currency: string; paymentId: string }) =>
  deliver({ kind: 'billing_disputed', userId, periodKey: disputeId, ref: d.paymentId, meta: { amount: d.amountMinor, currency: d.currency },
    build: u => billingDisputed({ name: u.name, amount: d.amountMinor ? money(d.amountMinor, d.currency) : null, paymentId: d.paymentId }) });

/** Razorpay refund.processed (lib/razorpay-webhook.ts). One per refund id, whichever refund event arrives first. */
export const emailRefundIssued = (userId: string, d: {
  amountMinor: number; currency: string; refundId: string; paymentId: string; refundedAt: Date;
  what: 'subscription' | 'pass'; period?: string | null; plus: 'ended' | 'active'; renewsOn?: Date | null; otherPlus?: OtherPlus;
}) => deliver({ kind: 'refund', userId, periodKey: d.refundId, ref: d.paymentId, meta: { amount: d.amountMinor, currency: d.currency, what: d.what, plus: d.plus },
  build: u => refundIssued({ name: u.name, amount: money(d.amountMinor, d.currency), refundId: d.refundId, paymentId: d.paymentId, refundedAt: d.refundedAt,
    what: d.what, period: d.period, plus: d.plus, renewsOn: d.renewsOn, otherPlus: d.otherPlus }) });
