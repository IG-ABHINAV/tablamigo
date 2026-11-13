/**
 * What the automatic team messages (lib/trip-match.ts, lib/plus-welcome.ts, lib/city-nudge.ts) share: who may get one, the
 * daytime they arrive in, and posting one as the Tablamigo Host through the ordinary DM system (lib/host.ts openHostDm, then
 * post(), which also pushes it to the person's phones and browsers unless they muted the chat).
 */
import crypto from 'node:crypto';
import { sql } from './db.js';
import { config } from './config.js';
import { post } from './chat-post.js';
import { openHostDm, type Host } from './host.js';
import { emitToUser } from './realtime.js';
import { wallClock, zoneAt } from './local-time.js';

/** Addresses that are never a real traveller: seeded demo personas, and test domains (as lib/review-ask.ts). */
export const NOT_A_TRAVELLER_EMAIL = '(@demo\\.tablamigo|@team\\.tablamigo|@deleted\\.tablamigo|\\.(test|example|invalid|localhost)|@example\\.(com|net|org))$';

/**
 * A real person the team may write to, as the users row `alias`: the person kind (never the team account), onboarded, not
 * deleted or banned, not a demo persona, a store review account, an admin or a test address.
 */
export const realTraveller = (alias: string) => {
  const u = sql(alias);
  const staff = [...config.reviewEmails, ...config.adminEmails].map(e => e.toLowerCase());
  return sql`(${u}.account_kind = 'person' and ${u}.onboarded and ${u}.deleted_at is null and ${u}.banned_at is null
    and ${u}.role <> 'admin' and not (lower(${u}.email) = any(${staff}::text[])) and ${u}.email !~* ${NOT_A_TRAVELLER_EMAIL})`;
};

/** Local hours the automatic messages may arrive in, [from, until): the same daytime as the Host's welcome. */
export const DAY_FROM_HOUR = 9, DAY_UNTIL_HOUR = 21;
export const inDaytime = (now: Date, zone: string) => { const h = wallClock(now.getTime(), zone).h; return h >= DAY_FROM_HOUR && h < DAY_UNTIL_HOUR; };

/** The zone a person's day is read in: the trip's city when known, else India for people from India, else UTC. */
export function zoneFor(p: { lat?: number | null; lng?: number | null; homeCountry?: string | null; cityKey?: string | null }) {
  if (p.lat != null && p.lng != null) return zoneAt(p.lat, p.lng);
  return p.homeCountry === 'IN' || p.cityKey?.endsWith('-in') ? 'Asia/Kolkata' : 'UTC';
}

/** A link into the web app (which hands off to the Android app). */
export const appLink = (path: string) => `${config.siteUrl}/app${path}`;

/**
 * Posts `text` to `userId` as the Host. 'declined' when the person declined the Host's DM (nothing is posted: their choice
 * stands); otherwise the chat and message ids. Throws on a database error.
 */
export async function postAsTeam(host: Host, userId: string, text: string): Promise<{ status: 'sent'; chatId: string; messageId: string } | { status: 'declined'; chatId: string }> {
  const dm = await openHostDm(host.id, userId);
  if (dm.status === 'declined') return { status: 'declined', chatId: dm.chatId };
  const msg = await post({ id: dm.chatId, kind: 'dm', title: null }, host.id, 'text', text, text.slice(0, 140), undefined, null, { analytics: false });
  emitToUser(userId, 'chat:new', { chatId: dm.chatId });
  return { status: 'sent', chatId: dm.chatId, messageId: String(msg.id) };
}

// --- one-tap "switch these alerts off" links (emails), for every app version -----------------------
export type AlertSwitch = 'trip_match' | 'plan' | 'nearby';
const COLUMN: Record<AlertSwitch, string> = { trip_match: 'trip_match_alerts', plan: 'plan_alerts', nearby: 'nearby_plan_alerts' };
const offMac = (payload: string) => crypto.createHmac('sha256', crypto.createHash('sha256').update('tablamigo-alerts-off:' + config.jwtSecret).digest())
  .update(payload).digest('base64url').slice(0, 32);
/** "<user id>.<switch>.<hmac>"; no expiry, like an unsubscribe link. */
export const alertsOffToken = (userId: string, which: AlertSwitch) => `${userId}.${which}.${offMac(`${userId}.${which}`)}`;
export const alertsOffUrl = (userId: string, which: AlertSwitch) => `${config.publicUrl}/alerts/off?t=${encodeURIComponent(alertsOffToken(userId, which))}`;
export function readAlertsOffToken(t: string): { userId: string; which: AlertSwitch } | null {
  const [userId, which, sig] = String(t).split('.');
  if (!userId || !/^[0-9a-f-]{36}$/.test(userId) || !(which in COLUMN) || !sig) return null;
  const want = Buffer.from(offMac(`${userId}.${which}`)), got = Buffer.from(sig);
  return want.length === got.length && crypto.timingSafeEqual(want, got) ? { userId, which: which as AlertSwitch } : null;
}
/** Switches one alert off (or on, for undo). False when the account is gone. */
export async function setAlert(userId: string, which: AlertSwitch, on: boolean) {
  const [u] = await sql`update users set ${sql(COLUMN[which])} = ${on} where id = ${userId} and deleted_at is null returning id`;
  return !!u;
}
