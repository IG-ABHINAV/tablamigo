import { sql } from './db.js';
import { config } from './config.js';
import { REFERRAL } from './plus.js';
import { recomputePlus } from './play.js';
import { addNotice } from './inbox.js';
import { bad, notFound } from './errors.js';

/** Invite codes are what GET /me/referral makes (8 upper-case letters/digits); older ones may be shorter. */
export const REF_CODE_RE = /^[A-Z0-9]{4,16}$/;

/** A clean invite code, or null. Lower case is accepted (people type it), anything else is not a code. */
export function cleanRefCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const c = raw.trim().toUpperCase();
  return REF_CODE_RE.test(c) ? c : null;
}

/**
 * The public invite link for a code. It is a page on the website (apps/web/src/invite.html) that works in any browser, including
 * Instagram's and WhatsApp's in-app ones: it sends Android to Google Play with the code in the install referrer, and everyone else to
 * the web app with `?ref=`. Until 1 Nov 2026 the link was /r/<code>, which the website never served (every invite was a 404).
 */
/**
 * The member's friend-invite code, made on first look. Never one that is already a creator partner's code: ?ref= and the Play
 * install referrer carry both kinds, and /me/referral/redeem tries the partner code first. Of two first looks at once, whichever
 * wrote first wins. Null only if every try collided (the caller shows no code and the next look tries again).
 */
export async function ensureInviteCode(uid: string, gen: () => string = () => Math.random().toString(36).substring(2, 10).toUpperCase()) {
  for (let i = 0; i < 5; i++) {
    const code = gen();
    await sql`update users set referral_code = ${code} where id = ${uid} and referral_code is null
      and not exists (select 1 from affiliates where code = ${code})`;
    const [u] = await sql`select referral_code from users where id = ${uid}`;
    if (u?.referralCode) return u.referralCode as string;
  }
  return null;
}

export const inviteLink = (code: string) => `${config.siteUrl}/invite?code=${encodeURIComponent(code)}`;

/**
 * The invite code a sign-up arrived with, if any:
 * - `ref_code` in the sign-in body (the web app sends what `/app/?ref=` carried, lib/install-referrer.web.ts);
 * - `ref` in the Play install referrer ("utm_source=invite&utm_medium=referral&ref=CODE", set by the invite page).
 */
export function refCodeFrom(extra: Record<string, unknown> | undefined): string | null {
  const direct = cleanRefCode(extra?.ref_code);
  if (direct) return direct;
  const ir = extra?.install_referrer;
  if (typeof ir !== 'string' || !ir) return null;
  try { return cleanRefCode(new URLSearchParams(ir.slice(0, 500)).get('ref')); } catch { return null; }
}

export type RedeemResult = { ok: true; rewardDays: number; plusUntil: Date | null; referrerRewarded: boolean };

/**
 * Redeem an invite code for `uid`: REFERRAL.rewardDays of Plus each. The days go into comp_until and plus_until is recomputed from it,
 * so a later subscription or pass event can't wipe them (plus_until is derived, never written by hand: lib/play.ts).
 * Throws the same errors POST /me/referral/redeem always answered with. Used by that route and by sign-up (auto-redeem).
 */
export async function redeemReferral(uid: string, code: string): Promise<RedeemResult> {
  const [referrer] = await sql`select id, name from users where referral_code = ${code} and deleted_at is null and banned_at is null`;
  if (!referrer) throw notFound('invalid_code');
  if (referrer.id === uid) throw bad('cannot_refer_self', 'You cannot redeem your own referral code');
  const days = `${REFERRAL.rewardDays} days`;

  const referrerRewarded = await sql.begin(async tx => {
    // Stacked after whatever access the person already has.
    const comp = (id: string) => tx`update users set comp_until = greatest(now(), coalesce(comp_until, now()), coalesce(plus_until, now())) + ${days}::interval where id = ${id}`;
    // Claimed atomically: a second (or simultaneous) redeem finds referred_by already set.
    const [me] = await tx`update users set referred_by = ${referrer.id}
      where id = ${uid} and referred_by is null and created_at > now() - ${REFERRAL.redeemWithinDays + ' days'}::interval returning id`;
    if (!me) {
      const [cur] = await tx`select referred_by from users where id = ${uid}`;
      if (cur?.referredBy) throw bad('already_referred', 'You have already redeemed a referral code');
      throw bad('referral_new_accounts_only', `Invite codes work in your first ${REFERRAL.redeemWithinDays} days on Tablamigo.`);
    }
    await comp(uid);
    // The referrer's row is locked so two sign-ups at once can't both take the last reward.
    await tx`select 1 from users where id = ${referrer.id} for update`;
    const [{ n }] = await tx`select count(*)::int as n from users where referred_by = ${referrer.id} and id <> ${uid}`;
    if (n >= REFERRAL.maxRewards) return false;
    await comp(referrer.id);
    return true;
  });
  await recomputePlus(uid);
  if (referrerRewarded) await recomputePlus(referrer.id);

  const [updated] = await sql`select plus_until from users where id = ${uid}`;
  await addNotice([uid], {
    kind: 'plus',
    body: () => `Welcome gift! You received ${REFERRAL.rewardDays} days of Tablamigo Plus from ${referrer.name || 'a friend'}.`
  });
  if (referrerRewarded) await addNotice([referrer.id], {
    kind: 'plus',
    actorId: uid,
    body: n => `${n} joined using your invite link! You received ${REFERRAL.rewardDays} days of Tablamigo Plus.`
  });

  return { ok: true, rewardDays: REFERRAL.rewardDays, plusUntil: updated.plusUntil, referrerRewarded };
}

/**
 * Sign-up with an invite code: redeem it for the new account. Never stops a sign-up: a bad, own or used-up code is logged and
 * ignored (the person can still type a code in Profile > Invite friends within REFERRAL.redeemWithinDays).
 */
export async function autoRedeemAtSignup(uid: string, code: string | null): Promise<boolean> {
  if (!code) return false;
  try {
    await redeemReferral(uid, code);
    await sql`insert into analytics_events (user_id, event_name, properties) values (${uid}, 'referral_auto_redeemed', ${sql.json({ code })})`.catch(() => {});
    return true;
  } catch (e) {
    console.warn('invite code at sign-up not redeemed:', (e as any)?.code ?? (e as Error).message);
    return false;
  }
}
