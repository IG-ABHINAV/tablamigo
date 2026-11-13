import crypto from 'node:crypto';
import { config } from './config.js';
import { sql } from './db.js';
import { loginCode } from './emails/templates.js';
import { render } from './emails/layout.js';

/** `idempotencyKey`: Resend drops a second send with the same key within 24 hours (owner alerts re-sent after a crash). */
export type OutMail = { to: string; subject: string; html: string; text: string; headers?: Record<string, string>; replyTo?: string; idempotencyKey?: string };
/** `logged`: nothing left the machine (no provider key), so email_log records it as skipped, not sent. */
export type Transport = (m: OutMail) => Promise<{ id?: string; logged?: boolean }>;

/** Resend over HTTPS. Without a key (local dev, tests) the email is logged instead of sent. */
const resend: Transport = async m => {
  if (!config.resendKey) { console.log(`[dev] email to ${m.to}: ${m.subject}`); return { logged: true }; }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.resendKey}`, 'Content-Type': 'application/json', ...(m.idempotencyKey ? { 'Idempotency-Key': m.idempotencyKey } : {}) },
    body: JSON.stringify({ from: config.mailFrom, reply_to: m.replyTo ?? config.supportEmail, to: m.to, subject: m.subject, html: m.html, text: m.text, headers: m.headers }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new Error(`resend ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j: any = await r.json().catch(() => ({}));
  return { id: j?.id };
};

let transport: Transport = resend;
/** Tests swap the transport for a recorder; `null` restores Resend. */
export function setMailTransport(t: Transport | null) { transport = t ?? resend; }
export const sendMail = (m: OutMail) => transport(m);

/**
 * Sends a sign-in code and records the send in email_log (kind 'login_code': status and Resend's id, never the code; the
 * subject carries the code, so a fixed one is logged). Sign-in codes weren't logged, so nobody could tell whether a person
 * who never signed in had been sent anything. Throws when the send fails, after logging it.
 */
export async function sendLoginCode(email: string, code: string) {
  const log = (status: 'sent' | 'skipped' | 'failed', providerId: string | null, error: string | null) =>
    sql`insert into email_log (kind, user_id, period_key, to_email, subject, status, provider_id, error, sent_at)
      values ('login_code', (select id from users where email = ${email} and deleted_at is null limit 1), ${crypto.randomUUID()}, ${email},
        'Sign-in code', ${status}, ${providerId}, ${error}, ${status === 'sent' ? sql`now()` : null})`.catch(() => {});
  if (!config.resendKey && transport === resend) { console.log(`[dev] login code for ${email}: ${code}`); await log('skipped', null, 'no RESEND_API_KEY: logged, not sent'); return; }
  const e = render(loginCode({ code }), { unsubscribeUrl: null });
  try {
    const r = await sendMail({ to: email, subject: e.subject, html: e.html, text: e.text });
    await log(r?.logged ? 'skipped' : 'sent', r?.id ?? null, null);
  } catch (err) {
    await log('failed', null, String((err as Error).message).slice(0, 500));
    throw err;
  }
}
