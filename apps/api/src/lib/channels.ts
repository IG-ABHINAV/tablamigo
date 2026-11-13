/**
 * Delivery channels behind one interface, in escalation order (lib/ladder.ts CHANNEL_ORDER):
 *
 *   push      FCM (Android) and Web Push (web app, iPhone Home Screen app), lib/push.ts. Always first, with the in-app message.
 *   email     lib/emails/send.ts deliver(): email_prefs opt-outs, at-most-once per (kind, user, period), unsendable domains.
 *   whatsapp  Meta WhatsApp Cloud API, one approved *utility* template (WHATSAPP_TEMPLATE, two body parameters: the title and
 *             the text with its link). Only to a verified phone number whose owner said yes to WhatsApp (users.whatsapp_opt_in).
 *   telegram  Telegram Bot API sendMessage. Only to people who started the bot from their own link (GET /me/telegram-link, the
 *             bot's /start links users.telegram_chat_id; /stop unlinks).
 *   sms       Twilio Messages API. Only to a verified phone number whose owner said yes to SMS (users.sms_opt_in).
 *
 * WhatsApp, Telegram and SMS are off until their credentials are in the environment (the owner creates the accounts):
 * available() is false and send() says 'unavailable', so the ladder moves on. Every outside call goes through `http`, which
 * tests replace with a fake transport (setChannelTransport).
 */
import crypto from 'node:crypto';
import { sql } from './db.js';
import { config } from './config.js';
import { notify } from './push.js';
import { deliver, isSendable } from './emails/send.js';
import type { Email } from './emails/layout.js';

export type ChannelId = 'push' | 'email' | 'whatsapp' | 'telegram' | 'sms';
export type ChannelResult = 'sent' | 'unavailable' | 'opted_out' | 'duplicate' | 'failed';
export type OutMessage = {
  /** Event kind and the event's own id: with the user, the idempotency key. */
  kind: string; ref: string;
  /** Short text for push, WhatsApp, Telegram and SMS: a title, one or two sentences, and the link. */
  title: string; body: string; url?: string;
  /** Push payload (chatId, userId...). */
  data?: Record<string, string>;
  /** The email version; null when this event has none. */
  email?: Email | ((u: { name: string | null; email: string }) => Email | null) | null;
};

export interface Channel {
  id: ChannelId;
  /** Whether this person can be reached here at all right now (configured, a token, an address, a linked account). */
  available(userId: string): Promise<boolean>;
  send(userId: string, m: OutMessage): Promise<ChannelResult>;
}

// --- the outside world, replaceable in tests --------------------------------------------------------
export type HttpCall = { url: string; method: 'POST'; headers: Record<string, string>; body: string };
export type HttpTransport = (c: HttpCall) => Promise<{ status: number; body: string }>;
const fetchTransport: HttpTransport = async c => {
  const r = await fetch(c.url, { method: c.method, headers: c.headers, body: c.body, signal: AbortSignal.timeout(10_000) });
  return { status: r.status, body: await r.text() };
};
let http: HttpTransport = fetchTransport;
export function setChannelTransport(t: HttpTransport | null) { http = t ?? fetchTransport; }

/** Provider settings, read when used, so tests (and an env change after a restart) can set them. */
export const providers = {
  whatsapp: () => ({ token: process.env.WHATSAPP_TOKEN ?? '', phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID ?? '',
    template: process.env.WHATSAPP_TEMPLATE ?? '', lang: process.env.WHATSAPP_TEMPLATE_LANG ?? 'en' }),
  telegram: () => ({ token: process.env.TELEGRAM_BOT_TOKEN ?? '', username: process.env.TELEGRAM_BOT_USERNAME ?? '', secret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '' }),
  sms: () => ({ sid: process.env.TWILIO_ACCOUNT_SID ?? '', token: process.env.TWILIO_AUTH_TOKEN ?? '', from: process.env.TWILIO_FROM ?? '' }),
};
export const configured = {
  whatsapp: () => { const p = providers.whatsapp(); return !!(p.token && p.phoneNumberId && p.template); },
  telegram: () => { const p = providers.telegram(); return !!(p.token && p.username && p.secret); },
  sms: () => { const p = providers.sms(); return !!(p.sid && p.token && p.from); },
};

/** One plain-text message for the chat-like channels: title, text, link. SMS-sized when `max` is given. */
export function plainText(m: OutMessage, max?: number) {
  const link = m.url ? `\n${m.url}` : '';
  const text = `${m.title}\n${m.body}`.trim();
  if (!max || text.length + link.length <= max) return text + link;
  return text.slice(0, Math.max(0, max - link.length - 1)).trimEnd() + '…' + link;
}

const reachable = sql`deleted_at is null and banned_at is null and account_kind = 'person'`;

export const pushChannel: Channel = {
  id: 'push',
  async available(userId) { return (await sql`select 1 from push_tokens where user_id = ${userId} limit 1`).length > 0; },
  async send(userId, m) {
    if (!(await this.available(userId))) return 'unavailable';
    await notify([userId], { title: m.title, body: m.body, data: { ...(m.data ?? {}), nkind: m.kind, nref: m.ref }, tag: `${m.kind}-${m.ref}` });
    return 'sent';
  },
};

export const emailChannel: Channel = {
  id: 'email',
  async available(userId) {
    const [u] = await sql`select email from users where id = ${userId} and ${reachable}`;
    return !!u && isSendable(u.email);
  },
  async send(userId, m) {
    if (!m.email) return 'unavailable';
    const build = typeof m.email === 'function' ? m.email : () => m.email as Email;
    const r = await deliver({ kind: m.kind, userId, periodKey: m.ref, ref: m.ref, build });
    return r === 'sent' ? 'sent' : r === 'duplicate' ? 'duplicate' : r === 'opted_out' ? 'opted_out' : r === 'no_recipient' || r === 'nothing' ? 'unavailable' : 'failed';
  },
};

const verifiedPhone = async (userId: string, optIn: 'whatsapp_opt_in' | 'sms_opt_in') =>
  (await sql`select phone_e164 from users where id = ${userId} and ${reachable} and phone_e164 is not null and phone_verified_at is not null and ${sql(optIn)}`)[0]?.phoneE164 as string | undefined;

export const whatsappChannel: Channel = {
  id: 'whatsapp',
  async available(userId) { return configured.whatsapp() && !!(await verifiedPhone(userId, 'whatsapp_opt_in')); },
  async send(userId, m) {
    if (!configured.whatsapp()) return 'unavailable';
    const to = await verifiedPhone(userId, 'whatsapp_opt_in');
    if (!to) return 'unavailable';
    const p = providers.whatsapp();
    const r = await http({
      url: `https://graph.facebook.com/v21.0/${p.phoneNumberId}/messages`, method: 'POST',
      headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: to.replace(/^\+/, ''), type: 'template',
        template: { name: p.template, language: { code: p.lang }, components: [{ type: 'body', parameters: [
          { type: 'text', text: m.title.slice(0, 60) }, { type: 'text', text: `${m.body}${m.url ? ' ' + m.url : ''}`.slice(0, 900) },
        ] }] } }),
    });
    return r.status >= 200 && r.status < 300 ? 'sent' : 'failed';
  },
};

export const telegramChannel: Channel = {
  id: 'telegram',
  async available(userId) {
    return configured.telegram() && (await sql`select 1 from users where id = ${userId} and ${reachable} and telegram_chat_id is not null`).length > 0;
  },
  async send(userId, m) {
    if (!configured.telegram()) return 'unavailable';
    const [u] = await sql`select telegram_chat_id from users where id = ${userId} and ${reachable} and telegram_chat_id is not null`;
    if (!u) return 'unavailable';
    const r = await http({
      url: `https://api.telegram.org/bot${providers.telegram().token}/sendMessage`, method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(u.telegramChatId), text: plainText(m, 4000), disable_web_page_preview: true }),
    });
    // 403: they blocked the bot. Unlink, so nobody keeps writing to them.
    if (r.status === 403) { await sql`update users set telegram_chat_id = null, telegram_linked_at = null where id = ${userId}`; return 'unavailable'; }
    return r.status >= 200 && r.status < 300 ? 'sent' : 'failed';
  },
};

export const smsChannel: Channel = {
  id: 'sms',
  async available(userId) { return configured.sms() && !!(await verifiedPhone(userId, 'sms_opt_in')); },
  async send(userId, m) {
    if (!configured.sms()) return 'unavailable';
    const to = await verifiedPhone(userId, 'sms_opt_in');
    if (!to) return 'unavailable';
    const p = providers.sms();
    const r = await http({
      url: `https://api.twilio.com/2010-04-01/Accounts/${p.sid}/Messages.json`, method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${p.sid}:${p.token}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: p.from, Body: plainText(m, 300) }).toString(),
    });
    return r.status >= 200 && r.status < 300 ? 'sent' : 'failed';
  },
};

export const CHANNELS: Record<ChannelId, Channel> = { push: pushChannel, email: emailChannel, whatsapp: whatsappChannel, telegram: telegramChannel, sms: smsChannel };

// --- Telegram linking ---------------------------------------------------------------------------------
const tgMac = (userId: string) => crypto.createHmac('sha256', crypto.createHash('sha256').update('tablamigo-telegram:' + config.jwtSecret).digest())
  .update(userId).digest('base64url').slice(0, 20);
/** The /start payload for one person: their id without dashes and a MAC (Telegram allows 64 characters of [A-Za-z0-9_-]). */
export const telegramStartToken = (userId: string) => `${userId.replace(/-/g, '')}_${tgMac(userId)}`;
export function readTelegramStartToken(t: string): string | null {
  const m = /^([0-9a-f]{32})_([A-Za-z0-9_-]{20})$/.exec(t ?? '');
  if (!m) return null;
  const h = m[1], id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const want = Buffer.from(tgMac(id)), got = Buffer.from(m[2]);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? id : null;
}
/** The link that opens the bot with the person's token, or null while Telegram isn't set up. */
export const telegramLink = (userId: string) => configured.telegram() ? `https://t.me/${providers.telegram().username}?start=${telegramStartToken(userId)}` : null;

/**
 * One Telegram update (POST /telegram/webhook). "/start <token>" links the chat to the person the token belongs to (a chat can
 * belong to one person only); "/stop" unlinks. Returns what happened, for the test and the log.
 */
export async function handleTelegramUpdate(update: any): Promise<'linked' | 'unlinked' | 'ignored'> {
  const msg = update?.message;
  const chatId = msg?.chat?.id, text = typeof msg?.text === 'string' ? msg.text.trim() : '';
  if (typeof chatId !== 'number' || msg?.chat?.type !== 'private') return 'ignored';
  if (/^\/stop\b/.test(text)) {
    await sql`update users set telegram_chat_id = null, telegram_linked_at = null where telegram_chat_id = ${chatId}`;
    return 'unlinked';
  }
  const m = /^\/start\s+(\S+)$/.exec(text);
  const userId = m ? readTelegramStartToken(m[1]) : null;
  if (!userId) return 'ignored';
  await sql.begin(async tx => {
    await tx`update users set telegram_chat_id = null, telegram_linked_at = null where telegram_chat_id = ${chatId} and id <> ${userId}`;
    await tx`update users set telegram_chat_id = ${chatId}, telegram_linked_at = now() where id = ${userId} and deleted_at is null and banned_at is null`;
  });
  return 'linked';
}
