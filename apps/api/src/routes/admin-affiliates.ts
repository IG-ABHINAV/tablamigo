/**
 * Admin: creator partners (lib/affiliates.ts), the Affiliates tab of apps/web/src/admin.html. What each partner is owed per
 * currency, their referrals and commissions, their percent and duration, and recording a payout with its UTR.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from '../lib/admin.js';
import { affiliatesOverview, affiliateDetail, createAffiliate, updateAffiliate, recordPayout, affiliateStatement } from '../lib/affiliates.js';
import { MAX_PERCENT } from '../lib/affiliate-ledger.js';

const id = z.object({ id: z.string().uuid() });
const nullable = (s: z.ZodTypeAny) => z.preprocess(v => (v === '' ? null : v), s.nullable());
const fields = {
  name: z.string().trim().min(1).max(80),
  email: nullable(z.string().trim().email().max(200)),
  userEmail: nullable(z.string().trim().email().max(200)),
  // Two decimals at most (33.33 is fine), above 0, at most MAX_PERCENT.
  percent: z.number().gt(0).max(MAX_PERCENT).refine(p => Math.round(p * 100) === p * 100, 'two decimals at most'),
  // null: while they are a partner.
  months: nullable(z.number().int().min(1).max(120)),
  razorpayOfferId: nullable(z.string().trim().regex(/^offer_[A-Za-z0-9]{6,40}$/)),
  routeAccountId: nullable(z.string().trim().regex(/^acc_[A-Za-z0-9]{6,40}$/)),
  payoutNote: nullable(z.string().trim().max(300)),
};

export default async function adminAffiliates(app: FastifyInstance) {
  app.get('/admin/affiliates', async req => { await requireAdmin(req); return affiliatesOverview(); });

  app.get('/admin/affiliates/:id', async req => { await requireAdmin(req); return affiliateDetail(id.parse(req.params).id); });

  app.post('/admin/affiliates', async req => {
    await requireAdmin(req);
    const b = z.object({ code: z.string().trim().min(4).max(16), ...fields, name: fields.name.optional(), percent: fields.percent.optional(),
      months: fields.months.optional(), email: fields.email.optional(), userEmail: fields.userEmail.optional(), razorpayOfferId: fields.razorpayOfferId.optional(),
      routeAccountId: fields.routeAccountId.optional(), payoutNote: fields.payoutNote.optional() }).strict().parse(req.body);
    return createAffiliate(b as any);
  });

  app.patch('/admin/affiliates/:id', async req => {
    await requireAdmin(req);
    const b = z.object(Object.fromEntries(Object.entries({ ...fields, status: z.enum(['active', 'paused', 'ended']) }).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()]))).strict().parse(req.body);
    return updateAffiliate(id.parse(req.params).id, b as any);
  });

  // Mark paid: everything owed in `currency`, after the money was sent. `amountMinor` is what the admin saw (refused if it changed).
  app.post('/admin/affiliates/:id/payouts', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const adminId = await requireAdmin(req);
    const b = z.object({ currency: z.string().regex(/^[A-Za-z]{3}$/), utr: z.string().max(40), amountMinor: z.number().int().optional(), inrPerUnit: z.number().positive().optional(), note: z.string().trim().max(300).optional() }).strict().parse(req.body);
    return recordPayout(id.parse(req.params).id, { currency: b.currency, utr: b.utr, expectedMinor: b.amountMinor, inrPerUnit: b.inrPerUnit, note: b.note ?? null, adminId });
  });

  // Monthly statement to email to the partner: ?month=YYYY-MM&format=csv|text.
  app.get('/admin/affiliates/:id/statement', async (req, reply) => {
    await requireAdmin(req);
    const q = z.object({ month: z.string(), format: z.enum(['csv', 'text']).default('csv') }).parse(req.query);
    const s = await affiliateStatement(id.parse(req.params).id, q.month, q.format);
    return reply.header('content-type', s.contentType).header('content-disposition', `attachment; filename="${s.filename}"`).send(s.body);
  });
}
