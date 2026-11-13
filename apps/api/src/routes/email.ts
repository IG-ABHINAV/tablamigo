import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { PREF_KEYS, readUnsubscribeToken, unsubscribeToken, type PrefKey } from '../lib/emails/send.js';
import { BRAND } from '../lib/emails/layout.js';
import { readAlertsOffToken, alertsOffToken, setAlert } from '../lib/team-dm.js';
import crypto from 'node:crypto';
import { configured, providers, handleTelegramUpdate, telegramLink } from '../lib/channels.js';
import { requireUser } from '../lib/auth.js';

const LABEL: Record<PrefKey, string> = {
  reminders: 'Plus and Trip Pass reminders',
  activity: 'activity emails (plan joins, trip matches, unread messages, Plus tips)',
  digest: 'the weekly trip digest',
  all: 'all optional Tablamigo emails',
};

async function setPref(userId: string, key: PrefKey, on: boolean) {
  const patch = key === 'all' && on ? sql.json({ all: true, reminders: true, activity: true, digest: true }) : sql.json({ [key]: on });
  const [u] = await sql`update users set email_prefs = email_prefs || ${patch} where id = ${userId} and deleted_at is null returning id`;
  return !!u;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const page = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Tablamigo</title>
<style>body{margin:0;background:${BRAND.bg};font:16px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${BRAND.body}}
main{max-width:480px;margin:56px auto;padding:0 16px}.card{background:#fff;border:1px solid ${BRAND.border};border-radius:14px;padding:32px}
h1{font-size:22px;line-height:1.3;color:${BRAND.ink};margin:0 0 12px}a{color:${BRAND.tealText}}.brand{display:flex;gap:10px;align-items:center;font-weight:700;color:${BRAND.ink};margin-bottom:20px}
.brand img{width:28px;height:28px;border-radius:7px}small{color:${BRAND.muted}}</style></head>
<body><main><div class="brand"><img src="https://tablamigo.hookstep.in/icon-192.png" alt="">Tablamigo</div><div class="card">${body}</div></main></body></html>`;

export default async function email(app: FastifyInstance) {
  // Links in emails. GET records the opt-out (that's what a person clicking expects); undo=1 reverses it.
  app.get('/email/unsubscribe', async (req, reply) => {
    const { t, undo } = z.object({ t: z.string().max(200), undo: z.string().optional() }).parse(req.query);
    const tok = readUnsubscribeToken(t);
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    if (!tok || !(await setPref(tok.userId, tok.key, !!undo))) {
      return reply.status(400).send(page('Link not valid', `<h1>This link doesn't work</h1><p>It may be incomplete, or the account was deleted. Email <a href="mailto:support@hookstep.in">support@hookstep.in</a> and we'll sort it out.</p>`));
    }
    const self = (key: PrefKey, u = false) => `/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(tok.userId, key))}${u ? '&undo=1' : ''}`;
    if (undo) return page('Subscribed again', `<h1>You're subscribed again</h1><p>You'll get ${LABEL[tok.key]} again.</p>`);
    return page('Unsubscribed', `<h1>You're unsubscribed</h1><p>You won't get ${LABEL[tok.key]} any more. Sign-in codes, receipts and account notices still arrive, because they're about your account.</p>
<p>${tok.key !== 'all' ? `<a href="${self('all')}">Unsubscribe from all optional emails</a> · ` : ''}<a href="${self(tok.key, true)}">Undo</a></p>`);
  });

  // "Switch these alerts off" from an email: trip match alerts or plan alerts, for people on any app version.
  app.get('/alerts/off', async (req, reply) => {
    const { t, undo } = z.object({ t: z.string().max(200), undo: z.string().optional() }).parse(req.query);
    const tok = readAlertsOffToken(t);
    reply.type('text/html; charset=utf-8').header('Cache-Control', 'no-store');
    if (!tok || !(await setAlert(tok.userId, tok.which, !!undo))) {
      return reply.status(400).send(page('Link not valid', `<h1>This link doesn't work</h1><p>It may be incomplete, or the account was deleted. Email <a href="mailto:support@hookstep.in">support@hookstep.in</a> and we'll sort it out.</p>`));
    }
    const what = tok.which === 'trip_match' ? 'trip match alerts' : tok.which === 'nearby' ? 'alerts for new plans near you' : 'plan alerts';
    const again = `/alerts/off?t=${encodeURIComponent(alertsOffToken(tok.userId, tok.which))}&undo=1`;
    if (undo) return page('Switched on', `<h1>${what[0].toUpperCase() + what.slice(1)} are on again</h1>`);
    return page('Switched off', `<h1>${what[0].toUpperCase() + what.slice(1)} are off</h1><p>You can switch them on again in the app under Profile, or <a href="${again}">undo</a>.</p>`);
  });

  // Telegram: the person's own link to the bot (null until the owner sets the bot up), and the bot's webhook, which only
  // Telegram can call (it sends TELEGRAM_WEBHOOK_SECRET in X-Telegram-Bot-Api-Secret-Token, set with setWebhook).
  app.get('/me/telegram-link', async req => ({ url: telegramLink(await requireUser(req)) }));
  app.post('/telegram/webhook', async (req, reply) => {
    if (!configured.telegram()) return reply.status(404).send({ error: 'not_found' });
    const got = Buffer.from(String(req.headers['x-telegram-bot-api-secret-token'] ?? '')), want = Buffer.from(providers.telegram().secret);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return reply.status(401).send({ error: 'unauthorized' });
    return { ok: true, result: await handleTelegramUpdate(req.body) };
  });

  // RFC 8058 one-click unsubscribe: mail clients POST "List-Unsubscribe=One-Click" to the same URL.
  await app.register(async one => {
    one.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_r, body, done) => done(null, body));
    one.post('/email/unsubscribe', async (req, reply) => {
      const { t } = z.object({ t: z.string().max(200) }).parse(req.query);
      const tok = readUnsubscribeToken(t);
      if (!tok || !(await setPref(tok.userId, tok.key, false))) return reply.status(400).send({ error: 'invalid_token' });
      return { ok: true };
    });
  });

  app.get('/me/email-prefs', async req => {
    const uid = await requireUser(req);
    const [u] = await sql`select email_prefs from users where id = ${uid}`;
    const p = u?.emailPrefs ?? {};
    return { prefs: Object.fromEntries(PREF_KEYS.map(k => [k, p[k] !== false])) };
  });

  app.put('/me/email-prefs', async req => {
    const uid = await requireUser(req);
    const b = z.object({ reminders: z.boolean(), activity: z.boolean(), digest: z.boolean(), all: z.boolean() }).partial().parse(req.body);
    await sql`update users set email_prefs = email_prefs || ${sql.json(b)} where id = ${uid}`;
    return { ok: true };
  });
}
