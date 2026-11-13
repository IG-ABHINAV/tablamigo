/**
 * Loaded into the LOCAL API server by e2e-scenarios.ts, never in production:
 *   node --import tsx --import ./src/scripts/e2e-preload.ts src/main.ts
 *
 * Nothing leaves the machine while it is loaded:
 * - emails are appended to MAIL_CAPTURE_FILE (one JSON object per line) instead of going to Resend;
 * - Razorpay, OpenAI (moderation and ideas), Nominatim and Photon requests are answered by the fake on E2E_FAKE_URL;
 * - Google Play and FCM (google-auth-library's own HTTP client) and Web Push go to the same fake;
 * - any other outside request throws.
 */
import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import webpush from 'web-push';
import { setMailTransport } from '../lib/mail.js';

const FAKE = process.env.E2E_FAKE_URL ?? '';
const FILE = process.env.MAIL_CAPTURE_FILE ?? '';
if (process.env.NODE_ENV === 'production' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(FAKE) || !FILE) {
  throw new Error('e2e-preload is for local end-to-end runs only (needs E2E_FAKE_URL and MAIL_CAPTURE_FILE, not production)');
}

setMailTransport(async m => {
  // A test creates `<MAIL_CAPTURE_FILE>.down` to play an email provider outage: every send fails until it is removed.
  if (fs.existsSync(FILE + '.down')) throw new Error('resend 503: service unavailable (e2e outage)');
  fs.appendFileSync(FILE, JSON.stringify({ ...m, at: new Date().toISOString(), by: 'server' }) + '\n');
  return { id: 'captured' };
});

const realFetch = globalThis.fetch;
const ROUTES: Record<string, string> = { 'api.razorpay.com': '/razorpay', 'api.openai.com': '/openai', 'nominatim.openstreetmap.org': '/nominatim', 'photon.komoot.io': '/photon',
  'api.telegram.org': '/telegram', 'graph.facebook.com': '/whatsapp', 'api.twilio.com': '/twilio' };
globalThis.fetch = (async (input: any, init?: any) => {
  const u = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return realFetch(input, init);
  const prefix = ROUTES[u.hostname];
  if (!prefix) throw new Error(`e2e: blocked a request to ${u.hostname}`);
  return realFetch(`${FAKE}${prefix}${u.pathname}${u.search}`, init);
}) as typeof fetch;

(GoogleAuth.prototype as any).getClient = async function () {
  return {
    request: async (o: { url: string; method?: string; data?: unknown }) => {
      const r = await realFetch(`${FAKE}/google`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: o.url, method: o.method ?? 'GET', data: o.data ?? null }) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw Object.assign(new Error(`google ${r.status}`), { response: { status: r.status, data } });
      return { data };
    },
  };
};

(webpush as any).sendNotification = async (sub: { endpoint: string }, payload: string) => {
  const r = await realFetch(`${FAKE}/webpush`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint, payload }) });
  if (!r.ok) throw Object.assign(new Error('webpush failed'), { statusCode: r.status });
  return { statusCode: 201 };
};
