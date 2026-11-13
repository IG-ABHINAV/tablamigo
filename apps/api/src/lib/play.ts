import crypto from 'node:crypto';
import { sql } from './db.js';
import { derivedPlusUntil } from './plus-derive.js';
import { clock } from './clock.js';
import { config } from './config.js';
import { launchOffer } from './plus.js';
import { ownerSaleAlert, playMoney, playProduct, istDate, type SaleKind } from './owner-alerts.js';
import { playAuth, playClient, playBase as base, PASS_SKU, passUrl, subscriptionUrl } from './play-client.js';
import { playVoidKind, isTransient } from './billing-policy.js';
import { markAckPending, markAcknowledged, acknowledgeInBackground } from './play-ack.js';
import { playOfferId, playOfferLabel } from './play-offers.js';
import { accruePlayCharge, hasAffiliateReferral, voidCommission } from './affiliate-ledger.js';

export { PASS_SKU };
export const PASS_DAYS = 14;

export async function recomputePlus(userId: string) {
  await sql`update users u set plus_until = ${derivedPlusUntil()} where u.id = ${userId}`;
}

export type PlusRecompute = {
  users: number;
  /** Accounts with Plus now / once recomputed. */
  plusBefore: number; plusAfter: number;
  /** plus_until differs from the derived value. */
  changed: number;
  /** Plus they don't have now but a subscription, pass or comp backs. */
  gained: number;
  /** Plus nothing backs: written by hand, or left by a billing event that is gone. */
  lost: number;
  extended: number; shortened: number;
  /** Up to 50 changed accounts, for the operator to look at. */
  sample: { id: string; before: Date | null; after: Date | null }[];
};

/**
 * recomputePlus for many accounts at once, with a report of what changes. Every account, or only `userIds`. With
 * `dryRun` nothing is written: the report says what the same call would do. scripts/recompute-plus-all.ts is the CLI.
 */
export async function recomputePlusAll({ dryRun = false, userIds }: { dryRun?: boolean; userIds?: string[] } = {}): Promise<PlusRecompute> {
  const scope = userIds ? sql`where u.id = any(${userIds}::uuid[])` : sql``;
  const calc = sql`select u.id, u.plus_until as before, ${derivedPlusUntil()} as after from users u ${scope}`;
  return sql.begin(async tx => {
    const [r] = await tx`with calc as (${calc}) select count(*)::int as users,
        count(*) filter (where before > now())::int as plus_before,
        count(*) filter (where after > now())::int as plus_after,
        count(*) filter (where before is distinct from after)::int as changed,
        count(*) filter (where after > now() and not coalesce(before > now(), false))::int as gained,
        count(*) filter (where before > now() and not coalesce(after > now(), false))::int as lost,
        count(*) filter (where before > now() and after > now() and after > before)::int as extended,
        count(*) filter (where before > now() and after > now() and after < before)::int as shortened,
        coalesce((select json_agg(x) from (select id, before, after from calc where before is distinct from after order by id limit 50) x), '[]'::json) as sample
      from calc`;
    if (!dryRun) await tx`update users u set plus_until = ${derivedPlusUntil()}
      where u.plus_until is distinct from ${derivedPlusUntil()} ${userIds ? sql`and u.id = any(${userIds}::uuid[])` : sql``}`;
    return { ...r, sample: (r.sample as any[]).map(x => ({ id: x.id, before: x.before ? new Date(x.before) : null, after: x.after ? new Date(x.after) : null })) } as PlusRecompute;
  });
}

/**
 * Launch offer for one new account: comp_until becomes the end of the offer (or stays where it is, when it is later: an admin
 * comp, a referral stacked after it), then Plus is derived as always. False when no offer is running. Never lowers anything.
 */
export async function grantLaunchPlus(userId: string, now: Date = clock.now()): Promise<boolean> {
  const offer = launchOffer(now);
  if (!offer.active || !offer.until) return false;
  await sql`update users set comp_until = greatest(comp_until, ${offer.until}::timestamptz) where id = ${userId}`;
  await recomputePlus(userId);
  return true;
}

export type LaunchGrant = {
  until: Date;
  /** Accounts that are in scope (not deleted, not banned). */
  users: number;
  /** Their comp_until was lower than the offer's end (or empty): it is raised to it. */
  granted: number;
  /** Of those, how many have no Plus now / have Plus that ends before the offer does: they get Plus until the end. */
  gained: number; extended: number;
  /** Plus beyond the offer's end already (a subscription, a pass, an admin comp): their Plus is left as it is. */
  alreadyBeyond: number;
};

/**
 * The launch offer for existing accounts: comp_until = greatest(comp_until, end of the offer), and Plus recomputed for those
 * whose Plus ends before the offer does. Safe to repeat (a second run finds nothing to grant), and it never lowers anyone's
 * plus_until: accounts that already have Plus beyond the end are not recomputed, so a hand-set date is left alone.
 * Every account, or only `userIds`; with `dryRun` nothing is written. scripts/grant-launch-plus.ts is the command line.
 */
export async function grantLaunchPlusAll({ dryRun = false, userIds, now = clock.now() }: { dryRun?: boolean; userIds?: string[]; now?: Date } = {}): Promise<LaunchGrant> {
  const offer = launchOffer(now);
  if (!offer.active || !offer.until) throw new Error('launch_offer_not_active');
  const until = offer.until;
  const scope = userIds ? sql`and u.id = any(${userIds}::uuid[])` : sql``;
  return sql.begin(async tx => {
    const [r] = await tx`select count(*)::int as users,
        count(*) filter (where u.comp_until is null or u.comp_until < ${until}::timestamptz)::int as granted,
        count(*) filter (where (u.comp_until is null or u.comp_until < ${until}::timestamptz) and (u.plus_until is null or u.plus_until <= ${now}::timestamptz))::int as gained,
        count(*) filter (where (u.comp_until is null or u.comp_until < ${until}::timestamptz) and u.plus_until > ${now}::timestamptz and u.plus_until < ${until}::timestamptz)::int as extended,
        count(*) filter (where u.plus_until >= ${until}::timestamptz)::int as already_beyond
      from users u where u.deleted_at is null and u.banned_at is null ${scope}`;
    if (!dryRun) {
      const rows = await tx`update users u set comp_until = ${until}::timestamptz
        where u.deleted_at is null and u.banned_at is null and (u.comp_until is null or u.comp_until < ${until}::timestamptz) ${scope}
        returning u.id`;
      // Derive Plus for the accounts that now end later than they did; the rest keep what they have.
      if (rows.length) await tx`update users u set plus_until = ${derivedPlusUntil()}
        where u.id = any(${rows.map(x => x.id as string)}::uuid[]) and (u.plus_until is null or u.plus_until < ${until}::timestamptz)`;
    }
    return { until, users: r.users, granted: r.granted, gained: r.gained, extended: r.extended, alreadyBeyond: r.alreadyBeyond } as LaunchGrant;
  });
}

/**
 * Verify a one-time Trip Pass with Google, grant PASS_DAYS of Plus stacked after any
 * access the user already has, then consume it so it can be bought again next trip.
 * Idempotent per token: a retry returns the same window instead of granting twice.
 */
export async function verifyGooglePass(userId: string, purchaseToken: string) {
  const client = await playClient();
  const { data } = await client.request<any>({ url: passUrl(purchaseToken) });
  if (data.purchaseState !== 0) throw new Error(data.purchaseState === 2 ? 'pass_pending' : 'pass_not_purchased');
  const expires = await grantPass(userId, purchaseToken, data.orderId ?? null, data);
  // Consuming acknowledges the pass (Google refunds it after 3 days otherwise) and lets it be bought again next trip. A failure
  // is tracked and retried by the safety net (lib/play-ack.ts), which tells the owner if it still fails a day later.
  if (data.consumptionState === 0) {
    await markAckPending('pass', purchaseToken, Number(data.purchaseTimeMillis) > 0 ? new Date(Number(data.purchaseTimeMillis)) : null);
    acknowledgeInBackground('pass', PASS_SKU, purchaseToken);
  } else await markAcknowledged('pass', purchaseToken);
  // One alert per Play order (a retry or the next app start finds it sent). Without an order id, a hash of the token keys it.
  const orderId = playOrderId(data.orderId);
  ownerSaleAlert(orderId ? `play:order:${orderId}` : `play:pass:${tokenRef(purchaseToken)}`, async () => {
    const order = await playOrder(orderId);
    return {
      kind: 'pass_purchase', provider: 'google_play', userId, product: playProduct(PASS_SKU),
      amountMinor: order?.total?.amountMinor ?? null, currency: order?.total?.currency ?? null,
      amountNote: data.purchaseType === 1 ? 'promo code: no money' : order?.total ? "order total, before Google's fee" : null,
      ids: { playOrderId: orderId }, test: data.purchaseType === 0 ? 'Google Play test purchase (license tester)' : null,
      at: Number(data.purchaseTimeMillis) > 0 ? new Date(Number(data.purchaseTimeMillis)) : null,
      details: [['Plus until', istDate(expires ? new Date(expires) : null)], ['Paid with', data.purchaseType === 1 ? 'a Play promo code' : null], ['Play region', data.regionCode]],
    };
  });
  if (orderId && (await hasAffiliateReferral(userId))) {
    await accruePlayCharge(userId, PASS_SKU, orderId, { order: await playOrder(orderId), test: data.purchaseType === 0, promo: data.purchaseType === 1,
      at: Number(data.purchaseTimeMillis) > 0 ? new Date(Number(data.purchaseTimeMillis)) : null })
      .catch(e => console.error('affiliate commission failed', orderId, (e as Error).message));
  }
  return { active: true, expiresAt: expires };
}

// --- owner sale alerts (lib/owner-alerts.ts) -----------------------------------------------------------------------------------
/** A Play order id we can key on and show (GPA.1234-5678-9012-34567, renewals add ..0, ..1). Never a purchase token. */
const playOrderId = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9._-]{6,64}$/.test(v) ? v : null);
const tokenRef = (token: string) => crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
const PLAY_STATE: Record<string, string> = {
  SUBSCRIPTION_STATE_ACTIVE: 'active', SUBSCRIPTION_STATE_CANCELED: 'cancelled (Plus until the paid period ends)',
  SUBSCRIPTION_STATE_IN_GRACE_PERIOD: 'grace period (renewal payment failed, Plus still on)', SUBSCRIPTION_STATE_ON_HOLD: 'on hold (renewal payment failed, Plus off)',
  SUBSCRIPTION_STATE_PAUSED: 'paused', SUBSCRIPTION_STATE_EXPIRED: 'expired', SUBSCRIPTION_STATE_PENDING: 'pending payment',
  SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED: 'pending purchase cancelled',
};
const playTest = (data: any) => (data?.testPurchase ? 'Google Play test purchase (license tester)' : null);

/**
 * The order's total from the Play Orders API, and what was refunded, best effort: null when Google can't say (test orders,
 * no access, a timeout). Only the amounts are read: never the buyer's address or tax details.
 */
export async function playOrder(orderId: string | null) {
  if (!orderId) return null;
  try {
    const client = await playClient();
    const { data } = await client.request<any>({ url: `${base()}/orders/${encodeURIComponent(orderId)}`, timeout: 5000 });
    const h = data?.orderHistory ?? {};
    // A full refund is refundEvent; partial refunds are each a partialRefundEvent.
    const partial = (Array.isArray(h.partialRefundEvents) ? h.partialRefundEvents : []).map((e: any) => playMoney(e?.refundDetails?.total)).filter(Boolean) as { amountMinor: number; currency: string }[];
    const refunded = playMoney(h.refundEvent?.refundDetails?.total)
      ?? (partial.length && partial.every(p => p.currency === partial[0].currency) ? { amountMinor: partial.reduce((n, p) => n + p.amountMinor, 0), currency: partial[0].currency } : null);
    // tax and developerRevenueInBuyerCurrency (our revenue after Google's fee and the taxes it collects) for a partner's commission
    // (lib/affiliate-ledger.ts playNet); state to leave a refunded or cancelled order out of it.
    return { total: playMoney(data?.total), refunded, tax: playMoney(data?.tax), developerRevenue: playMoney(data?.developerRevenueInBuyerCurrency), state: typeof data?.state === 'string' ? data.state : null };
  } catch { return null; }
}

/**
 * One alert per Play subscription order: the purchase, then each renewal (Google gives every renewal its own order id,
 * GPA.x..0, GPA.x..1). The app's verify call and the RTDN push both land here with Google's own copy of the subscription, so
 * whichever comes first alerts and the other finds the order taken. Only an order Google reports as paid counts.
 */
function playChargeAlert(userId: string, productId: string, data: any, notificationType?: number) {
  const line = (data.lineItems ?? [])[0] ?? {};
  const orderId = playOrderId(line.latestSuccessfulOrderId) ?? (data.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE' ? playOrderId(data.latestOrderId) : null);
  if (!orderId) return;
  const kind: SaleKind = notificationType === 1 ? 'renewal_recovered' : /\.\.\d+$/.test(orderId) ? 'renewal' : 'subscription_started';
  ownerSaleAlert(`play:order:${orderId}`, async () => {
    const order = await playOrder(orderId);
    const list = playMoney(line.autoRenewingPlan?.recurringPrice);
    const amount = order?.total ?? list;
    return {
      kind, provider: 'google_play', userId, product: playProduct(productId, line.offerDetails?.basePlanId),
      amountMinor: amount?.amountMinor ?? null, currency: amount?.currency ?? null,
      amountNote: order?.total ? "order total, before Google's fee" : list ? 'list price; Google did not report the order total' : null,
      ids: { playOrderId: orderId }, test: playTest(data),
      details: [['Play state', PLAY_STATE[data.subscriptionState] ?? null], ['Plus until', istDate(line.expiryTime ? new Date(line.expiryTime) : null)],
        ['Auto-renew', line.autoRenewingPlan ? (line.autoRenewingPlan.autoRenewEnabled === false ? 'off' : 'on') : null],
        ['Replaces', data.linkedPurchaseToken ? 'an earlier Play purchase (upgrade, downgrade or resubscribe)' : null],
        // The intro offer it was bought with, in words (lib/play-offers.ts). A free trial starts with an order of 0: the words say
        // so, so the alert doesn't read as a lost sale.
        ['Offer', playOfferLabel(playOfferId(data), config.playYearlyTrialOfferId)],
        ['Play region', data.regionCode]],
    };
  });
}

/**
 * RTDN subscription notifications that get an alert of their own (charges are playChargeAlert). 3 SUBSCRIPTION_CANCELED is the
 * customer (or Google) turning renewal off while Plus runs to the end of the paid period, so it reads "Cancellation requested";
 * 13 EXPIRED is the end.
 */
const PLAY_STATUS: Record<number, SaleKind> = { 3: 'cancel_requested', 5: 'on_hold', 6: 'grace', 7: 'resubscribed', 10: 'paused', 12: 'revoked', 13: 'ended', 17: 'plan_change' };
const CANCEL_BY = (c: any) => c?.userInitiatedCancellation ? 'the customer' : c?.systemInitiatedCancellation ? 'Google (billing problem)'
  : c?.developerInitiatedCancellation ? 'us (developer)' : c?.replacementCancellation ? 'replaced by a new purchase' : null;

/** An RTDN status change, keyed on the notification type and the subscription's latest order (one per type per period). */
function playStatusAlert(userId: string, productId: string, data: any, notificationType: number, messageId?: string) {
  const kind = PLAY_STATUS[notificationType];
  if (!kind) return;
  const line = (data.lineItems ?? [])[0] ?? {};
  const orderId = playOrderId(data.latestOrderId) ?? playOrderId(line.latestSuccessfulOrderId);
  const ref = orderId ?? (typeof messageId === 'string' && /^\d{1,30}$/.test(messageId) ? `msg:${messageId}` : null);
  if (!ref) return;
  const list = playMoney(line.autoRenewingPlan?.recurringPrice);
  ownerSaleAlert(`play:${notificationType}:${ref}`, () => ({
    kind, provider: 'google_play', userId, product: playProduct(productId, line.offerDetails?.basePlanId),
    amountMinor: list?.amountMinor ?? null, currency: list?.currency ?? null, amountNote: list ? 'list price per period; not a charge' : null,
    ids: { playOrderId: orderId }, test: playTest(data),
    details: [['Play state', PLAY_STATE[data.subscriptionState] ?? null], ['Cancelled by', notificationType === 3 ? CANCEL_BY(data.canceledStateContext) : null],
      ['Plus until', istDate(line.expiryTime ? new Date(line.expiryTime) : null)], ['Play region', data.regionCode]],
  }));
}

/**
 * RTDN voidedPurchaseNotification: Google refunded or charged back an order (a Trip Pass or a subscription payment). The
 * caller has checked that the purchase is ours (and, for a pass, that Google no longer reports it as purchased).
 */
export function alertPlayVoided(userId: string, productId: string, voided: { orderId?: unknown; refundType?: unknown; voidedReason?: unknown }, basePlanId?: string | null, test?: boolean) {
  const orderId = playOrderId(voided.orderId);
  if (!orderId) return;
  const chargeback = playVoidKind(voided.voidedReason) === 'dispute';
  ownerSaleAlert(`play:void:${orderId}`, async () => {
    const order = await playOrder(orderId);
    const amount = order?.refunded ?? order?.total ?? null;
    return {
      kind: chargeback ? 'dispute' : 'refund', provider: 'google_play', userId, product: playProduct(productId, basePlanId),
      amountMinor: amount?.amountMinor ?? null, currency: amount?.currency ?? null,
      amountNote: order?.refunded ? 'refunded' : order?.total ? 'order total; Google did not report the refunded amount' : null,
      ids: { playOrderId: orderId }, test: test ? 'Google Play test purchase (license tester)' : null,
      details: [['Refund', chargeback ? 'chargeback (Google handles it in the Play Console)' : voided.refundType === 2 ? 'partial' : 'full'],
        ['Plus from it', productId === PASS_SKU ? 'Trip Pass voided' : 'ended now; renewal cancelled']],
    };
  });
}

/** PASS_DAYS of Plus stacked after any access the user already has. Idempotent per token (Play or Razorpay). */
export async function grantPass(userId: string, purchaseToken: string, orderId: string | null, raw: any) {
  const [existing] = await sql`select user_id, expires_at from passes where purchase_token = ${purchaseToken}`;
  if (existing && existing.userId !== userId) throw new Error('token_owned_by_other_user');
  let expires = existing?.expiresAt as Date | undefined;
  if (!existing) {
    const [row] = await sql`insert into passes (purchase_token, user_id, product_id, order_id, expires_at, raw)
      select ${purchaseToken}, ${userId}, ${PASS_SKU}, ${orderId},
        greatest(now(), coalesce(u.plus_until, now())) + ${PASS_DAYS + ' days'}::interval, ${sql.json(raw)}
      from users u where u.id = ${userId}
      on conflict (purchase_token) do nothing returning expires_at`;
    expires = row?.expiresAt;
  }
  await recomputePlus(userId);
  return expires ?? null;
}

/**
 * A refunded or charged-back Trip Pass stops counting towards Plus. With `check`, Google must
 * confirm the purchase is no longer in the purchased state first, so a forged push can't revoke it.
 */
export async function voidPass(purchaseToken: string, check = true) {
  // Without Play credentials no pass can have been granted, so there's nothing to protect.
  if (check && playAuth()) {
    const client = await playClient();
    const { data } = await client.request<any>({ url: `${base()}/purchases/products/${PASS_SKU}/tokens/${encodeURIComponent(purchaseToken)}` });
    if (data.purchaseState === 0) return false;
  }
  const [p] = await sql`update passes set voided_at = now() where purchase_token = ${purchaseToken} and voided_at is null returning user_id`;
  if (p) await recomputePlus(p.userId);
  return !!p;
}

/**
 * Ask Google whether a subscription purchase token is live, then store it and
 * extend users.plus_until. Never trusts anything the app claims about a purchase.
 * `rtdn` is the notification that prompted the check (billing.ts), for the owner's alert about it.
 */
export async function verifyGoogleSubscription(userId: string, productId: string, purchaseToken: string, rtdn?: { notificationType?: number; messageId?: string }) {
  const client = await playClient();
  const { data } = await client.request<any>({ url: subscriptionUrl(purchaseToken) });
  const line = (data.lineItems ?? [])[0];
  const expires = line?.expiryTime ? new Date(line.expiryTime) : null;
  const active = ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'].includes(data.subscriptionState);
  // A token already bound to another account must not unlock this one.
  const [existing] = await sql`select user_id from subscriptions where purchase_token = ${purchaseToken}`;
  if (existing && existing.userId !== userId) throw new Error('token_owned_by_other_user');
  // offer_id: the intro offer it was bought with (lib/play-offers.ts), kept from the first copy that names one.
  await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, raw, offer_id)
    values (${purchaseToken}, ${userId}, 'google', ${productId}, ${data.subscriptionState}, ${expires}, ${sql.json(data)}, ${playOfferId(data)})
    on conflict (purchase_token) do update set status = excluded.status, expires_at = excluded.expires_at, raw = excluded.raw,
      offer_id = coalesce(subscriptions.offer_id, excluded.offer_id), updated_at = now()`;
  await recomputePlus(userId);
  // Acknowledge within 3 days or Google refunds it automatically. A payment that is still pending can't be acknowledged yet
  // (Google's purchase notification brings it back here once paid). A failure is tracked and retried by the safety net
  // (lib/play-ack.ts), which tells the owner if it still fails a day later.
  const unpaid = ['SUBSCRIPTION_STATE_PENDING', 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED'].includes(data.subscriptionState);
  if (data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && !unpaid) {
    await markAckPending('subscription', purchaseToken, data.startTime ? new Date(data.startTime) : null);
    acknowledgeInBackground('subscription', productId, purchaseToken);
  } else if (data.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') await markAcknowledged('subscription', purchaseToken);
  // A charge alert from the app's own verify call (a purchase) or a charge notification (1 recovered, 2 renewed, 4 purchased);
  // not from a status change, which would otherwise announce an old order that was never alerted as if it were new.
  if (!rtdn || [1, 2, 4].includes(rtdn.notificationType ?? -1)) {
    playChargeAlert(userId, productId, data, rtdn?.notificationType);
    await affiliatePlayCharge(userId, productId, data);
  }
  // 12 SUBSCRIPTION_REVOKED: Google refunded and took the subscription back. Its latest order earns no partner commission.
  if (rtdn?.notificationType === 12 && data.subscriptionState === 'SUBSCRIPTION_STATE_EXPIRED') {
    const revoked = playOrderId(line?.latestSuccessfulOrderId) ?? playOrderId(data.latestOrderId);
    if (revoked) await voidCommission(`play:order:${revoked}`, 'revoked');
  }
  if (typeof rtdn?.notificationType === 'number') playStatusAlert(userId, productId, data, rtdn.notificationType, rtdn.messageId);
  return { active, expiresAt: expires };
}

/**
 * A partner's commission on the subscription's latest paid order (lib/affiliate-ledger.ts), from Google's own copy of the purchase.
 * Google's order is read only for customers a partner referred. Never fails the verify call or the RTDN.
 */
async function affiliatePlayCharge(userId: string, productId: string, data: any) {
  const line = (data.lineItems ?? [])[0] ?? {};
  const orderId = playOrderId(line.latestSuccessfulOrderId) ?? (data.subscriptionState === 'SUBSCRIPTION_STATE_ACTIVE' ? playOrderId(data.latestOrderId) : null);
  if (!orderId) return;
  try {
    if (!(await hasAffiliateReferral(userId))) return;
    await accruePlayCharge(userId, productId, orderId, { order: await playOrder(orderId), listPrice: playMoney(line.autoRenewingPlan?.recurringPrice),
      test: !!data.testPurchase, offerId: playOfferId(data) });
  } catch (e) { console.error('affiliate commission failed', orderId, (e as Error).message); }
}

/** How far back the voided-purchases list is read: the RTDN check and the hourly sweep (lib/billing-reconcile.ts). */
export const PLAY_VOIDED_LOOKBACK_DAYS = 3;

export type PlayVoided = { purchaseToken: string; orderId?: string; voidedReason?: number; voidedSource?: number; voidedTimeMillis?: string; kind?: string };

/**
 * Google's list of voided purchases (refunds and chargebacks) since `sinceMs`, subscriptions and Trip Passes (type=1). Throws
 * when Google can't be read, so an RTDN is answered 5xx and redelivered.
 */
export async function listPlayVoided(sinceMs: number): Promise<PlayVoided[]> {
  const client = await playClient();
  const out: PlayVoided[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const q = new URLSearchParams({ startTime: String(Math.floor(sinceMs)), type: '1', maxResults: '1000', ...(token ? { token } : {}) });
    const { data } = await client.request<any>({ url: `${base()}/purchases/voidedpurchases?${q}`, timeout: 10_000 });
    out.push(...(Array.isArray(data?.voidedPurchases) ? data.voidedPurchases : []));
    token = data?.tokenPagination?.nextPageToken;
    if (!token) break;
  }
  return out;
}

/**
 * A voided Play subscription purchase (SC-10, SC-13 for Play): Google refunded or charged back an order of it. Any refund on a
 * subscription ends its Plus now (rule 4), so the row is ended (ended_reason, never counted again) and its renewal is cancelled
 * at Google. Only acts on a token Google itself lists as voided, so a forged push can't end anyone's Plus. Returns what it did.
 * `listed` is Google's entry when the caller already read the list (the sweep); `refundType` is the RTDN's.
 */
export async function handlePlayVoidedSubscription(purchaseToken: string, listed?: PlayVoided, refundType?: unknown): Promise<'not_ours' | 'not_voided' | 'already_ended' | 'ended'> {
  const [row] = await sql`select user_id, product_id, ended_reason, raw->'lineItems'->0->'offerDetails'->>'basePlanId' as base_plan, raw ? 'testPurchase' as test
    from subscriptions where purchase_token = ${purchaseToken} and platform = 'google'`;
  if (!row) return 'not_ours';
  const v = listed ?? (await listPlayVoided(Date.now() - PLAY_VOIDED_LOOKBACK_DAYS * 86400_000)).find(x => x.purchaseToken === purchaseToken);
  if (!v) return 'not_voided';
  // The list doesn't say full or partial; the RTDN does (refundType 2 = partial).
  alertPlayVoided(row.userId, row.productId, { ...v, refundType }, row.basePlan, !!row.test);
  // The voided order's partner commission is void (clawed back if it was already paid out).
  const voidedOrder = playOrderId(v.orderId);
  if (voidedOrder) await voidCommission(`play:order:${voidedOrder}`, playVoidKind(v.voidedReason) === 'dispute' ? 'chargeback' : 'refund');
  if (row.endedReason) return 'already_ended';
  // Stop the next renewal first: if Google can't be reached the error is thrown before anything is marked, so the RTDN is
  // answered 500 and redelivered (or the next hourly sweep tries again). Google refusing it (4xx: already revoked or
  // cancelled) is an answer, not a failure.
  const client = await playClient();
  await client.request({ url: `${base()}/purchases/subscriptions/${encodeURIComponent(row.productId)}/tokens/${encodeURIComponent(purchaseToken)}:cancel`, method: 'POST' })
    .catch(e => { if (isTransient(e)) throw e; });
  await sql`update subscriptions set ended_reason = ${playVoidKind(v.voidedReason)}, updated_at = now()
    where purchase_token = ${purchaseToken} and ended_reason is null`;
  await recomputePlus(row.userId);
  return 'ended';
}
