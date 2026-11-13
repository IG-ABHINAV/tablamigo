/**
 * Creator partners (affiliates): Razorpay commissions and the admin side (routes/admin-affiliates.ts, the Affiliates tab of
 * apps/web/src/admin.html). The ledger itself (attribution, commissions, voids) is lib/affiliate-ledger.ts.
 *
 * Payouts are by hand today: the admin sends the money by UPI or bank transfer, then records it with its UTR here. The UTR is unique
 * and is the idempotency key of a payout. route_account_id is kept for Razorpay Route, which can automate this later.
 */
import { sql } from './db.js';
import { rzp } from './razorpay.js';
import { placePayment } from './billing-disputes.js';
import { PASS_SKU } from './play-client.js';
import { bad, notFound, HttpError } from './errors.js';
import { payoutForAdmin } from './partner-signup.js';
import { accrueCommission, attributeReferral, isReferralLoop, PARTNER_GONE, affiliateLinks, cleanAffiliateCode, normalizeUtr, payoutDue, razorpayNet, inrEquivalent, MIN_PAYOUT, DEFAULT_PERCENT, MAX_PERCENT, ESTIMATED_SOURCES, type AccrueResult } from './affiliate-ledger.js';

const enc = encodeURIComponent;
const PAY_ID = /^pay_[A-Za-z0-9]{6,40}$/;
const commissionable = (product: unknown) => product === PASS_SKU || /^tablamigo_plus_[a-z]+$/.test(String(product ?? ''));

/**
 * Commission on one Razorpay payment: a Plus subscription charge (first or renewal) or a web Trip Pass. Razorpay is asked for the
 * payment and whose it is (lib/billing-disputes.ts placePayment: its notes, or its invoice's subscription), so a forged or replayed
 * event can only ever record a real, captured payment of ours, once. A coupon given at checkout (notes.affiliate_code on the
 * subscription, set by our API) attributes the customer first. Event tickets are the host's money, not ours: no commission.
 */
export async function accrueRazorpayPayment(payId: string): Promise<AccrueResult | 'not_captured' | 'refunded' | 'not_ours' | 'not_commissionable'> {
  if (!PAY_ID.test(payId)) return 'invalid';
  const pay = await rzp('GET', `/payments/${enc(payId)}`);
  if (pay?.id !== payId || pay.status !== 'captured') return 'not_captured';
  if (Number(pay.amount_refunded) > 0) return 'refunded';
  const placed = await placePayment(pay);
  if (!placed) return 'not_ours';
  if (!commissionable(placed.product)) return 'not_commissionable';
  const coupon = cleanAffiliateCode(placed.sub?.notes?.affiliate_code);
  if (coupon) await attributeReferral(placed.userId, coupon, 'coupon', null);
  // Net of Razorpay's fee (owner, 3 Nov 2026), as Play charges are net of Google's.
  const amount = razorpayNet(pay);
  if (!amount) return 'zero';
  return accrueCommission({
    provider: 'razorpay', eventKey: `rzp:pay:${payId}`, userId: placed.userId, product: placed.product,
    grossMinor: amount.grossMinor, feeMinor: amount.feeMinor, netMinor: amount.netMinor, currency: String(pay.currency ?? ''), amountSource: amount.source,
    occurredAt: Number(pay.created_at) > 0 ? new Date(Number(pay.created_at) * 1000) : new Date(),
  });
}

/** A web checkout coupon: the partner it names, when it can be used by this customer (active, not their own). */
export async function couponAffiliate(raw: unknown, userId: string) {
  const code = cleanAffiliateCode(raw);
  const [a] = code ? await sql`select a.id, a.code, a.razorpay_offer_id, a.user_id, a.email, u.email as buyer_email
    from affiliates a join users u on u.id = ${userId} left join users pu on pu.id = a.user_id
    where a.code = ${code} and a.status = 'active' and not ${PARTNER_GONE}` : [];
  if (!a) throw bad('invalid_coupon', 'That code is not valid.');
  if (a.userId === userId || (a.email && a.buyerEmail && String(a.email).toLowerCase() === String(a.buyerEmail).toLowerCase())) throw bad('invalid_coupon', 'You cannot use your own partner code.');
  if (await isReferralLoop(sql, a.userId, userId)) throw bad('invalid_coupon', 'That partner joined through your code, so their code can\'t be used on your account.');
  return { code: a.code as string, offerId: (a.razorpayOfferId as string | null) ?? null };
}

// --- admin ---------------------------------------------------------------------------------------------------------------------
type MoneyRow = { currency: string; amountMinor: number; count: number };
const money = (rows: any) => (Array.isArray(rows) ? rows : []).map((r: any) => ({ currency: r.currency, amountMinor: Number(r.amountMinor ?? r.amount_minor), count: Number(r.count) })) as MoneyRow[];

function shape(a: any) {
  const owed = money(a.owed);
  return {
    id: a.id, code: a.code, name: a.name, email: a.email, userId: a.userId, status: a.status,
    percent: Number(a.commissionPercent), months: a.commissionMonths == null ? null : Number(a.commissionMonths),
    razorpayOfferId: a.razorpayOfferId, routeAccountId: a.routeAccountId, payoutNote: a.payoutNote, createdAt: a.createdAt,
    // 'self': the member joined from the app (lib/partner-signup.ts); 'admin': added here. payout: masked only in the list.
    source: a.source ?? 'admin', termsVersion: a.termsVersion ?? null, termsAcceptedAt: a.termsAcceptedAt ?? null, payout: a.payout ?? null,
    referrals: Number(a.referrals ?? 0), estimated: Number(a.estimated ?? 0),
    // INR and USD are paid as they are; any other currency is converted to INR on the payout day (`convert`), and only the admin's
    // rate then says whether it reached ₹1,000.
    owed: owed.map(o => ({ ...o, minimum: MIN_PAYOUT[o.currency] ?? MIN_PAYOUT.INR, convert: !(o.currency in MIN_PAYOUT), due: payoutDue(o.amountMinor, o.currency) })),
    paid: money(a.paid), voided: money(a.voided),
    links: affiliateLinks(a.code),
  };
}

const overviewSql = (where = sql``) => sql`select a.*,
    (select count(*) from affiliate_referrals r where r.affiliate_id = a.id) as referrals,
    (select count(*) from affiliate_commissions c where c.affiliate_id = a.id and c.status = 'pending' and c.amount_source = any(${ESTIMATED_SOURCES})) as estimated,
    (select json_agg(x) from (select currency, sum(commission_minor)::bigint as amount_minor, count(*) as count from affiliate_commissions
      where affiliate_id = a.id and status = 'pending' group by currency order by currency) x) as owed,
    (select json_agg(x) from (select currency, sum(amount_minor)::bigint as amount_minor, count(*) as count from affiliate_payouts
      where affiliate_id = a.id group by currency order by currency) x) as paid,
    (select json_agg(x) from (select currency, sum(commission_minor)::bigint as amount_minor, count(*) as count from affiliate_commissions
      where affiliate_id = a.id and kind = 'charge' and voided_at is not null group by currency order by currency) x) as voided,
    (select json_build_object('method', method, 'masked', masked, 'updatedAt', updated_at) from affiliate_payout_details where affiliate_id = a.id) as payout
  from affiliates a ${where} order by a.status = 'active' desc, a.created_at`;

export async function affiliatesOverview() {
  return { affiliates: (await overviewSql()).map(shape), minimums: MIN_PAYOUT, defaults: { percent: DEFAULT_PERCENT, maxPercent: MAX_PERCENT } };
}

export async function affiliateDetail(id: string) {
  const [a] = await overviewSql(sql`where a.id = ${id}`);
  if (!a) throw notFound();
  const [commissions, payouts, referrals, payout] = await Promise.all([
    sql`select c.id, c.provider, c.kind, c.product, c.gross_minor, c.fee_minor, c.net_minor, c.currency, c.amount_source, c.percent, c.commission_minor,
        c.status, c.void_reason, c.voided_at, c.payout_id, c.occurred_at, u.email, u.name
      from affiliate_commissions c left join users u on u.id = c.user_id where c.affiliate_id = ${id} order by c.occurred_at desc limit 500`,
    sql`select id, currency, amount_minor, source_currency, source_amount_minor, fx_rate, utr, note, paid_at from affiliate_payouts where affiliate_id = ${id} order by paid_at desc`,
    sql`select r.user_id, r.source, r.created_at, u.email, u.name from affiliate_referrals r join users u on u.id = r.user_id
      where r.affiliate_id = ${id} order by r.created_at desc limit 500`,
    payoutForAdmin(id),
  ]);
  const num = (r: any, keys: string[]) => ({ ...r, ...Object.fromEntries(keys.map(k => [k, Number(r[k])])) });
  return {
    // The detail (one partner, admin only) carries the payout details in full, to send the money.
    affiliate: { ...shape(a), payout },
    commissions: commissions.map(c => num(c, ['grossMinor', 'feeMinor', 'netMinor', 'percent', 'commissionMinor'])),
    payouts: payouts.map(p => ({ ...num(p, ['amountMinor']), sourceAmountMinor: p.sourceAmountMinor == null ? null : Number(p.sourceAmountMinor), fxRate: p.fxRate == null ? null : Number(p.fxRate) })),
    referrals,
  };
}

export type AffiliateInput = {
  code?: string; name?: string; email?: string | null; userEmail?: string | null; percent?: number; months?: number | null;
  razorpayOfferId?: string | null; routeAccountId?: string | null; payoutNote?: string | null; status?: 'active' | 'paused' | 'ended';
};

/** The partner's own Tablamigo account, by email (for the self-referral check). */
async function userIdOf(email: string | null | undefined) {
  if (!email) return null;
  const [u] = await sql`select id from users where email = ${email.toLowerCase()} and deleted_at is null`;
  if (!u) throw bad('user_not_found', 'No Tablamigo account has that email.');
  return u.id as string;
}

export async function createAffiliate(b: AffiliateInput) {
  const code = cleanAffiliateCode(b.code);
  if (!code) throw bad('invalid_code', 'Codes are 4 to 16 letters and digits.');
  // A partner code must not also be someone's friend-invite code: ?ref= and the install referrer carry both kinds.
  if ((await sql`select 1 from users where referral_code = ${code}`)[0]) throw new HttpError(409, 'code_taken', 'That code is already a member\'s invite code.');
  const userId = await userIdOf(b.userEmail ?? b.email ?? null).catch(e => (b.userEmail ? Promise.reject(e) : null));
  try {
    const [a] = await sql`insert into affiliates (code, name, email, user_id, commission_percent, commission_months, razorpay_offer_id, route_account_id, payout_note)
      values (${code}, ${b.name ?? code}, ${b.email ?? null}, ${userId}, ${b.percent ?? DEFAULT_PERCENT}, ${b.months ?? null}, ${b.razorpayOfferId ?? null},
        ${b.routeAccountId ?? null}, ${b.payoutNote ?? null}) returning id`;
    return affiliateDetail(a.id);
  } catch (e: any) {
    if (e?.code === '23505') throw new HttpError(409, 'code_taken', 'That code is already a partner\'s.');
    throw e;
  }
}

/** Percent, duration, status and details. A new percent or duration applies to charges from now on; recorded ones keep theirs. */
export async function updateAffiliate(id: string, b: AffiliateInput) {
  const [cur] = await sql`select id from affiliates where id = ${id}`;
  if (!cur) throw notFound();
  const set: Record<string, unknown> = {};
  if (b.name !== undefined) set.name = b.name;
  if (b.email !== undefined) set.email = b.email;
  if (b.userEmail !== undefined) set.user_id = await userIdOf(b.userEmail);
  if (b.percent !== undefined) set.commission_percent = b.percent;
  if (b.months !== undefined) set.commission_months = b.months;
  if (b.razorpayOfferId !== undefined) set.razorpay_offer_id = b.razorpayOfferId;
  if (b.routeAccountId !== undefined) set.route_account_id = b.routeAccountId;
  if (b.payoutNote !== undefined) set.payout_note = b.payoutNote;
  if (b.status !== undefined) set.status = b.status;
  if (Object.keys(set).length) await sql`update affiliates set ${sql(set)}, updated_at = now() where id = ${id}`;
  return affiliateDetail(id);
}

/**
 * Mark what is owed to a partner in one currency as paid, with the transfer's UTR. Everything owed in that currency at this moment
 * is paid (clawbacks included); `expectedMinor` is the amount the admin saw, so a charge or refund that landed since is never paid
 * blind. INR and USD are paid as they are, from their own minimum. Any other currency is paid in INR at `inrPerUnit`, the payout
 * day's rate the admin enters, once its INR equivalent reaches ₹1,000; the payout keeps the original amount and the rate. The same
 * UTR again for the same partner returns the payout it recorded (a double click, a retry); for anyone else it is refused.
 */
export async function recordPayout(affiliateId: string, b: { currency: string; utr: unknown; expectedMinor?: number; inrPerUnit?: number; note?: string | null; adminId: string }) {
  const utr = normalizeUtr(b.utr);
  if (!utr) throw bad('invalid_utr', 'Enter the UTR or UPI reference: 12 to 22 letters and digits.');
  const currency = String(b.currency ?? '').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw bad('invalid_input');
  const convert = !(currency in MIN_PAYOUT);
  if (convert && inrEquivalent(1, Number(b.inrPerUnit)) == null) throw bad('fx_rate_required', `Enter the INR rate for 1 ${currency} on the payout day.`);
  try {
    return await sql.begin(async tx => {
      const [a] = await tx`select id from affiliates where id = ${affiliateId} for update`;
      if (!a) throw notFound();
      const [same] = await tx`select id, affiliate_id, currency, amount_minor, source_currency from affiliate_payouts where utr = ${utr}`;
      if (same) {
        if (same.affiliateId === affiliateId && (same.sourceCurrency ?? same.currency) === currency) return { payoutId: same.id as string, amountMinor: Number(same.amountMinor), currency: same.currency as string, already: true };
        throw new HttpError(409, 'utr_already_used', 'That UTR is already recorded for another payout.');
      }
      const rows = await tx`select id, commission_minor from affiliate_commissions
        where affiliate_id = ${affiliateId} and currency = ${currency} and status = 'pending' for update`;
      const owed = rows.reduce((n, r) => n + Number(r.commissionMinor), 0);
      if (b.expectedMinor != null && b.expectedMinor !== owed) throw new HttpError(409, 'amount_changed', 'What is owed changed since you loaded the page. Reload and check it.', { amountMinor: owed });
      const paid = convert ? inrEquivalent(owed, Number(b.inrPerUnit))! : owed;
      const payCurrency = convert ? 'INR' : currency;
      if (paid < MIN_PAYOUT[payCurrency]) throw bad('below_minimum', `Payouts start at ${MIN_PAYOUT[payCurrency] / 100} ${payCurrency}${convert ? ` (this is ${(paid / 100).toFixed(2)} INR)` : ''}.`);
      const [p] = await tx`insert into affiliate_payouts (affiliate_id, currency, amount_minor, source_currency, source_amount_minor, fx_rate, utr, note, paid_by)
        values (${affiliateId}, ${payCurrency}, ${paid}, ${convert ? currency : null}, ${convert ? owed : null}, ${convert ? Number(b.inrPerUnit) : null}, ${utr}, ${b.note ?? null}, ${b.adminId}) returning id`;
      await tx`update affiliate_commissions set status = 'paid', payout_id = ${p.id} where id = any(${rows.map(r => r.id as string)}::uuid[])`;
      return { payoutId: p.id as string, amountMinor: paid, currency: payCurrency, ...(convert ? { sourceCurrency: currency, sourceAmountMinor: owed, inrPerUnit: Number(b.inrPerUnit) } : {}), already: false };
    });
  } catch (e: any) {
    // Two payouts with one UTR at the same moment: the unique index lets one through.
    if (e?.code === '23505') throw new HttpError(409, 'utr_already_used', 'That UTR is already recorded for another payout.');
    throw e;
  }
}

// --- monthly statement (owner, 3 Nov 2026: no partner dashboard yet; the admin emails this) ---------------------------------------
const fmt = (minor: number, cur: string) => `${(minor / 100).toFixed(2)} ${cur}`;
/** A customer as the partner sees them: never a name or an email, a short stable reference. */
const customerRef = (userId: string | null) => (userId ? 'C-' + userId.replace(/-/g, '').slice(0, 8).toUpperCase() : 'C-DELETED');
/** One CSV cell. Numbers stay numbers; text starting like a formula (=, +, -, @) is quoted and prefixed so a spreadsheet won't run it. */
const csvCell = (v: unknown) => { const t = String(v ?? ''); if (/^-?\d+(\.\d+)?$/.test(t)) return t; return /[",\n\r]/.test(t) || /^[=+\-@\t]/.test(t) ? `"${(/^[=+\-@\t]/.test(t) ? "'" : '') + t.replace(/"/g, '""')}"` : t; };

/**
 * One partner's statement for a calendar month (UTC): every commission dated in it (charges, voids, clawbacks), the payouts made in
 * it, totals per currency, and what is still owed today. CSV for a spreadsheet, text for the body of an email. Customers appear only
 * as a reference (C-1A2B3C4D), never by name or email.
 */
export async function affiliateStatement(id: string, month: string, format: 'csv' | 'text') {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('invalid_month', 'Month is YYYY-MM.');
  const from = new Date(`${month}-01T00:00:00Z`), to = new Date(from); to.setUTCMonth(to.getUTCMonth() + 1);
  const [a] = await sql`select id, code, name, commission_percent, commission_months from affiliates where id = ${id}`;
  if (!a) throw notFound();
  const [rows, payouts, owed] = await Promise.all([
    sql`select occurred_at, user_id, provider, kind, product, net_minor, currency, percent, commission_minor, status, void_reason, amount_source
      from affiliate_commissions where affiliate_id = ${id} and occurred_at >= ${from} and occurred_at < ${to} order by occurred_at, kind`,
    sql`select paid_at, currency, amount_minor, source_currency, source_amount_minor, fx_rate, utr from affiliate_payouts
      where affiliate_id = ${id} and paid_at >= ${from} and paid_at < ${to} order by paid_at`,
    sql`select currency, sum(commission_minor)::bigint as amount from affiliate_commissions where affiliate_id = ${id} and status = 'pending' group by currency order by currency`,
  ]);
  const earned = new Map<string, number>();
  for (const r of rows) if (!(r.kind === 'charge' && r.status === 'void')) earned.set(r.currency, (earned.get(r.currency) ?? 0) + Number(r.commissionMinor));
  const status = (r: any) => (r.kind === 'clawback' ? `clawback (${r.voidReason ?? 'refund'})` : r.status === 'void' ? `void (${r.voidReason ?? ''})` : r.voidReason ? `paid, then ${r.voidReason}` : r.status);
  const what = (r: any) => `${r.provider === 'google_play' ? 'Play' : 'Web'} ${String(r.product ?? '').replace(/^tablamigo_/, '')}`;
  const day = (d: any) => new Date(d).toISOString().slice(0, 10);
  const filename = `tablamigo-${a.code}-${month}.${format === 'csv' ? 'csv' : 'txt'}`;
  if (format === 'csv') {
    const lines = [['date', 'customer', 'charge', 'net', 'currency', 'percent', 'commission', 'status', 'estimate'].join(',')];
    for (const r of rows) lines.push([day(r.occurredAt), customerRef(r.userId), what(r), (Number(r.netMinor) / 100).toFixed(2), r.currency, Number(r.percent), (Number(r.commissionMinor) / 100).toFixed(2), status(r), ESTIMATED_SOURCES.includes(r.amountSource) ? 'yes' : ''].map(csvCell).join(','));
    for (const p of payouts) lines.push([day(p.paidAt), '', `Payout UTR ${p.utr}${p.sourceCurrency ? ` (${fmt(Number(p.sourceAmountMinor), p.sourceCurrency)} at ${Number(p.fxRate)} INR)` : ''}`, '', p.currency, '', (-Number(p.amountMinor) / 100).toFixed(2), 'payout', ''].map(csvCell).join(','));
    return { filename, contentType: 'text/csv; charset=utf-8', body: lines.join('\r\n') + '\r\n' };
  }
  const out = [
    `Tablamigo partner statement: ${a.name} (${a.code})`,
    `Month: ${month} (UTC). Terms: ${Number(a.commissionPercent)}% of what your customers pay us after payment-provider fees, ${a.commissionMonths ? `for ${a.commissionMonths} months from each sign-up` : 'while you are a partner'}.`,
    '',
    `Commissions this month (${rows.length}):`,
    ...(rows.length ? rows.map(r => `  ${day(r.occurredAt)}  ${customerRef(r.userId)}  ${what(r)}  net ${fmt(Number(r.netMinor), r.currency)}  →  ${fmt(Number(r.commissionMinor), r.currency)}  [${status(r)}]`) : ['  none']),
    '',
    `Earned this month: ${[...earned].map(([c, v]) => fmt(v, c)).join(', ') || 'nothing'}`,
    `Paid this month: ${payouts.map(p => `${fmt(Number(p.amountMinor), p.currency)} (UTR ${p.utr}, ${day(p.paidAt)})`).join('; ') || 'nothing'}`,
    `Owed to you now: ${owed.map(o => fmt(Number(o.amount), o.currency)).join(', ') || 'nothing'}`,
    '',
    'We pay once what is owed reaches ₹1,000 or $12; other currencies are paid in INR at the rate on the payout day. Refunded or charged-back payments earn nothing.',
  ];
  return { filename, contentType: 'text/plain; charset=utf-8', body: out.join('\n') + '\n' };
}
