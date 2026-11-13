import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '../lib/auth.js';
import { claimReviewAsk } from '../lib/review-ask.js';

const body = z.object({
  surface: z.enum(['android', 'ios', 'web']),
  trigger: z.enum(['messages', 'plan_join']),
});

/** POST /me/review-ask: may the app ask this person for a store rating right now? lib/review-ask.ts has the rules. */
export default async function reviewAsk(app: FastifyInstance) {
  app.post('/me/review-ask', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async req => {
    const uid = await requireUser(req);
    const { surface, trigger } = body.parse(req.body ?? {});
    const r = await claimReviewAsk(uid, surface);
    if (r.ask) req.log.info({ uid, surface, trigger }, 'review ask claimed');
    return r;
  });
}
