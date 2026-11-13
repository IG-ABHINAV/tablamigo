import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { config } from './lib/config.js';
import { HttpError } from './lib/errors.js';
import { impersonationGuard } from './lib/auth.js';
import { sql } from './lib/db.js';
import { servableMedia, readImage } from './lib/storage.js';
import { securityHeaders, cspReportLines, cspSink } from './lib/security-headers.js';
import auth from './routes/auth.js';
import me from './routes/me.js';
import activities from './routes/activities.js';
import trips from './routes/trips.js';
import chats from './routes/chats.js';
import safety from './routes/safety.js';
import billing from './routes/billing.js';
import billingWebhook from './routes/billing-webhook.js';
import ai from './routes/ai.js';
import verify from './routes/verify.js';
import inbox from './routes/inbox.js';
import email from './routes/email.js';
import admin from './routes/admin.js';
import adminAffiliates from './routes/admin-affiliates.js';
import partner from './routes/partner.js';
import support from './routes/support.js';
import moments from './routes/moments.js';
import partnerships from './routes/partnerships.js';
import cities from './routes/cities.js';
import reviewAsk from './routes/review-ask.js';
import appConfig from './routes/app-config.js';
import growth from './routes/growth.js';

// Fastify's types leave out the hop-count form of trustProxy that proxy-addr supports; this is the same rule as a function.
const hopsTrusted = (n: number) => (_addr: string, hop: number) => hop < n;

export async function build() {
  const app = Fastify({ logger: { level: config.isProd ? 'info' : 'warn' }, trustProxy: typeof config.trustProxy === 'number' ? hopsTrusted(config.trustProxy) : config.trustProxy, bodyLimit: 1_000_000 });
  // The web app (tablamigo.hookstep.in/app) is the only browser client; native apps send no Origin.
  await app.register(cors, {
    origin: config.isProd ? ['https://tablamigo.hookstep.in'] : true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  // Security headers on every response, errors and 404s included (lib/security-headers.ts).
  app.addHook('onSend', async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(securityHeaders(String(reply.getHeader('content-type') ?? ''), config.isProd))) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
  // Browsers' CSP violation reports for the website and the web app (nginx sends a report-only policy pointing here).
  for (const type of ['application/csp-report', 'application/reports+json']) {
    app.addContentTypeParser(type, { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => {
      try { done(null, JSON.parse(body as string)); } catch { done(null, null); }
    });
  }
  app.post('/csp-report', { bodyLimit: 16_384, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    for (const line of cspReportLines(req.body)) cspSink.write(req.log, line);
    return reply.status(204).send();
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: 'invalid_input', issues: err.issues.map(i => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.code, ...(err.detail ? { message: err.detail } : {}), ...err.extra });
    if ((err as any).statusCode === 429) return reply.status(429).send({ error: 'rate_limited' });
    // Fastify's own client errors (bad JSON, body too large, wrong content type) are the caller's fault, not a 500.
    const sc = (err as any).statusCode;
    if (sc >= 400 && sc < 500) return reply.status(sc).send({ error: sc === 413 ? 'too_large' : 'invalid_input' });
    req.log.error(err);
    return reply.status(500).send({ error: 'server_error' });
  });

  // Read by the external uptime monitor (hookpost repo, .github/workflows/uptime.yml) and deploy.sh:
  // 200 {ok:true} only when Postgres answers.
  app.get('/health', async (_req, reply) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([sql`select 1`, new Promise((_, no) => { timer = setTimeout(() => no(new Error('timeout')), 3000); })]);
      return { ok: true, db: 'ok' };
    } catch {
      return reply.status(503).send({ ok: false, db: 'error' });
    } finally {
      clearTimeout(timer);
    }
  });
  impersonationGuard(app);   // admin "Login as user" tokens are read-only (lib/auth.ts)
  for (const r of [auth, me, activities, trips, chats, safety, billing, billingWebhook, ai, verify, inbox, email, admin, adminAffiliates, partner, support, moments, partnerships, cities, reviewAsk, appConfig, growth]) await app.register(r);

  // Photos and voice notes from Tablamigo's own private R2 bucket: in production R2_PUBLIC_URL is PUBLIC_URL + '/media'.
  // The bucket has no public address; a file's name is random, so only someone the app showed it to can open it.
  // Cloudflare keeps a copy at its edge for up to 4 hours. Not rate-limited: one chat screen loads many avatars.
  app.get('/media/*', { config: { rateLimit: false } }, async (req, reply) => {
    const key = (req.params as any)['*'] as string;
    const type = servableMedia(key);
    const body = type ? await readImage(key) : null;
    if (!body) return reply.status(404).send({ error: 'not_found' });
    return reply.type(type!).header('cache-control', 'public, max-age=14400').header('x-content-type-options', 'nosniff').send(body);
  });

  // Local-disk stand-in for R2 while developing.
  if (!config.isProd) {
    const dir = path.resolve('.dev-files');
    const raw = (_r: unknown, body: Buffer | string, done: (e: null, b: Buffer | string) => void) => done(null, body);
    app.addContentTypeParser(/^image\//, { parseAs: 'buffer' }, raw);
    app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, raw);
    app.put('/dev-upload/*', async req => {
      const key = (req.params as any)['*'] as string; const p = path.join(dir, key);
      if (!p.startsWith(dir + path.sep)) return { ok: false };
      fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, req.body as Buffer); return { ok: true };
    });
    app.get('/dev-files/*', async (req, reply) => {
      const p = path.join(dir, (req.params as any)['*']);
      if (!p.startsWith(dir) || !fs.existsSync(p)) return reply.status(404).send();
      return reply.type(p.endsWith('.png') ? 'image/png' : 'image/jpeg').send(fs.readFileSync(p));
    });
  }
  return app;
}
