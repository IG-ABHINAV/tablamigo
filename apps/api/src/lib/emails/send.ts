/**
 * Sending customer emails: opt-out checks, signed unsubscribe links and the email_log claim that
 * makes every send at-most-once per (kind, user, period).
 */
import crypto from 'node:crypto';
import { config } from '../config.js';
import { sql } from '../db.js';
import { sendMail } from '../mail.js';
import { render, type Email } from './layout.js';

/** Opt-out keys in users.email_prefs. 'all' covers every optional email. */
export const PREF_KEYS = ['reminders', 'activity', 'digest', 'all'] as const;
export type PrefKey = typeof PREF_KEYS[number];
export type Prefs = Partial<Record<PrefKey, boolean>>;

// --- unsubscribe tokens ------------------------------------------------------------------------
// "<user id>.<key>.<hmac>": no expiry, because an unsubscribe link must keep working in old emails.
const unsubKey = () => crypto.createHash('sha256').update('tablamigo-unsubscribe:' + config.jwtSecret).digest();
const mac = (payload: string) => crypto.createHmac('sha256', unsubKey()).update(payload).digest('base64url').slice(0, 32);

export function unsubscribeToken(userId: string, key: PrefKey) { return `${userId}.${key}.${mac(`${userId}.${key}`)}`; }
export function readUnsubscribeToken(token: string): { userId: string; key: PrefKey } | null {
  const [userId, key, sig] = String(token).split('.');
  if (!userId || !key || !sig || !(PREF_KEYS as readonly string[]).includes(key)) return null;
  if (!/^[0-9a-f-]{36}$/.test(userId)) return null;
  const want = Buffer.from(mac(`${userId}.${key}`)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? { userId, key: key as PrefKey } : null;
}
export const unsubscribeUrl = (userId: string, key: PrefKey) => `${config.publicUrl}/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(userId, key))}`;

export const allows = (prefs: Prefs | null | undefined, key: PrefKey) => prefs?.all !== false && prefs?.[key] !== false;

// --- delivery ----------------------------------------------------------------------------------
export type Delivery = {
  kind: string;
  userId: string;
  /** With kind and user, the idempotency key: 'once', a purchase token, a date, an ISO week... */
  periodKey: string;
  ref?: string;
  meta?: Record<string, unknown>;
  /** Send here instead of the user's current address (account deletion rewrites it first). */
  to?: string;
  build: (u: { name: string | null; email: string }) => Email | null;
};
export type Outcome = 'sent' | 'duplicate' | 'opted_out' | 'no_recipient' | 'nothing' | 'failed';

/**
 * Domains that exist only inside Tablamigo: the seeded demo accounts (@demo.tablamigo), deleted accounts
 * (deleted-<id>@deleted.tablamigo) and the Tablamigo Host (@team.tablamigo). None has DNS, so every email to one hard-bounces
 * on the sender that also carries sign-in codes: 36 of 145 logged emails went to @demo.tablamigo (26 weekly digests, 10
 * plan_joined) before this check. One rule for every email kind.
 */
const UNSENDABLE_DOMAINS = new Set(['demo.tablamigo', 'deleted.tablamigo', 'team.tablamigo']);
export function isSendable(email: string | null | undefined): email is string {
  const domain = email?.trim().toLowerCase().split('@')[1];
  return !!domain && !UNSENDABLE_DOMAINS.has(domain);
}

/**
 * Claims (kind, user, period) in email_log, then sends. A second call with the same key returns
 * 'duplicate' without sending. Failed sends can be retried twice more by a later run; a claim whose
 * process died mid-send stays 'pending' and is never re-sent (at most once beats twice).
 * Never throws: emails run after the thing they describe has committed.
 */
export async function deliver(d: Delivery): Promise<Outcome> {
  try {
    const [u] = await sql`select email, name, email_prefs, deleted_at, banned_at, account_kind from users where id = ${d.userId}`;
    // The team account (the Tablamigo Host) has an unreachable address and gets no email of any kind.
    if (u?.accountKind === 'team') return 'no_recipient';
    const to = d.to ?? (u && !u.deletedAt && !u.bannedAt ? u.email as string : null);
    if (!isSendable(to)) return 'no_recipient';
    const email = d.build({ name: u?.name ?? null, email: to });
    if (!email) return 'nothing';
    const optKey = email.category === 'transactional' ? null : email.category;
    if (optKey && !allows(u?.emailPrefs, optKey)) return 'opted_out';

    const [claim] = await sql`insert into email_log (kind, user_id, period_key, ref, to_email, subject, meta)
      values (${d.kind}, ${d.userId}, ${d.periodKey}, ${d.ref ?? null}, ${to}, ${email.subject}, ${d.meta ? sql.json(d.meta as any) : null})
      on conflict (kind, user_id, period_key) do update set status = 'pending', attempts = email_log.attempts + 1, error = null
        where email_log.status = 'failed' and email_log.attempts < 3
      returning id`;
    if (!claim) return 'duplicate';

    const r = render(email, { unsubscribeUrl: optKey ? unsubscribeUrl(d.userId, optKey) : null });
    const headers = optKey ? {
      'List-Unsubscribe': `<${unsubscribeUrl(d.userId, optKey)}>, <mailto:${config.supportEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    } : undefined;
    try {
      const res = await sendMail({ to, subject: r.subject, html: r.html, text: r.text, headers });
      if (res?.logged) await sql`update email_log set status = 'skipped', error = 'no RESEND_API_KEY: logged, not sent' where id = ${claim.id}`;
      else await sql`update email_log set status = 'sent', sent_at = now(), provider_id = ${res?.id ?? null} where id = ${claim.id}`;
      return 'sent';
    } catch (e) {
      await sql`update email_log set status = 'failed', error = ${String((e as Error).message).slice(0, 500)} where id = ${claim.id}`;
      console.error('email failed', d.kind, (e as Error).message);
      return 'failed';
    }
  } catch (e) {
    console.error('email error', d.kind, (e as Error).message);
    return 'failed';
  }
}
