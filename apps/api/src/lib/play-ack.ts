/**
 * Google Play acknowledgement safety net. Google refunds a subscription or in-app purchase automatically when the developer
 * has not acknowledged it within 3 days of purchase (a Trip Pass is acknowledged by consuming it), and the customer loses Plus.
 *
 *  - lib/play.ts marks every purchase Google reports as not yet acknowledged 'pending' (migration 070) and calls
 *    acknowledgePlayPurchase, which tries a few times in-line (ACK_RETRY_MS) and records the outcome on the row.
 *  - processPlayAcks (the scheduler, every minute; it only acts on rows that are due) takes each purchase still pending
 *    PLAY_ACK_GRACE_HOURS after it was bought, asks Google for its state, and acknowledges it again when Google still says it
 *    isn't. A failure is retried with backoff (grace, 2x, 4x ... capped at 6 hours).
 *  - Once a purchase is PLAY_ACK_ALERT_HOURS old (default 24, so the owner has 2 days left to act) and still not acknowledged,
 *    the owner (OWNER_SALES_ALERT_EMAIL) gets one email; if it is acknowledged after that, one more saying so.
 *
 * Never the purchase token in a log, an error column or an email: tokenRef() is a hash of it.
 */
import crypto from 'node:crypto';
import { sql } from './db.js';
import { clock } from './clock.js';
import { config } from './config.js';
import { sendMail } from './mail.js';
import { istTime, renderOwnerNotice } from './owner-alerts.js';
import { playAuth, playClient, acknowledgeUrl, subscriptionUrl, passUrl } from './play-client.js';

export type AckKind = 'subscription' | 'pass';
const HOUR = 3_600_000;
const GOOGLE_REFUND_HOURS = 72;
/** Waits between the in-line tries after a failed acknowledge (3 tries in all). Mutable so tests can shorten it. */
export const ACK_RETRY_MS = [1_000, 3_000];
/** The longest wait between two safety-net tries. */
export const MAX_BACKOFF_MS = 6 * HOUR;

export const tokenRef = (token: string) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
const table = (kind: AckKind) => (kind === 'pass' ? sql`passes` : sql`subscriptions`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/**
 * A short error for the row, the log and the owner's email: the HTTP status and Google's message. Never a URL (it holds the
 * token) and never the token itself, should Google's message quote it.
 */
export function ackErrorText(e: any, token?: string): string {
  const status = e?.response?.status ?? e?.status ?? e?.code;
  let msg = String(e?.response?.data?.error?.message ?? e?.message ?? e).replace(/https?:\/\/\S+/g, '<url>');
  if (token) msg = msg.split(token).join('<token>');
  return `${status ? `${status}: ` : ''}${msg.replace(/\s+/g, ' ')}`.slice(0, 300);
}

/** Wait before safety-net try number `failures + 1`: the grace period, doubling each failure, at most MAX_BACKOFF_MS. */
export function ackBackoffMs(failures: number, graceHours = config.playAckGraceHours): number {
  return Math.min(graceHours * HOUR * 2 ** Math.max(0, Math.min(failures - 1, 10)), MAX_BACKOFF_MS);
}

/** Whether a pending purchase gets the owner's email now: old enough, still not acknowledged, not emailed yet. */
export function ackAlertDue(since: Date, now: Date, alertedAt: Date | null, alertHours = config.playAckAlertHours): boolean {
  return !alertedAt && now.getTime() - since.getTime() >= alertHours * HOUR;
}

/**
 * Start tracking a purchase Google reports as not yet acknowledged. `since` is Google's purchase time when it gave one. The
 * safety net first looks at it a grace period from now, so it never races the caller's own in-line tries; if the process dies
 * before those finish, that is when it is picked up. A row already pending keeps its clock; one marked acknowledged or gone
 * is pending again (the safety net re-reads it from Google).
 */
export async function markAckPending(kind: AckKind, token: string, since: Date | null) {
  const now = clock.now();
  const at = since && !Number.isNaN(since.getTime()) && since.getTime() <= now.getTime() ? since : now;
  await sql`update ${table(kind)} set ack_state = 'pending', ack_since = coalesce(ack_since, ${at}), ack_next_at = ${new Date(now.getTime() + ackBackoffMs(1))}
    where purchase_token = ${token} and ack_state is distinct from 'pending'`;
}

/** Google says it is acknowledged (or consumed). Returns whether a pending row was settled by this call. */
export async function markAcknowledged(kind: AckKind, token: string) {
  const r = await sql`update ${table(kind)} set ack_state = 'acknowledged', acknowledged_at = coalesce(acknowledged_at, now()), ack_error = null, ack_next_at = null
    where purchase_token = ${token} and ack_state = 'pending' returning ack_alerted_at`;
  return r.length > 0;
}

async function recordFailure(kind: AckKind, token: string, error: string, now: Date) {
  const [r] = await sql`update ${table(kind)} set ack_attempts = ack_attempts + 1, ack_error = ${error}
    where purchase_token = ${token} and ack_state = 'pending' returning ack_attempts`;
  if (r) await sql`update ${table(kind)} set ack_next_at = ${new Date(now.getTime() + ackBackoffMs(r.ackAttempts))} where purchase_token = ${token}`;
}

async function callAcknowledge(kind: AckKind, productId: string, token: string) {
  const client = await playClient();
  await client.request({ method: 'POST', url: acknowledgeUrl(kind, productId, token), data: {}, timeout: 10_000 });
}

/**
 * Acknowledge (subscription) or consume (Trip Pass) now, trying again after each of ACK_RETRY_MS, and record the outcome on the
 * row: acknowledged, or the failure and when the safety net tries next. Never throws. True when Google accepted it.
 */
export async function acknowledgePlayPurchase(kind: AckKind, productId: string, token: string, retryMs: number[] = ACK_RETRY_MS): Promise<boolean> {
  let error = '';
  for (let i = 0; ; i++) {
    try {
      await callAcknowledge(kind, productId, token);
      await markAcknowledged(kind, token);
      return true;
    } catch (e) {
      error = ackErrorText(e, token);
      if (i >= retryMs.length) break;
      await sleep(retryMs[i]);
    }
  }
  console.error(`play ack: ${kind} ${tokenRef(token)} not acknowledged after ${retryMs.length + 1} tries: ${error}`);
  await recordFailure(kind, token, error, clock.now()).catch(e => console.error('play ack: could not record the failure', (e as Error)?.message));
  return false;
}

const inFlight = new Set<Promise<unknown>>();
/**
 * acknowledgePlayPurchase off the request path: the verify call or RTDN push answers at once, whatever Google does (a Play
 * outage would otherwise hold it for the tries and their timeouts). The row is already 'pending', so a process that dies
 * mid-try leaves it to the safety net.
 */
export function acknowledgeInBackground(kind: AckKind, productId: string, token: string): void {
  const p: Promise<unknown> = acknowledgePlayPurchase(kind, productId, token).catch(() => {}).finally(() => inFlight.delete(p));
  inFlight.add(p);
}
/** Resolves once every background acknowledge has finished (tests; a shutdown can wait on it too). */
export async function playAcksSettled() { while (inFlight.size) await Promise.allSettled([...inFlight]); }

type Due = { kind: AckKind; token: string; productId: string; userId: string; since: Date; attempts: number; alertedAt: Date | null; test: boolean };
type GoogleView = 'acknowledged' | 'pending' | 'not_yet' | 'gone';

/** What Google says about the purchase now. 'not_yet': payment still pending, so it can't be acknowledged yet. */
async function googleView(kind: AckKind, token: string): Promise<GoogleView> {
  const client = await playClient();
  try {
    if (kind === 'subscription') {
      const { data } = await client.request<any>({ url: subscriptionUrl(token), timeout: 10_000 });
      if (data.subscriptionState === 'SUBSCRIPTION_STATE_PENDING') return 'not_yet';
      if (['SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED', 'SUBSCRIPTION_STATE_EXPIRED'].includes(data.subscriptionState)) return data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' ? 'acknowledged' : 'gone';
      return data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' ? 'acknowledged' : 'pending';
    }
    const { data } = await client.request<any>({ url: passUrl(token), timeout: 10_000 });
    if (data.purchaseState === 2) return 'not_yet';
    if (data.purchaseState !== 0) return 'gone';
    return data.consumptionState === 1 ? 'acknowledged' : 'pending';
  } catch (e: any) {
    // Google doesn't know the token (never bought, or long expired): nothing to acknowledge.
    if ([404, 410].includes(Number(e?.response?.status))) return 'gone';
    throw e;
  }
}

export type AckRun = { checked: number; acknowledged: number; gone: number; failed: number; waiting: number; alerted: number; resolvedAlerts: number; skipped?: string };

/**
 * The safety net, from the scheduler tick (which holds the scheduler lock, so one process at a time). Takes at most `limit`
 * due purchases, oldest first.
 */
export async function processPlayAcks(now: Date = clock.now(), limit = 25): Promise<AckRun> {
  const run: AckRun = { checked: 0, acknowledged: 0, gone: 0, failed: 0, waiting: 0, alerted: 0, resolvedAlerts: 0 };
  if (!playAuth()) return { ...run, skipped: 'play_not_configured' };
  const grace = `${config.playAckGraceHours * 3600} seconds`;
  const rows = await sql<Due[]>`
    select * from (
      select 'subscription' as kind, purchase_token as token, product_id, user_id, ack_since as since, ack_attempts as attempts, ack_alerted_at as alerted_at,
        (raw ? 'testPurchase') as test
      from subscriptions where platform = 'google' and ack_state = 'pending' and coalesce(ack_next_at, ack_since + ${grace}::interval) <= ${now}
      union all
      select 'pass', purchase_token, product_id, user_id, ack_since, ack_attempts, ack_alerted_at, coalesce(raw->>'purchaseType' = '0', false)
      from passes where ack_state = 'pending' and purchase_token not like 'rzp:%' and coalesce(ack_next_at, ack_since + ${grace}::interval) <= ${now}
    ) d order by since limit ${limit}`;
  for (const r of rows) {
    run.checked++;
    let error = '';
    try {
      const view = await googleView(r.kind, r.token);
      if (view === 'acknowledged') { await settle(r, 'acknowledged', now, run); continue; }
      if (view === 'gone') { await settle(r, 'gone', now, run); continue; }
      if (view === 'not_yet') {
        // A pending payment: Google starts the 3 days once it is paid. Look again after the grace period.
        run.waiting++;
        await sql`update ${table(r.kind)} set ack_next_at = ${new Date(now.getTime() + ackBackoffMs(1))} where purchase_token = ${r.token} and ack_state = 'pending'`;
        continue;
      }
      await callAcknowledge(r.kind, r.productId, r.token);
      await settle(r, 'acknowledged', now, run);
      continue;
    } catch (e) { error = ackErrorText(e, r.token); }
    run.failed++;
    console.error(`play ack: safety net could not acknowledge ${r.kind} ${tokenRef(r.token)} (attempt ${r.attempts + 1}): ${error}`);
    await recordFailure(r.kind, r.token, error, now);
    if (ackAlertDue(r.since, now, r.alertedAt) && await alertOwner(r, now, error, 'failing')) {
      await sql`update ${table(r.kind)} set ack_alerted_at = ${now} where purchase_token = ${r.token}`;
      run.alerted++;
    }
  }
  return run;
}

async function settle(r: Due, state: 'acknowledged' | 'gone', now: Date, run: AckRun) {
  if (state === 'acknowledged') { await markAcknowledged(r.kind, r.token); run.acknowledged++; }
  else { await sql`update ${table(r.kind)} set ack_state = 'gone', ack_next_at = null where purchase_token = ${r.token} and ack_state = 'pending'`; run.gone++; }
  // The owner was told it was failing: tell them how it ended.
  if (r.alertedAt && await alertOwner(r, now, null, state)) run.resolvedAlerts++;
}

/** The owner's email. Same recipients as the sale alerts; one try per call, the caller records that it went. */
async function alertOwner(r: Due, now: Date, error: string | null, what: 'failing' | 'acknowledged' | 'gone'): Promise<boolean> {
  const to = config.ownerSalesAlerts.valid;
  if (!to.length) { console.error(`play ack: ${r.kind} ${tokenRef(r.token)} needs the owner, but OWNER_SALES_ALERT_EMAIL is unset`); return false; }
  const [u] = await sql`select name, email from users where id = ${r.userId}`;
  const ageH = Math.floor((now.getTime() - r.since.getTime()) / HOUR);
  const refundAt = new Date(r.since.getTime() + GOOGLE_REFUND_HOURS * HOUR);
  const product = r.kind === 'pass' ? 'Trip Pass' : `Plus subscription (${r.productId})`;
  const who = u ? `${u.name ?? '(no name)'} (${u.email})` : `user ${r.userId} (deleted)`;
  const subject = (what === 'failing'
    ? `Google Play purchase not acknowledged after ${ageH} h, Google refunds it ${istTime(refundAt)}`
    : `Google Play purchase ${what === 'acknowledged' ? 'now acknowledged' : 'no longer needs acknowledging (refunded or cancelled at Google)'}`)
    .replace(/[\r\n]+/g, ' ');
  const lead = what === 'failing'
    ? `The API could not acknowledge this Google Play purchase. Google refunds it automatically 3 days after purchase unless it is acknowledged. The API keeps retrying (every ${config.playAckGraceHours} h, backing off to 6 h). If it still fails, check the Play service account's access in Play Console (Users and permissions) and the API's error log, or refund or grant Plus by hand.`
    : what === 'acknowledged' ? 'The purchase you were alerted about is acknowledged now. Nothing to do.' : 'Google no longer has this purchase as bought, so there is nothing to acknowledge.';
  const { text, html } = renderOwnerNotice({
    subject, testReason: r.test ? 'Google Play test purchase (license tester)' : null,
    eyebrow: 'Owner alert · Google Play',
    headline: what === 'failing' ? `Purchase not acknowledged: ${product}` : what === 'acknowledged' ? `Acknowledged now: ${product}` : `Nothing to acknowledge: ${product}`,
    summary: lead,
    button: { label: 'Open customer in admin', url: `${config.siteUrl}/admin#users?q=${r.userId}` },
    sections: [[null, [
      { k: 'Customer', v: who },
      { k: 'Product', v: product },
      { k: 'Bought', v: istTime(r.since) },
      { k: 'Google refunds it', v: what === 'failing' ? istTime(refundAt) : null },
      { k: 'Tries that failed', v: String(r.attempts + (what === 'failing' ? 1 : 0)) },
      { k: 'Last error', v: error },
      { k: 'Mode', v: r.test ? 'Test mode (Google Play test purchase (license tester))' : 'Live' },
      { k: 'Purchase ref', v: `${r.kind}:${tokenRef(r.token)} (hash of the purchase token)` },
    ]]],
    footer: ['Sent only to the owner (OWNER_SALES_ALERT_EMAIL) by the Google Play acknowledgement safety net.'],
  });
  let sent = 0;
  for (const addr of to) {
    try {
      await sendMail({ to: addr, subject, text, html, idempotencyKey: `tablamigo-play-ack-${what}-${crypto.createHash('sha256').update(`${r.token}|${addr}`).digest('hex').slice(0, 40)}` });
      sent++;
    } catch (e) { console.error(`play ack: owner email failed: ${ackErrorText(e)}`); }
  }
  return sent > 0;
}
