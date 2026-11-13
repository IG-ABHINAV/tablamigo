/**
 * One-time "sign-in on Android is fixed" email (12 Nov 2026). From 4 to 11 Nov the Android app's 1.4.2 code screen could stay
 * stuck, and about 13 people (15 addresses) asked for a code in the app and never got in (user-journey audit, 12 Nov). 1.4.3
 * (versionCode 18) fixed it and reached production on 11 Nov.
 *
 * Who: addresses with a login_code in email_log inside the window, limited to `only` (the Android app sessions, found by
 * matching the code requests to okhttp lines in nginx; the database alone can't tell the app from the web app), and never:
 * an address that has an account now (they got in since), one linked to a deleted account, one already on the sent-list
 * (email_log kind 'signin_fixed'), or one that can't receive email.
 *
 * At most once per address: the email_log row is claimed (status 'pending') under an advisory lock before the send, and a
 * pending or sent row keeps the address out of every later run. Sent through the API's normal transport (Resend, lib/mail.ts).
 */
import crypto from 'node:crypto';
import { sql } from '../db.js';
import { sendMail } from '../mail.js';
import { render, type Email } from './layout.js';
import { isSendable } from './send.js';

export const KIND = 'signin_fixed';
export const PLAY_URL = 'https://play.google.com/store/apps/details?id=com.tablamigo.app';
export const OPEN_URL = 'https://tablamigo.hookstep.in/app';
/** 4 Nov 00:00 IST to 1.4.3's production rollout (11 Nov, about 15:58 IST). */
export const DEFAULT_WINDOW = { from: new Date('2026-11-03T18:30:00Z'), until: new Date('2026-11-11T10:28:00Z') };

export function signinFixedEmail(): Email {
  return {
    subject: 'Sign-in on Android is fixed', category: 'transactional',
    preheader: 'Sorry about the stuck code screen. Update Tablamigo and sign in again.',
    blocks: [
      { t: 'h1', text: 'Sorry, sign-in works again' },
      { t: 'p', text: 'Hi, you asked for a Tablamigo sign-in code in our Android app last week. A bug in that version could leave the code screen stuck, so you may not have been able to get in. Sorry about that.' },
      { t: 'p', text: "It's fixed. Update the app from Google Play, then sign in again. Continue with Google skips the code altogether." },
      { t: 'button', label: 'Update Tablamigo', url: PLAY_URL },
      { t: 'small', text: `Already updated? [Open Tablamigo](${OPEN_URL}). This is a one-time email: we won't write again unless you sign in.` },
    ],
  };
}

const norm = (e: string) => e.trim().toLowerCase();
export const keyOf = (email: string) => crypto.createHash('sha256').update(norm(email)).digest('hex').slice(0, 32);
/** "ab…@gmail.com", for logs. */
export const mask = (email: string) => { const [u, d] = norm(email).split('@'); return `${u.slice(0, 2)}…@${d ?? ''}`; };

export type Candidate = { email: string; firstAt: Date; codes: number };

/** The addresses that get the email (read-only). `only` limits it to these addresses (case-insensitive). */
export async function candidates(o: { from: Date; until: Date; only?: string[] | null }): Promise<Candidate[]> {
  const only = o.only ? [...new Set(o.only.map(norm).filter(Boolean))] : null;
  const rows = await sql`
    with c as (
      select lower(l.to_email) as email, min(l.created_at) as first_at, count(*)::int as codes
      from email_log l
      where l.kind = 'login_code' and l.created_at >= ${o.from} and l.created_at < ${o.until} and l.to_email is not null
        and (${only}::text[] is null or lower(l.to_email) = any(${only}::text[]))
      group by lower(l.to_email))
    select c.* from c
    where not exists (select 1 from users u where lower(u.email) = c.email and u.deleted_at is null)
      and not exists (select 1 from email_log x join users u on u.id = x.user_id where lower(x.to_email) = c.email and u.deleted_at is not null)
      and not exists (select 1 from email_log s where s.kind = ${KIND} and lower(s.to_email) = c.email and s.status in ('pending', 'sent'))
    order by c.first_at`;
  return rows.filter(r => isSendable(r.email)).map(r => ({ email: r.email, firstAt: new Date(r.firstAt), codes: r.codes }));
}

export type SendResult = { email: string; status: 'sent' | 'failed' | 'duplicate'; providerId?: string | null; error?: string };

/** Sends to one address at most once. Never throws. */
export async function sendOne(email: string): Promise<SendResult> {
  const e = norm(email), r = render(signinFixedEmail(), { unsubscribeUrl: null });
  const claimed = await sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${'signin-fixed:' + e}, 0))`;
    const [dup] = await tx`select 1 from email_log where kind = ${KIND} and lower(to_email) = ${e} and status in ('pending', 'sent')`;
    if (dup) return null;
    const [row] = await tx`insert into email_log (kind, user_id, period_key, to_email, subject, status)
      values (${KIND}, null, ${keyOf(e)}, ${e}, ${r.subject}, 'pending') returning id`;
    return row.id as string;
  });
  if (!claimed) return { email: e, status: 'duplicate' };
  try {
    const out = await sendMail({ to: e, subject: r.subject, html: r.html, text: r.text, idempotencyKey: `${KIND}-${keyOf(e)}` });
    await sql`update email_log set status = ${out?.logged ? 'skipped' : 'sent'}, provider_id = ${out?.id ?? null}, sent_at = now() where id = ${claimed}`;
    return { email: e, status: 'sent', providerId: out?.id ?? null };
  } catch (err) {
    const msg = String((err as Error)?.message ?? err).slice(0, 500);
    await sql`update email_log set status = 'failed', error = ${msg} where id = ${claimed}`;
    return { email: e, status: 'failed', error: msg };
  }
}
