/**
 * Self-serve partner sign-up (owner, 4 Nov 2026): a signed-in member accepts the partner terms in the app or web app
 * (apps/mobile/src/app/partner.tsx; the public page is apps/web/src/partners.html) and becomes a creator partner at once, with a
 * code the server makes. Self sign-ups are always at DEFAULT_PERCENT (30), while they are a partner, with no coupon offer: the 40%
 * tier, durations and coupons stay admin-only (routes/admin-affiliates.ts). The money side is the existing ledger
 * (lib/affiliate-ledger.ts): user_id is always set, so a partner never earns on their own purchases.
 *
 * Payout details (a UPI ID or an Indian bank account) are AES-256-GCM encrypted at rest. The key is AFFILIATE_PAYOUT_KEY (32 bytes,
 * base64) when set, else derived from JWT_SECRET with HKDF; if that secret is ever rotated, details sealed under the old one no
 * longer open, the admin sees "unreadable" and the partner enters them again. The partner and the admin list only see `masked`.
 */
import crypto from 'node:crypto';
import { sql } from './db.js';
import { config } from './config.js';
import { HttpError, bad, notFound } from './errors.js';
import { affiliateLinks, cleanAffiliateCode, DEFAULT_PERCENT } from './affiliate-ledger.js';

/** The terms the member accepts. The version is the date on the website's terms (partners.html) and the app's (partner-terms.ts). */
export const PARTNER_TERMS = { version: '2026-11-04', percent: DEFAULT_PERCENT } as const;

/** Upper-case letters and digits without look-alikes (0/O, 1/I/L): 31 symbols, 8 of them make about 40 bits. */
export const PARTNER_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

/** A fresh partner code. Bytes at or above 248 (8 x 31) are skipped, so every symbol is equally likely. */
export function newPartnerCode(rand: (n: number) => Buffer = crypto.randomBytes): string {
  const limit = Math.floor(256 / PARTNER_CODE_ALPHABET.length) * PARTNER_CODE_ALPHABET.length;
  let out = '';
  while (out.length < CODE_LENGTH) {
    for (const b of rand(16)) {
      if (b >= limit) continue;
      out += PARTNER_CODE_ALPHABET[b % PARTNER_CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

// --- payout details ------------------------------------------------------------------------------------------------------------
export type Payout = { method: 'upi'; upiId: string } | { method: 'bank'; accountName: string; accountNumber: string; ifsc: string };

const UPI_RE = /^[a-z0-9][a-z0-9._-]{1,63}@[a-z][a-z0-9]{1,63}$/;
const NAME_RE = /^[A-Za-z][A-Za-z .'-]{1,79}$/;
const ACCOUNT_RE = /^\d{9,18}$/;
const IFSC_RE = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Payout details in a canonical form, or null when they aren't a valid UPI ID or Indian bank account. */
export function parsePayout(raw: unknown): Payout | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.method === 'upi') {
    if (typeof r.upiId !== 'string' || r.upiId.length > 200) return null;
    const upiId = r.upiId.trim().toLowerCase();
    return UPI_RE.test(upiId) ? { method: 'upi', upiId } : null;
  }
  if (r.method === 'bank') {
    if (typeof r.accountName !== 'string' || typeof r.accountNumber !== 'string' || typeof r.ifsc !== 'string') return null;
    if (r.accountName.length > 200 || r.accountNumber.length > 40 || r.ifsc.length > 20) return null;
    const accountName = r.accountName.trim().replace(/\s+/g, ' ');
    const accountNumber = r.accountNumber.replace(/[\s-]+/g, '');
    const ifsc = r.ifsc.trim().toUpperCase();
    return NAME_RE.test(accountName) && ACCOUNT_RE.test(accountNumber) && IFSC_RE.test(ifsc) ? { method: 'bank', accountName, accountNumber, ifsc } : null;
  }
  return null;
}

/** What the partner and the admin list see: enough to recognise the details, not enough to use them. */
export function maskPayout(p: Payout): string {
  if (p.method === 'upi') {
    const [name, handle] = p.upiId.split('@');
    const shown = name.length <= 3 ? name[0] + '•'.repeat(name.length - 1) : name.slice(0, 2) + '•'.repeat(name.length - 3) + name.slice(-1);
    return `${shown}@${handle}`;
  }
  return `Bank ••••${p.accountNumber.slice(-4)} (${p.ifsc})`;
}

let key: Buffer | null = null;
function payoutKey() {
  if (key) return key;
  const env = process.env.AFFILIATE_PAYOUT_KEY;
  const fromEnv = env ? Buffer.from(env, 'base64') : null;
  key = fromEnv && fromEnv.length === 32 ? fromEnv
    : Buffer.from(crypto.hkdfSync('sha256', config.jwtSecret, 'tablamigo', 'affiliate-payout-details-v1', 32));
  return key;
}

/** `v1:<iv>:<tag>:<ciphertext>`, base64url, AES-256-GCM with a fresh IV. */
export function sealPayout(p: Payout): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', payoutKey(), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(p), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

/** The details sealed by sealPayout, or null when they were tampered with, sealed under another key, or aren't sealed at all. */
export function openPayout(sealed: string): Payout | null {
  try {
    const [v, iv, tag, ct] = String(sealed).split(':');
    if (v !== 'v1' || !iv || !tag || !ct) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', payoutKey(), Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return parsePayout(JSON.parse(Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8')));
  } catch {
    return null;
  }
}

// --- the member's side -----------------------------------------------------------------------------------------------------------
type Money = { currency: string; amountMinor: number };
const money = (rows: any): Money[] => (Array.isArray(rows) ? rows : []).map((r: any) => ({ currency: r.currency, amountMinor: Number(r.amount_minor ?? r.amountMinor) }));

/** The member's partner: their own self sign-up first, else one the admin linked to their account. */
const mine = (userId: string) => sql`select * from affiliates where user_id = ${userId}
  order by source = 'self' desc, status = 'active' desc, created_at limit 1`;

/** What the partner sees: their code, link, terms, stats and masked payout details. Never a customer's name, email or id. */
export async function partnerView(userId: string) {
  const [a] = await mine(userId);
  if (!a) return null;
  const [s] = await sql`select
      (select count(*)::int from affiliate_referrals where affiliate_id = ${a.id}) as signups,
      (select count(distinct user_id)::int from affiliate_commissions where affiliate_id = ${a.id} and kind = 'charge' and status <> 'void') as paying,
      (select json_agg(x) from (select currency, sum(commission_minor)::bigint as amount_minor from affiliate_commissions
        where affiliate_id = ${a.id} and not (kind = 'charge' and status = 'void') group by currency order by currency) x) as earned,
      (select json_agg(x) from (select currency, sum(commission_minor)::bigint as amount_minor from affiliate_commissions
        where affiliate_id = ${a.id} and status = 'pending' group by currency order by currency) x) as owed,
      (select json_agg(x) from (select currency, sum(amount_minor)::bigint as amount_minor from affiliate_payouts
        where affiliate_id = ${a.id} group by currency order by currency) x) as paid,
      (select json_build_object('method', method, 'masked', masked, 'updatedAt', updated_at) from affiliate_payout_details where affiliate_id = ${a.id}) as payout`;
  return {
    code: a.code as string, link: affiliateLinks(a.code).web, status: a.status as string,
    percent: Number(a.commissionPercent), months: a.commissionMonths == null ? null : Number(a.commissionMonths),
    joinedAt: a.createdAt, termsVersion: a.termsVersion ?? null,
    stats: { signups: s.signups, paying: s.paying, earned: money(s.earned), owed: money(s.owed).filter(m => m.amountMinor !== 0), paid: money(s.paid) },
    payout: s.payout ?? null,
  };
}

/**
 * Make the member a partner: one step, after they accept the terms. Joining again (a double tap, a second device, or a partner the
 * admin already made for them) returns the partner they have, at its own terms and status: a paused or ended partner is never
 * reactivated here. Concurrent calls for one member are serialised, and a unique index backs that up.
 */
export async function createSelfPartner(userId: string, termsVersion: string, gen: () => string = newPartnerCode) {
  if (termsVersion !== PARTNER_TERMS.version) throw new HttpError(409, 'terms_changed', 'The partner terms changed. Read them again and accept.');
  let created = false;
  try {
    created = await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'partner-signup:' + userId}, 0))`;
      if ((await tx`select 1 from affiliates where user_id = ${userId}`)[0]) return false;
      const [u] = await tx`select name, email, banned_at, deleted_at, account_kind from users where id = ${userId}`;
      if (!u || u.deletedAt) throw new HttpError(401, 'unauthorized');
      if (u.bannedAt) throw new HttpError(403, 'banned');
      if (u.accountKind !== 'person') throw new HttpError(403, 'team_account');
      for (let i = 0; i < 8; i++) {
        const code = cleanAffiliateCode(gen());
        if (!code) continue;
        // Never someone's friend-invite code: ?ref= and the install referrer carry both kinds (as createAffiliate checks).
        if ((await tx`select 1 from users where referral_code = ${code}`)[0]) continue;
        const name = (typeof u.name === 'string' ? u.name.trim().slice(0, 80) : '') || code;
        const rows = await tx`insert into affiliates (code, name, email, user_id, commission_percent, source, terms_version, terms_accepted_at)
          values (${code}, ${name}, ${u.email ?? null}, ${userId}, ${PARTNER_TERMS.percent}, 'self', ${termsVersion}, now())
          on conflict (code) do nothing returning id`;
        if (rows.length) return true;
      }
      throw new HttpError(503, 'code_unavailable', 'Could not make a partner code. Try again.');
    });
  } catch (e: any) {
    if (e?.code !== '23505') throw e;   // the unique self-per-user index: another request made it first
  }
  return { partner: (await partnerView(userId))!, created };
}

/** Save the partner's payout details (replacing any before). Returns the masked form. */
export async function setPayoutDetails(userId: string, raw: unknown) {
  const [a] = await mine(userId);
  if (!a) throw notFound('not_partner');
  const p = parsePayout(raw);
  if (!p) throw bad('invalid_payout', 'Enter a valid UPI ID, or an account holder name, account number (9 to 18 digits) and IFSC code.');
  const masked = maskPayout(p);
  const [row] = await sql`insert into affiliate_payout_details (affiliate_id, method, sealed, masked) values (${a.id}, ${p.method}, ${sealPayout(p)}, ${masked})
    on conflict (affiliate_id) do update set method = excluded.method, sealed = excluded.sealed, masked = excluded.masked, updated_at = now()
    returning updated_at`;
  return { method: p.method, masked, updatedAt: row.updatedAt };
}

/** The admin's partner detail: the details in full (to send the money), or `unreadable` when they no longer open. */
export async function payoutForAdmin(affiliateId: string) {
  const [d] = await sql`select method, sealed, masked, updated_at from affiliate_payout_details where affiliate_id = ${affiliateId}`;
  if (!d) return null;
  const details = openPayout(d.sealed);
  return { method: d.method, masked: d.masked, updatedAt: d.updatedAt, details, unreadable: !details };
}
