/**
 * The hourly billing reconcile (SC-21 of Hookpost's docs/billing/SCENARIOS.md, mapped in docs/billing-scenarios.md). Razorpay
 * events reach Tablamigo only through Hookpost's fire-and-forget forward, and Google's RTDN push can fail too, so every hour
 * this reads the stores and runs the same handler the lost event would have:
 *
 * 1. every open Razorpay subscription is synced (renewals, failed and halted renewals, cancellations, customer pauses);
 * 2. Razorpay refunds of the last 3 days -> handleRefund (a refund ends the subscription it paid for);
 * 3. Razorpay disputes of the last 45 days -> handleDispute (dispute events are not forwarded by Hookpost at all);
 * 4. charge roka: a subscription our row says must not charge again (we cancelled it, a refund or a chargeback ended it, the
 *    account is locked) that Razorpay could still charge is cancelled at Razorpay now, keeping the access already paid for;
 * 5. Google's voided purchases of the last 3 days -> the RTDN's own handlers (refunds and chargebacks of Play purchases).
 *
 * It runs in the API process with the in-repo scheduler (SCHEDULER=off on a box turns it off there too; keep it on in exactly
 * one production process at least), outside the minute tick's transaction, under its own advisory lock, and stops starting
 * new items after RECONCILE_BUDGET_MS.
 *
 * Every handler is idempotent (send-once email keys, keyed owner alerts, conditional updates), so a run that overlaps another
 * process's, or repeats one, does the work once. A read that fails skips that item and is counted in `errors`; the next hour
 * tries again. The scheduler (lib/scheduler.ts) runs it once an hour; scripts/billing-reconcile.ts runs it by hand, and
 * `--dry-run` lists what it would do without writing anything or calling a store's write API.
 */
import { sql } from './db.js';
import { rzp, razorpayOn, syncRazorpay, cancelAtRazorpay, alertRazorpaySubscription } from './razorpay.js';
import { handleRefund } from './razorpay-webhook.js';
import { handleDispute } from './billing-disputes.js';
import { listPlayVoided, handlePlayVoidedSubscription, voidPass, alertPlayVoided, PLAY_VOIDED_LOOKBACK_DAYS, PASS_SKU } from './play.js';
import { playAuth } from './play-client.js';
import { chargeGuardVerdict, CHARGEABLE, playVoidKind } from './billing-policy.js';
import { voidPlayOrder } from './affiliate-ledger.js';

export const REFUND_LOOKBACK_DAYS = 3;
/** A run stops starting new items after this long; whatever is left is done next hour. */
export const RECONCILE_BUDGET_MS = 10 * 60_000;
export const DISPUTE_LOOKBACK_DAYS = 45;

export type ReconcileReport = {
  dryRun: boolean;
  synced: boolean;
  refunds: { id: string; result: string }[];
  disputes: { id: string; result: string }[];
  chargeStopped: { subscriptionId: string; result: string }[];
  playVoided: { token: string; result: string }[];
  errors: string[];
};

const enc = encodeURIComponent;

/** Every item of a Razorpay list endpoint created since `fromSec` (count/skip pages, capped). */
async function rzpList(path: string, fromSec: number): Promise<any[]> {
  const out: any[] = [];
  for (let skip = 0; skip < 2000; skip += 100) {
    const page = await rzp('GET', `${path}?from=${fromSec}&count=100&skip=${skip}`);
    const items = Array.isArray(page?.items) ? page.items : [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

export async function reconcileBilling({ dryRun = false, now = new Date() }: { dryRun?: boolean; now?: Date } = {}): Promise<ReconcileReport> {
  const report: ReconcileReport = { dryRun, synced: false, refunds: [], disputes: [], chargeStopped: [], playVoided: [], errors: [] };
  const nowSec = Math.floor(now.getTime() / 1000);
  const deadline = Date.now() + RECONCILE_BUDGET_MS;
  const fail = (what: string, e: any) => report.errors.push(`${what}: ${String(e?.message ?? e).slice(0, 200)}`);
  const late = () => Date.now() > deadline && (report.errors.includes('out of time') || report.errors.push('out of time'), true);

  if (razorpayOn()) {
    if (!dryRun) await syncRazorpay().then(() => { report.synced = true; }, e => fail('sync', e));

    const refunds = await rzpList('/refunds', nowSec - REFUND_LOOKBACK_DAYS * 86400).catch(e => (fail('refund list', e), [] as any[]));
    for (const r of refunds.filter(x => x?.status === 'processed' && typeof x.id === 'string')) {
      if (late()) break;
      if (dryRun) { report.refunds.push({ id: r.id, result: 'would check' }); continue; }
      await handleRefund(r.id).then(result => report.refunds.push({ id: r.id, result }), e => fail(`refund ${r.id}`, e));
    }

    const disputes = await rzpList('/disputes', nowSec - DISPUTE_LOOKBACK_DAYS * 86400).catch(e => (fail('dispute list', e), [] as any[]));
    for (const d of disputes.filter(x => typeof x?.id === 'string')) {
      if (late()) break;
      if (dryRun) { report.disputes.push({ id: d.id, result: `would check (${d.status ?? '?'})` }); continue; }
      await handleDispute(d.id).then(result => report.disputes.push({ id: d.id, result }), e => fail(`dispute ${d.id}`, e));
    }

    if (!late()) await chargeGuard(report, nowSec, dryRun, fail);
  }

  if (playAuth() && !late()) await playVoidedSweep(report, now, dryRun, fail);
  return report;
}

/** Step 4, charge roka. Only rows whose stored Razorpay status could still charge are read from Razorpay. */
async function chargeGuard(report: ReconcileReport, nowSec: number, dryRun: boolean, fail: (what: string, e: any) => void) {
  const rows = await sql`select substr(s.purchase_token, 5) as id, s.user_id, s.ended_reason, s.cancel_requested_at, u.billing_disputed_at
    from subscriptions s join users u on u.id = s.user_id
    where s.platform = 'razorpay' and coalesce(s.raw->>'status', '') in ${sql(CHARGEABLE)}
      and (s.cancel_requested_at is not null or s.ended_reason is not null or u.billing_disputed_at is not null)`;
  for (const row of rows) {
    const s = await rzp('GET', `/subscriptions/${enc(row.id)}`).catch(e => (fail(`subscription ${row.id}`, e), null));
    if (s?.id !== row.id || s.notes?.user_id !== row.userId) continue;
    const verdict = chargeGuardVerdict({ s, nowSec, cancelRequested: !!row.cancelRequestedAt, endedReason: row.endedReason, disputed: !!row.billingDisputedAt });
    if (!verdict) {
      // Razorpay already stopped it: keep the stored copy current so it isn't read again next hour.
      if (!dryRun) await sql`update subscriptions set raw = raw || ${sql.json({ status: s.status, ended_at: s.ended_at ?? null })} where purchase_token = ${'rzp:' + row.id}`;
      continue;
    }
    if (dryRun) { report.chargeStopped.push({ subscriptionId: row.id, result: 'would cancel' }); continue; }
    try {
      const c = await cancelAtRazorpay(row.id);
      await sql`update subscriptions set raw = raw || ${sql.json({ status: c?.status ?? 'cancelled', ended_at: c?.ended_at ?? nowSec })}, updated_at = now() where purchase_token = ${'rzp:' + row.id}`;
      const why = row.billingDisputedAt ? 'the account is locked by a chargeback' : row.endedReason ? `its Plus was ended by a ${row.endedReason}` : 'it was cancelled here, but the cancel had not stuck at Razorpay';
      alertRazorpaySubscription('charge_stopped', `rzp:charge_stopped:${row.id}`, row.userId, row.id, [['Why', why], ['Next charge was', s.charge_at ? new Date(Number(s.charge_at) * 1000).toISOString() : null]], c?.id === row.id ? c : s);
      report.chargeStopped.push({ subscriptionId: row.id, result: 'cancelled' });
    } catch (e) { fail(`cancel ${row.id}`, e); }
  }
}

/** Step 5: Google's voided purchases, through the RTDN's handlers (each checks the purchase is ours). */
async function playVoidedSweep(report: ReconcileReport, now: Date, dryRun: boolean, fail: (what: string, e: any) => void) {
  const voided = await listPlayVoided(now.getTime() - PLAY_VOIDED_LOOKBACK_DAYS * 86400_000).catch(e => (fail('play voided list', e), []));
  for (const v of voided.filter(x => typeof x?.purchaseToken === 'string')) {
    const [sub] = await sql`select 1 from subscriptions where purchase_token = ${v.purchaseToken} and platform = 'google' and ended_reason is null`;
    const [pass] = sub ? [] : await sql`select user_id from passes where purchase_token = ${v.purchaseToken} and voided_at is null`;
    if (!sub && !pass) continue;
    if (dryRun) { report.playVoided.push({ token: v.purchaseToken.slice(0, 12), result: sub ? 'would end subscription' : 'would void pass' }); continue; }
    try {
      if (sub) report.playVoided.push({ token: v.purchaseToken.slice(0, 12), result: await handlePlayVoidedSubscription(v.purchaseToken, v) });
      else if (await voidPass(v.purchaseToken)) {
        alertPlayVoided(pass.userId, PASS_SKU, v, null, false);
        await voidPlayOrder(v.orderId, playVoidKind(v.voidedReason) === 'dispute');
        report.playVoided.push({ token: v.purchaseToken.slice(0, 12), result: 'pass voided' });
      }
    } catch (e) { fail(`play voided ${v.purchaseToken.slice(0, 12)}`, e); }
  }
}
