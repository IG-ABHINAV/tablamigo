/**
 * Self-serve partner sign-up (lib/partner-signup.ts): the member's own partner page in the app and web app (apps/mobile/src/app/
 * partner.tsx). Becoming a partner, their link and stats, and their payout details. Percent, duration, coupon and status are not
 * the member's to set: the body schemas are strict, so a `percent` in the body is a 400, not ignored.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../lib/auth.js';
import { PARTNER_TERMS, partnerView, createSelfPartner, setPayoutDetails } from '../lib/partner-signup.js';

export default async function partner(app: FastifyInstance) {
  app.get('/me/partner', async req => {
    const uid = await requireUser(req);
    return { partner: await partnerView(uid), terms: PARTNER_TERMS };
  });

  // Rate-limited per address: one member joins once, so more than a few a hour from one address is someone farming accounts.
  app.post('/me/partner', { config: { rateLimit: { max: 5, timeWindow: '1 hour' } } }, async req => {
    const uid = await requireUser(req);
    const b = z.object({ acceptTerms: z.literal(true), termsVersion: z.string().max(20) }).strict().parse(req.body ?? {});
    return createSelfPartner(uid, b.termsVersion);
  });

  app.put('/me/partner/payout', { bodyLimit: 4096, config: { rateLimit: { max: 10, timeWindow: '1 hour' } } }, async req => {
    const uid = await requireUser(req);
    const b = z.discriminatedUnion('method', [
      z.object({ method: z.literal('upi'), upiId: z.string().max(200) }).strict(),
      z.object({ method: z.literal('bank'), accountName: z.string().max(200), accountNumber: z.string().max(40), ifsc: z.string().max(20) }).strict(),
    ]).parse(req.body);
    return { payout: await setPayoutDetails(uid, b) };
  });
}
