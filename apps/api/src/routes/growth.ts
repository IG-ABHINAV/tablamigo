import type { FastifyInstance } from 'fastify';
import { requireUser, impersonatorOf } from '../lib/auth.js';
import { sql } from '../lib/db.js';
import { claimPlusIntro } from '../lib/plus-intro.js';
import { socialProof, popularCities } from '../lib/social-proof.js';

/**
 * The soft paywall after onboarding (lib/plus-intro.ts) and the public live counts (lib/social-proof.ts).
 */
export default async function growth(app: FastifyInstance) {
  // Called once, as the person leaves the "what now" screen. show = true only on the call that first marks the account; the
  // body is ignored, so nobody can claim or reset another account's screen.
  app.post('/me/plus-intro', async req => {
    const uid = await requireUser(req);
    const r = await claimPlusIntro(uid, { impersonated: !!impersonatorOf(req) });
    if (r.show) await sql`insert into analytics_events (user_id, event_name, properties) values (${uid}, 'plus_intro_shown', ${sql.json({})})`.catch(() => {});
    return r;
  });

  // Public: the website's home page and the app read these. Nothing about a city below the threshold is ever in them.
  const pub = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  app.get('/public/social-proof', pub, async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send(await socialProof()));
  app.get('/public/popular-cities', pub, async (_req, reply) =>
    reply.header('cache-control', 'public, max-age=300').send(await popularCities()));
}
