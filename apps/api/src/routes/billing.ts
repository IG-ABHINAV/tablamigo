import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../lib/auth.js';
import { PRODUCTS, LIMITS, isPlus, launchOffer, allFree } from '../lib/plus.js';
import { verifyGoogleSubscription, verifyGooglePass, voidPass, alertPlayVoided, handlePlayVoidedSubscription, PASS_SKU, PASS_DAYS } from '../lib/play.js';
import { isTransient, reactivationStartAt, playVoidKind } from '../lib/billing-policy.js';
import { sql } from '../lib/db.js';
import { bad, HttpError } from '../lib/errors.js';
import { config } from '../lib/config.js';
import { yearlyTrialOfferId } from '../lib/plus-intro.js';
import { OAuth2Client } from 'google-auth-library';
import { accrueRazorpayPayment, couponAffiliate } from '../lib/affiliates.js';
import { voidPlayOrder } from '../lib/affiliate-ledger.js';
import { RAZORPAY_PRICES, razorpayOn, sellablePeriods, createPassOrder, verifyRazorpayPass, createSubscription, verifyRazorpaySubscription, cancelRazorpaySubscription, liveRazorpaySub, syncRazorpay, assertCanBuyOnWeb, waitingToStart } from '../lib/razorpay.js';

const oidc = new OAuth2Client();
/**
 * Pub/Sub push is accepted with the URL secret or a Google-signed token from our push service account. With neither
 * configured, development accepts any post (tests and local runs post notifications by hand); production refuses every post,
 * and config.ts refuses to start production without one.
 */
async function rtdnAuthorized(req: FastifyRequest) {
  const token = (req.query as any)?.token;
  if (config.rtdnToken && token === config.rtdnToken) return true;
  const jwt = req.headers.authorization?.replace(/^Bearer /, '');
  if (jwt && config.rtdnPushEmail) {
    try {
      const t = await oidc.verifyIdToken({ idToken: jwt, audience: `${config.publicUrl}/billing/google/rtdn` });
      const p = t.getPayload();
      return p?.email === config.rtdnPushEmail && p.email_verified === true;
    } catch { return false; }
  }
  return !config.isProd && !config.rtdnToken && !config.rtdnPushEmail;
}

// Web checkout failures: the app shows its own copy for `code`; `reason` is for logs and tests.
const failed = (code: string, e: any) => new HttpError(400, code, undefined, { reason: e?.message });
const rzpBody = z.object({ paymentId: z.string().min(5).max(60), signature: z.string().min(10).max(200) });

/** The launch offer's end as people in India read it ("31 December 2026"): the offer is set in IST. */
const offerDay = (d: Date) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'long', year: 'numeric' }).format(d);
/**
 * While the launch offer runs, Plus is free for everyone, so Razorpay refuses to start a purchase (an order or a subscription).
 * Finishing one that was already paid for (the verify calls) still works, and Google Play purchases can't be refused here.
 */
const refuseWhileFree = () => {
  if (allFree()) throw new HttpError(409, 'all_free', 'Everything in Tablamigo is free right now, so there is nothing to buy.');
  const offer = launchOffer();
  if (offer.active && offer.until) {
    throw new HttpError(409, 'launch_offer_free', `Plus is free for everyone until ${offerDay(offer.until)}, so there is nothing to buy right now. Enjoy it!`, { until: offer.until.toISOString() });
  }
};

/**
 * A partner's commission on a web payment the checkout just verified (lib/affiliates.ts re-reads it from Razorpay). The forwarded
 * subscription.charged or payment.captured records the same payment once more (idempotent); this covers a forward that never
 * arrives. Never fails the purchase.
 */
const partnerCommission = (req: FastifyRequest, paymentId: string) =>
  accrueRazorpayPayment(paymentId).catch(e => { req.log.error({ err: e, paymentId }, 'affiliate commission failed'); });

export default async function billing(app: FastifyInstance) {
  // What the paywall and the account screen show: whether the caller has Plus and until when, the prices, the limits, the
  // caller's web subscription, and the launch offer ({ active, until }: "Free until <date>"). /billing/me is the same call.
  const plans = async (req: FastifyRequest) => {
    const uid = await requireUser(req);
    await syncRazorpay(uid).catch(e => req.log.error(e));
    const [u] = await sql`select plus_until from users where id = ${uid}`;
    const { currency, monthly, halfyearly, yearly, pass } = RAZORPAY_PRICES;
    // halfyearly only once its Razorpay plan exists (RAZORPAY_PLAN_HALFYEARLY): the web paywall lists the plans it finds here.
    const sixMonths = sellablePeriods().includes('halfyearly') ? { halfyearly } : {};
    const razorpay = razorpayOn() ? { keyId: config.razorpay.keyId, currency, prices: { monthly, ...sixMonths, yearly, pass }, subscription: await liveRazorpaySub(uid) } : null;
    // A live subscription that will charge again (not cancelled), so the app's paywall doesn't sell a second one: 'google' or
    // 'razorpay'. Grace period counts: the renewal is still being retried.
    // A Reactivate subscription waiting for its first charge renews too.
    const [r] = await sql`select platform from subscriptions s where s.user_id = ${uid} and s.cancel_requested_at is null and s.ended_reason is null
      and ((s.expires_at > now() and s.status in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') and s.platform in ('google', 'razorpay')) or ${waitingToStart()})
      order by s.expires_at desc nulls last limit 1`;
    return { plus: await isPlus(uid), plusUntil: u?.plusUntil ?? null, renewing: (r?.platform as 'google' | 'razorpay' | undefined) ?? null, products: PRODUCTS, pass: { id: PASS_SKU, days: PASS_DAYS }, limits: LIMITS, razorpay, launchOffer: launchOffer(), allFree: allFree(),
      // The yearly plan's Play free-trial offer (PLAY_YEARLY_TRIAL_OFFER_ID), or null: no trial text, no trial purchase. Since
      // 2 Nov 2026 the trial includes a discounted first year, which apps before 1.4.2 would describe as "then <full price>/year":
      // those read playYearlyTrialOfferId, which stays null, so they never offer it. Current apps read playTrialOfferId.
      playYearlyTrialOfferId: null, playTrialOfferId: yearlyTrialOfferId() };
  };
  app.get('/billing/plans', plans);
  app.get('/billing/me', plans);

  // Razorpay Checkout (web app). Orders and subscriptions carry notes.service = 'tablamigo' and the user id.
  const checkout = async (uid: string, description: string) => {
    if (!razorpayOn()) throw bad('payments_unavailable');
    const [u] = await sql`select email from users where id = ${uid}`;
    return { keyId: config.razorpay.keyId, name: config.appName, description, prefill: { email: u?.email ?? '' } };
  };

  app.post('/billing/razorpay/pass-order', async req => {
    const uid = await requireUser(req);
    refuseWhileFree();
    await assertCanBuyOnWeb(uid);
    const base = await checkout(uid, `Trip Pass · ${PASS_DAYS} days of Plus`);
    try {
      const o = await createPassOrder(uid);
      return { ...base, orderId: o.id, amount: o.amount, currency: o.currency, notes: o.notes };
    } catch (e: any) { req.log.error(e); throw failed('checkout_failed', e); }
  });

  app.post('/billing/razorpay/pass-verify', async req => {
    const uid = await requireUser(req);
    const b = rzpBody.extend({ orderId: z.string().min(5).max(60) }).parse(req.body);
    let r;
    try { r = await verifyRazorpayPass(uid, b.orderId, b.paymentId, b.signature); }
    catch (e: any) { req.log.error(e); throw failed('verify_failed', e); }
    await partnerCommission(req, b.paymentId);
    return r;
  });

  app.post('/billing/razorpay/subscribe', async req => {
    const uid = await requireUser(req);
    refuseWhileFree();
    const { period, coupon } = z.object({ period: z.enum(['monthly', 'halfyearly', 'yearly']), coupon: z.string().trim().max(40).optional() }).parse(req.body);
    if (!sellablePeriods().includes(period)) throw bad('plan_not_available');
    const base = await checkout(uid, `Plus · ${{ monthly: '1 month', halfyearly: '6 months', yearly: '1 year' }[period]}`);
    await assertCanBuyOnWeb(uid);
    const live = await liveRazorpaySub(uid);
    if (live && !live.cancelled) throw bad('already_subscribed');
    // A partner's code as a coupon (lib/affiliates.ts): refused before anything is created at Razorpay if it isn't usable.
    const partner = coupon ? await couponAffiliate(coupon, uid) : undefined;
    // Subscribing again while a cancelled subscription still has paid time (Reactivate, SC-09): the first charge is at its end.
    const startAt = live ? reactivationStartAt(live.paidEnd, Math.floor(Date.now() / 1000)) : null;
    try {
      const s = await createSubscription(uid, period, startAt && live ? { startAt, replaces: live.id } : undefined, partner);
      return { ...base, subscriptionId: s.id, notes: s.notes, firstChargeAt: startAt ? new Date(startAt * 1000).toISOString() : null, coupon: partner ? { code: partner.code, discounted: !!partner.offerId } : null };
    } catch (e: any) { req.log.error(e); throw failed('checkout_failed', e); }
  });

  app.post('/billing/razorpay/subscription-verify', async req => {
    const uid = await requireUser(req);
    const b = rzpBody.extend({ subscriptionId: z.string().min(5).max(60) }).parse(req.body);
    let r;
    try { r = await verifyRazorpaySubscription(uid, b.subscriptionId, b.paymentId, b.signature); }
    catch (e: any) { req.log.error(e); throw failed('verify_failed', e); }
    if (r.active) await partnerCommission(req, b.paymentId);
    return r;
  });

  app.post('/billing/razorpay/cancel', async req => {
    const uid = await requireUser(req);
    try { return await cancelRazorpaySubscription(uid); }
    catch (e: any) { req.log.error(e); throw failed('cancel_failed', e); }
  });

  app.post('/billing/google/verify', async req => {
    const uid = await requireUser(req);
    const { productId, purchaseToken } = z.object({ productId: z.string(), purchaseToken: z.string().min(10) }).parse(req.body);
    try { return productId === PASS_SKU ? await verifyGooglePass(uid, purchaseToken) : await verifyGoogleSubscription(uid, productId, purchaseToken); }
    catch (e: any) { req.log.error(e); throw bad('verify_failed', e.message); }
  });

  // Real-time developer notifications from Google Play (Pub/Sub push). Re-checks the token with Google.
  // Push subscription URL: https://<api>/billing/google/rtdn (OIDC auth as RTDN_PUSH_EMAIL, audience = that URL)
  app.post('/billing/google/rtdn', async (req, reply) => {
    if (!(await rtdnAuthorized(req))) return reply.status(401).send({ error: 'unauthorized' });
    const body: any = req.body;
    const data = body?.message?.data ? JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8')) : null;
    const messageId = typeof body?.message?.messageId === 'string' ? body.message.messageId : undefined;
    // Refunds and chargebacks of one-time Trip Passes arrive as voided purchases (productType 2).
    const voided = data?.voidedPurchaseNotification;
    if (voided?.purchaseToken && voided.productType === 2) {
      await voidPass(voided.purchaseToken);
      // The owner's alert only once the pass is really voided (voidPass checked with Google first).
      const [p] = await sql`select user_id, raw->>'purchaseType' = '0' as test from passes where purchase_token = ${voided.purchaseToken} and voided_at is not null`;
      if (p) {
        alertPlayVoided(p.userId, PASS_SKU, voided, null, !!p.test);
        await voidPlayOrder(voided.orderId, playVoidKind(voided.voidedReason) === 'dispute');
      }
    }
    // A refunded or charged-back subscription payment ends that subscription's Plus now (rule 4), once Google's voided list
    // confirms it. Google unreadable: 500, so Pub/Sub delivers it again (rule 7).
    try {
      if (voided?.purchaseToken && voided.productType === 1) req.log.info({ result: await handlePlayVoidedSubscription(voided.purchaseToken, undefined, voided.refundType) }, 'play voided');
      const note = data?.subscriptionNotification;
      const token = note?.purchaseToken;
      if (token) {
        const [s] = await sql`select user_id, product_id from subscriptions where purchase_token = ${token}`;
        if (s) await verifyGoogleSubscription(s.userId, s.productId, token, { notificationType: Number(note.notificationType), messageId });
      }
    } catch (e: any) {
      req.log.error(e);
      if (isTransient(e)) return reply.status(500).send({ error: 'retry' });
    }
    return { ok: true };
  });
}
