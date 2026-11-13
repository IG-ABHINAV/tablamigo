/**
 * Support tickets. A ticket is created for every in-app report; the reporter gets a confirmation with
 * a TM- reference, support@ gets an internal copy, and admins answer from the Tickets tab
 * (routes/support.ts), which emails the reply in the product layout. Emails never throw: the ticket
 * row is the record.
 */
import crypto from 'node:crypto';
import { config } from './config.js';
import { sql } from './db.js';
import { sendMail } from './mail.js';
import { render } from './emails/layout.js';
import { deliver, type Outcome } from './emails/send.js';
import { reportReceived, ticketInternal, ticketReply, REPORT_REASONS } from './emails/support-templates.js';

// Crockford base32 without I, L, O, U.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 'TM-7K2Q' from the ticket id; `salt` picks another on the rare collision (ref is unique). */
export function ticketRef(id: string, salt = 0) {
  const b = crypto.createHash('sha256').update(`${id}:${salt}`).digest();
  let s = ''; for (let i = 0; i < 4; i++) s += ALPHABET[b[i] % 32];
  return `TM-${s}`;
}

export const adminTicketUrl = (id: string) => `${config.siteUrl}/admin#tickets?id=${id}`;

type NewTicket = { userId: string | null; email: string; name?: string | null; subject: string; body: string; source: 'report' | 'contact'; reportId?: string | null };

export async function createTicket(t: NewTicket) {
  const id = crypto.randomUUID();
  for (let salt = 0; ; salt++) {
    try {
      const [row] = await sql`insert into support_tickets (id, ref, user_id, email, subject, body, source, report_id)
        values (${id}, ${ticketRef(id, salt)}, ${t.userId}, ${t.email}, ${t.subject}, ${t.body}, ${t.source}, ${t.reportId ?? null})
        returning id, ref`;
      return row as { id: string; ref: string };
    } catch (e: any) {
      if (e?.code !== '23505' || salt >= 8) throw e;   // unique violation on ref: re-salt
    }
  }
}

/**
 * POST /reports: store the report, open a ticket, confirm to the reporter and copy support.
 * The same reporter sending the same report (target and reason) again within 60 seconds is a double
 * submit: it returns the first ticket and sends nothing.
 */
export async function reportWithTicket(uid: string, b: { targetType: string; targetId: string; reason: string; details?: string }) {
  const [dup] = await sql`select t.ref from reports r join support_tickets t on t.report_id = r.id
    where r.reporter_id = ${uid} and r.target_type = ${b.targetType} and r.target_id = ${b.targetId} and r.reason = ${b.reason}
      and r.created_at > now() - interval '60 seconds'
    order by r.created_at desc limit 1`;
  if (dup) return { ref: dup.ref as string, duplicate: true };

  const [report] = await sql`insert into reports (reporter_id, target_type, target_id, reason, details)
    values (${uid}, ${b.targetType}, ${b.targetId}, ${b.reason}, ${b.details ?? null}) returning id`;
  const [u] = await sql`select email, name from users where id = ${uid}`;
  const subject = `Report: ${REPORT_REASONS[b.reason] ?? b.reason} (${b.targetType})`;
  const body = b.details?.trim() || '(no details)';
  const ticket = await createTicket({ userId: uid, email: u.email, name: u.name, subject, body, source: 'report', reportId: report.id });

  await deliver({
    kind: 'support_ack', userId: uid, periodKey: ticket.id, ref: ticket.ref,
    build: x => reportReceived({ name: x.name, ref: ticket.ref, reason: b.reason, targetType: b.targetType }),
  });
  await notifySupport({ ...ticket, subject, body, email: u.email, name: u.name, about: `${b.targetType} ${b.targetId}` });
  return { ref: ticket.ref, duplicate: false };
}

async function notifySupport(t: { id: string; ref: string; subject: string; body: string; email: string; name?: string | null; about?: string }) {
  try {
    const e = render(ticketInternal({ ref: t.ref, subject: t.subject, body: t.body, email: t.email, name: t.name, about: t.about, adminUrl: adminTicketUrl(t.id) }), { unsubscribeUrl: null, footer: ['Internal copy of a support ticket, sent to SUPPORT_EMAIL. Reply to answer the customer.'] });
    await sendMail({ to: config.supportEmail, subject: e.subject, html: e.html, text: e.text, replyTo: t.email });
  } catch (e) {
    console.error('support copy failed', t.ref, (e as Error).message);
  }
}

/** Email an admin's reply to the customer, record it, and mark the ticket answered. */
export async function replyToTicket(ticketId: string, adminId: string, reply: string) {
  const [t] = await sql`select id, ref, user_id, email, body from support_tickets where id = ${ticketId}`;
  if (!t) return null;
  const [r] = await sql`insert into support_replies (ticket_id, admin_id, body, email_status) values (${t.id}, ${adminId}, ${reply}, 'pending') returning id`;
  const outcome: Outcome = await deliver({
    kind: 'support_reply', userId: t.userId as any, periodKey: `reply:${r.id}`, ref: t.ref, to: t.email,
    build: x => ticketReply({ name: x.name, ref: t.ref, reply, original: t.body }),
  });
  await sql`update support_replies set email_status = ${outcome} where id = ${r.id}`;
  if (outcome === 'sent') await sql`update support_tickets set answered_at = now(), updated_at = now() where id = ${t.id}`;
  return { replyId: Number(r.id), emailStatus: outcome };
}
