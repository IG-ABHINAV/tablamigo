import type { FastifyInstance } from 'fastify';
import { forwardSignatureOk, handleRazorpayEvent } from '../lib/razorpay-webhook.js';

/**
 * POST /billing/razorpay/webhook: Razorpay events forwarded by Hookpost's webhook, byte for byte, with
 * x-tablamigo-signature = HMAC-SHA256(raw body, TABLAMIGO_FORWARD_SECRET). Its own plugin so the raw-body
 * JSON parser applies to this route only.
 */
export default async function billingWebhook(app: FastifyInstance) {
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, body ? JSON.parse(body as string) : {}); }
    catch (e) { (e as any).statusCode = 400; done(e as Error, undefined); }
  });

  app.post('/billing/razorpay/webhook', async (req, reply) => {
    if (!forwardSignatureOk((req as any).rawBody ?? '', req.headers['x-tablamigo-signature'])) {
      return reply.status(401).send({ error: 'bad_signature' });
    }
    const event: any = req.body;
    try {
      const result = await handleRazorpayEvent(event);
      req.log.info({ event: event?.event, result }, 'razorpay event');
      return { ok: true, result };
    } catch (e) {
      req.log.error(e);
      return reply.status(500).send({ error: 'server_error' });
    }
  });
}
