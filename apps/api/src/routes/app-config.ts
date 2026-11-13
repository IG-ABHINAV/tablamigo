import type { FastifyInstance } from 'fastify';
import { config } from '../lib/config.js';

/**
 * GET /app/min-version: the oldest Android build that may still run.
 *
 * The Android app asks this once a day at start (apps/mobile/src/lib/update-prompt.ts). A build below the floor gets
 * Google Play's blocking in-app update instead of the usual background one; everything else gets the background one.
 * `null` -- ANDROID_MIN_VERSION_CODE unset, which is how it normally stands -- forces nothing.
 *
 * Public and cached: it runs before anyone has signed in, it holds nothing about a person, and it is one number the
 * Play listing shows anyway. Set it only to lock out a version that is actually broken.
 */
export default async function appConfig(app: FastifyInstance) {
  app.get('/app/min-version', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send({ androidMinVersionCode: config.androidMinVersionCode }));
}
