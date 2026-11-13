/**
 * Tickets tab of the admin panel (apps/web/src/admin.html, "support tickets" section).
 * Every route is behind requireAdmin. Tickets are created by lib/support.ts.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireAdmin } from '../lib/admin.js';
import { notFound } from '../lib/errors.js';
import { replyToTicket } from '../lib/support.js';

export default async function support(app: FastifyInstance) {
  app.get('/admin/tickets', async req => {
    await requireAdmin(req);
    const q = z.object({
      status: z.enum(['open', 'answered', 'unanswered', 'closed', 'all']).default('open'),
      q: z.string().max(100).optional(),
    }).parse(req.query);
    const search = q.q?.trim();
    const tickets = await sql`select t.id, t.ref, t.email, t.subject, left(t.body, 200) as preview, t.status, t.source,
        t.answered_at, t.created_at, t.updated_at, t.user_id, u.name,
        (select count(*)::int from support_replies r where r.ticket_id = t.id) as replies
      from support_tickets t left join users u on u.id = t.user_id
      where ${q.status === 'all' ? sql`true`
        : q.status === 'closed' ? sql`t.status = 'closed'`
        : q.status === 'answered' ? sql`t.status = 'open' and t.answered_at is not null`
        : q.status === 'unanswered' ? sql`t.status = 'open' and t.answered_at is null`
        : sql`t.status = 'open'`}
        ${search ? sql`and (t.ref = ${search.toUpperCase()} or t.email ilike ${'%' + search + '%'} or t.subject ilike ${'%' + search + '%'} or t.body ilike ${'%' + search + '%'})` : sql``}
      order by t.created_at desc limit 200`;
    const [c] = await sql`select count(*) filter (where status = 'open')::int as open,
        count(*) filter (where status = 'open' and answered_at is null)::int as unanswered from support_tickets`;
    return { tickets, counts: c };
  });

  app.get('/admin/tickets/:id', async req => {
    await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [ticket] = await sql`select t.*, u.name, r.target_type as report_target_type, r.target_id as report_target_id, r.status as report_status
      from support_tickets t left join users u on u.id = t.user_id left join reports r on r.id = t.report_id where t.id = ${id}`;
    if (!ticket) throw notFound();
    const replies = await sql`select r.id, r.body, r.email_status, r.created_at, a.email as admin_email
      from support_replies r left join users a on a.id = r.admin_id where r.ticket_id = ${id} order by r.created_at`;
    return { ticket, replies };
  });

  app.post('/admin/tickets/:id/reply', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
    const adminId = await requireAdmin(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(2).max(10_000) }).parse(req.body);
    const r = await replyToTicket(id, adminId, body);
    if (!r) throw notFound();
    return { ok: r.emailStatus === 'sent', ...r };
  });

  for (const [action, status] of [['close', 'closed'], ['reopen', 'open']] as const) {
    app.post(`/admin/tickets/:id/${action}`, async req => {
      await requireAdmin(req);
      const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
      const [t] = await sql`update support_tickets set status = ${status}, updated_at = now() where id = ${id} returning id, status`;
      if (!t) throw notFound();
      return t;
    });
  }
}
