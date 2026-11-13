/**
 * The escalation ladder for time-sensitive events (Slack/Jira style): in-app and push first; only when that was not opened,
 * or the person has no push token at all, one message on the next channel they can receive, in CHANNEL_ORDER.
 *
 *   1. An event lands in the app (a team DM, a chat message, a plan reminder, an inbox notice) and is pushed to every token the
 *      person has. notification_log gets an 'inapp' row (what it was, what chat message or notice it is) and a 'push' row
 *      ('sent', or 'no_token'). Team messages record themselves (recordInApp); chat messages, plan reminders and buddy
 *      requests are picked up from their own tables each tick (materialize*), so that code needs no hook.
 *   2. Each tick copies what was read since (chat read positions, inbox read_at) into read_at, and taps on pushes
 *      (POST /me/notifications/opened) are opened_at.
 *   3. Still unopened after the event's delay in ESCALATION (or its noTokenDelayMin when there is no push token): one message on
 *      the first of email, WhatsApp, Telegram, SMS that the person can receive (channel configured, address, opt-in) and has
 *      not opted out of. One event never sends more than one message per channel (the notification_log key), stops at the
 *      first channel that took it, never in the person's night (local time; urgent events have a wider window), never past
 *      ESCALATIONS_PER_DAY a person, never for an event older than MAX_AGE_H, and not when the event's own switch is off
 *      (trip match alerts, plan alerts).
 *
 * EMAIL_LADDER (config.emailLadder): 'off' | 'dry' (logs what would go) | 'on'.
 */
import { sql } from './db.js';
import { clock } from './clock.js';
import { config, type Mode } from './config.js';
import { CHANNELS, pushChannel, type ChannelId, type OutMessage } from './channels.js';
import { firstName, appUrl } from './emails/templates.js';
import type { Email } from './emails/layout.js';
import { wallClock, zoneAt } from './local-time.js';
import { realTraveller, zoneFor } from './team-dm.js';

/** Per event type: minutes unopened before escalating, the same without a push token, and whose switch can stop it. */
export type EventRule = { delayMin: number; noTokenDelayMin: number; urgent?: boolean; digest?: boolean; optOut?: 'trip_match_alerts' | 'plan_alerts' | 'nearby_plan_alerts' };
export const ESCALATION = {
  /** A message in a plan's group chat (the closest thing the app has to a plan invite is the buddy request below). */
  plan_message: { delayMin: 30, noTokenDelayMin: 15 },
  /** A travel buddy request: someone invites you to travel together. */
  buddy_request: { delayMin: 30, noTokenDelayMin: 15 },
  /** The 2-hour plan reminder: about today, so a wider daytime window, and at once without a push token. */
  plan_soon: { delayMin: 30, noTokenDelayMin: 0, urgent: true, optOut: 'plan_alerts' },
  /** A person's DM or message request. */
  dm: { delayMin: 60, noTokenDelayMin: 15 },
  /** A new trip match (lib/trip-match.ts). */
  trip_match: { delayMin: 360, noTokenDelayMin: 15, optOut: 'trip_match_alerts' },
  /** Digest-type events: once a day at most, the next day. */
  city_nudge: { delayMin: 1440, noTokenDelayMin: 1440, digest: true, optOut: 'plan_alerts' },
  plan_views: { delayMin: 1440, noTokenDelayMin: 1440, digest: true, optOut: 'plan_alerts' },
  /** A new plan within 50 km for someone who switched on "Notify me when someone near me posts" (lib/nearby-alerts.ts). */
  nearby_plan: { delayMin: 240, noTokenDelayMin: 0, optOut: 'nearby_plan_alerts' },
} as const satisfies Record<string, EventRule>;
export type EventKind = keyof typeof ESCALATION;
export const ruleFor = (kind: string): EventRule | null => (ESCALATION as Record<string, EventRule>)[kind] ?? null;

/** Escalation channels, in order (push is step 1, with the in-app message). */
export const CHANNEL_ORDER: ChannelId[] = ['email', 'whatsapp', 'telegram', 'sms'];
export const ESCALATIONS_PER_DAY = 4;
/** Kept for callers that read the old name. */
export const FALLBACK_EMAILS_PER_DAY = ESCALATIONS_PER_DAY;
export const MAX_AGE_H = 72;
export const DAY_FROM_HOUR = 9, DAY_UNTIL_HOUR = 21, URGENT_FROM_HOUR = 7, URGENT_UNTIL_HOUR = 22;

export const quietHours = (now: Date, zone: string, urgent = false) => {
  const h = wallClock(now.getTime(), zone).h;
  return !(urgent ? h >= URGENT_FROM_HOUR && h < URGENT_UNTIL_HOUR : h >= DAY_FROM_HOUR && h < DAY_UNTIL_HOUR);
};

// --- what each event says on the other channels ------------------------------------------------
export type Builder = {
  email: (payload: any, u: { name: string | null; email: string }) => Email | null;
  /** Push / WhatsApp / Telegram / SMS text. */
  short: (payload: any) => { title: string; body: string; url: string };
  /** Checked just before escalating: false drops the escalation (someone blocked, the city got a plan...). */
  stillValid?: (userId: string, payload: any) => Promise<boolean>;
};
const builders = new Map<string, Builder>();
export function registerFallback(kind: EventKind, b: Builder) { builders.set(kind, b); }

/**
 * Records that `kind`/`ref` reached `userId` in the app (the message `messageId` in chat `chatId`, or the inbox notice
 * `noticeId`) and whether a push went with it. Idempotent. `payload` is what the other channels need later.
 */
export async function recordInApp(userId: string, kind: string, ref: string, o: { chatId?: string | null; messageId?: string | number | null; noticeId?: string | null; payload?: unknown; pushed?: boolean; at?: Date } = {}) {
  const tokens = o.pushed ?? await pushChannel.available(userId);
  const at = o.at ?? clock.now();
  const payload = o.noticeId ? { ...(o.payload as object ?? {}), noticeId: o.noticeId } : o.payload;
  await sql`insert into notification_log (user_id, kind, ref, channel, status, chat_id, message_id, payload, created_at)
    values (${userId}, ${kind}, ${ref}, 'inapp', 'sent', ${o.chatId ?? null}, ${o.messageId != null ? String(o.messageId) : null}, ${payload != null ? sql.json(payload as any) : null}, ${at})
    on conflict (kind, ref, user_id, channel) do nothing`;
  await sql`insert into notification_log (user_id, kind, ref, channel, status, created_at)
    values (${userId}, ${kind}, ${ref}, 'push', ${tokens ? 'sent' : 'no_token'}, ${at})
    on conflict (kind, ref, user_id, channel) do nothing`;
}

/** A tap on a push or an in-app notice (POST /me/notifications/opened). */
export async function markOpened(userId: string, kind: string, ref: string) {
  const r = await sql`update notification_log set opened_at = coalesce(opened_at, now())
    where user_id = ${userId} and kind = ${kind} and ref = ${ref} and channel in ('push', 'inapp') returning id`;
  return r.length > 0;
}

/** Copies what people read since the last tick into read_at: chat read positions and inbox notices. */
export async function refreshRead() {
  await sql`update notification_log n set read_at = now()
    from chat_members cm
    where n.channel = 'inapp' and n.read_at is null and n.chat_id is not null and n.message_id is not null
      and cm.chat_id = n.chat_id and cm.user_id = n.user_id and cm.last_read_message_id >= n.message_id`;
  await sql`update notification_log n set read_at = now()
    from notifications x
    where n.channel = 'inapp' and n.read_at is null and n.payload ? 'noticeId'
      and x.id = (n.payload->>'noticeId')::uuid and x.read_at is not null`;
}

// --- events read from their own tables -----------------------------------------------------------
const since = (now: Date) => sql`${now}::timestamptz - ${MAX_AGE_H + ' hours'}::interval`;

/** The newest unread message from a person in each DM and plan chat: one event per chat per unread streak. */
async function materializeChats(now: Date) {
  const rows = await sql`
    select cm.user_id, c.id as chat_id, c.kind as chat_kind, coalesce(cm.last_read_message_id, 0) as read_id, cm.request_status,
      m.id as message_id, m.created_at, s.name as sender, s.id as sender_id, a.id as activity_id, a.title as plan_title
    from chat_members cm join chats c on c.id = cm.chat_id and c.kind in ('dm', 'activity')
    left join activities a on a.id = c.activity_id
    join lateral (select id, sender_id, created_at from messages where chat_id = c.id and sender_id is not null and sender_id <> cm.user_id
      and deleted_at is null and kind <> 'system' order by id desc limit 1) m on true
    join users s on s.id = m.sender_id
    join users u on u.id = cm.user_id
    where m.id > coalesce(cm.last_read_message_id, 0) and not cm.muted and cm.request_status is distinct from 'declined'
      and ${realTraveller('s')} and ${realTraveller('u')}
      and (c.kind = 'dm' or (a.status = 'active' and a.starts_at > ${now}::timestamptz - interval '6 hours'))
      and m.created_at > ${since(now)} and m.created_at <= ${now}
      and not exists (select 1 from blocks b where (b.blocker_id = u.id and b.blocked_id = s.id) or (b.blocker_id = s.id and b.blocked_id = u.id))
    limit 1000`;
  for (const r of rows) {
    const kind = r.chatKind === 'dm' ? 'dm' : 'plan_message';
    await recordInApp(r.userId, kind, `${r.chatId}:${r.readId}`, { chatId: r.chatId, messageId: r.messageId, at: new Date(r.createdAt),
      payload: { sender: r.sender, senderId: r.senderId, chatId: r.chatId, request: r.requestStatus === 'pending', activityId: r.activityId, title: r.planTitle } });
  }
}

/** The 2-hour reminder each going member got (a system message in the plan chat, lib/plan-jobs.ts). */
async function materializePlanSoon(now: Date) {
  const rows = await sql`
    select a.id, a.title, a.place_name, a.starts_at, a.reminded_2h_at as reminded_at, m.user_id, c.id as chat_id,
      st_y(a.location::geometry) as lat, st_x(a.location::geometry) as lng,
      (select max(x.id) from messages x where x.chat_id = c.id and x.created_at <= a.reminded_2h_at + interval '5 seconds') as message_id
    from activities a
    join activity_members m on m.activity_id = a.id and m.rsvp_status = 'going'
    join chats c on c.activity_id = a.id
    join users u on u.id = m.user_id
    where a.status = 'active' and a.reminded_2h_at is not null and a.reminded_2h_at > ${since(now)} and a.starts_at > ${now}
      and ${realTraveller('u')}
    limit 1000`;
  for (const r of rows) {
    const w = wallClock(new Date(r.startsAt).getTime(), zoneAt(r.lat, r.lng));
    const when = `${w.h % 12 || 12}${w.mi ? ':' + String(w.mi).padStart(2, '0') : ''} ${w.h < 12 ? 'am' : 'pm'} local time`;
    await recordInApp(r.userId, 'plan_soon', r.id, { chatId: r.chatId, messageId: r.messageId, at: new Date(r.remindedAt),
      payload: { title: r.title, placeName: r.placeName, when, activityId: r.id, startsAt: r.startsAt } });
  }
}

/** Travel buddy requests, as inbox notices. */
async function materializeBuddyRequests(now: Date) {
  const rows = await sql`select n.id, n.user_id, n.created_at, a.name as sender, a.id as sender_id
    from notifications n join users u on u.id = n.user_id join users a on a.id = n.actor_id
    where n.kind = 'buddy_request' and n.read_at is null and n.created_at > ${since(now)} and n.created_at <= ${now}
      and ${realTraveller('u')} and ${realTraveller('a')}
    limit 1000`;
  for (const r of rows) await recordInApp(r.userId, 'buddy_request', r.id, { noticeId: r.id, at: new Date(r.createdAt), payload: { sender: r.sender, senderId: r.senderId } });
}

// --- the built-in events' text -------------------------------------------------------------------
const who = (name: string | null) => firstName(name) === 'there' ? 'Someone' : firstName(name);

export function dmEmail(d: { name: string | null; sender: string | null; chatId: string; request: boolean }): Email {
  const w = who(d.sender);
  return {
    subject: d.request ? `${w} wants to chat on Tablamigo` : `${w} sent you a message`, category: 'activity',
    preheader: 'Open Tablamigo to read it and reply.',
    blocks: [
      { t: 'h1', text: d.request ? `${w} wants to chat` : `New message from ${w}` },
      { t: 'p', text: `Hi ${firstName(d.name)}, ${w} wrote to you on Tablamigo. Messages stay in the app, so open it to read and reply.` },
      { t: 'button', label: 'Read it', url: appUrl(`/chat/${d.chatId}`) },
      { t: 'small', text: 'You get this email only when a message has been waiting a while. Turn these off with the unsubscribe link below.' },
    ],
  };
}

export function planMessageEmail(d: { name: string | null; sender: string | null; chatId: string; title: string | null }): Email {
  const w = who(d.sender), plan = d.title ?? 'your plan';
  return {
    subject: `${w} wrote in ${plan}`.slice(0, 70), category: 'activity',
    preheader: 'Open the plan chat to read it.',
    blocks: [
      { t: 'h1', text: `New message in ${plan}` },
      { t: 'p', text: `Hi ${firstName(d.name)}, ${w} wrote in the chat of ${plan}. Open it to read and reply.` },
      { t: 'button', label: 'Open the chat', url: appUrl(`/chat/${d.chatId}`) },
      { t: 'small', text: 'You get this email only when a message has been waiting a while. Mute the chat in the app to stop them.' },
    ],
  };
}

export function planSoonEmail(d: { name: string | null; title: string; placeName: string; when: string; activityId: string }): Email {
  return {
    subject: `Starting soon: ${d.title}`.slice(0, 70), category: 'reminders',
    preheader: `${d.when} at ${d.placeName}.`,
    blocks: [
      { t: 'h1', text: `${d.title} starts soon` },
      { t: 'p', text: `Hi ${firstName(d.name)}, you're going to ${d.title} at ${d.placeName}, ${d.when}. Can't make it? Tap "Can't go" in the plan so the others know.` },
      { t: 'button', label: 'Open the plan', url: appUrl(`/activity/${d.activityId}`) },
      { t: 'small', text: 'You get this email only when the reminder in the app went unseen. Plan alerts can be switched off in Profile.' },
    ],
  };
}

export function buddyRequestEmail(d: { name: string | null; sender: string | null }): Email {
  const w = who(d.sender);
  return {
    subject: `${w} wants to travel together`, category: 'activity',
    preheader: 'Open Tablamigo to accept or decline.',
    blocks: [
      { t: 'h1', text: `${w} sent you a travel buddy request` },
      { t: 'p', text: `Hi ${firstName(d.name)}, ${w} would like to meet up on your trip. Open Tablamigo to see their profile and accept or decline.` },
      { t: 'button', label: 'See the request', url: appUrl('/inbox') },
    ],
  };
}

/**
 * Only a real traveller's message is worth escalating: never a demo persona's (the AI engagement worker's), a test or review
 * account's, or someone since deleted, banned or blocked. Events recorded without a sender id (before this check) never go.
 */
const realSender = async (userId: string, p: any) => !!p?.senderId && (await sql`select 1 from users s where s.id = ${p.senderId} and ${realTraveller('s')}
  and not exists (select 1 from blocks b where (b.blocker_id = s.id and b.blocked_id = ${userId}) or (b.blocker_id = ${userId} and b.blocked_id = s.id))`).length > 0;

registerFallback('dm', {
  email: (p, u) => dmEmail({ name: u.name, sender: p.sender, chatId: p.chatId, request: !!p.request }),
  short: p => ({ title: p.request ? `${who(p.sender)} wants to chat` : `New message from ${who(p.sender)}`, body: 'Open Tablamigo to read it and reply.', url: appUrl(`/chat/${p.chatId}`) }),
  stillValid: realSender,
});
registerFallback('plan_message', {
  email: (p, u) => planMessageEmail({ name: u.name, sender: p.sender, chatId: p.chatId, title: p.title }),
  short: p => ({ title: `New message in ${p.title ?? 'your plan'}`, body: `${who(p.sender)} wrote in the plan chat.`, url: appUrl(`/chat/${p.chatId}`) }),
  stillValid: realSender,
});
registerFallback('plan_soon', {
  email: (p, u) => planSoonEmail({ name: u.name, title: p.title, placeName: p.placeName, when: p.when, activityId: p.activityId }),
  short: p => ({ title: `${p.title} starts soon`, body: `${p.when} at ${p.placeName}.`, url: appUrl(`/activity/${p.activityId}`) }),
  // Still going, and it hasn't started.
  stillValid: async (userId, p) => (await sql`select 1 from activities a join activity_members m on m.activity_id = a.id and m.user_id = ${userId}
    and m.rsvp_status = 'going' where a.id = ${p.activityId} and a.status = 'active' and a.starts_at > ${clock.now()}`).length > 0,
});
registerFallback('buddy_request', {
  email: (p, u) => buddyRequestEmail({ name: u.name, sender: p.sender }),
  short: p => ({ title: `${who(p.sender)} wants to travel together`, body: 'Open Tablamigo to accept or decline.', url: appUrl('/inbox') }),
  stillValid: realSender,
});

// --- escalation ----------------------------------------------------------------------------------
async function zoneOfUser(userId: string) {
  const [u] = await sql`select home_country, st_y(location::geometry) as lat, st_x(location::geometry) as lng,
      (select json_build_object('lat', st_y(t.location::geometry), 'lng', st_x(t.location::geometry), 'key', t.city_key)
         from trips t where t.user_id = users.id and t.end_date >= current_date order by t.start_date limit 1) as trip
    from users where id = ${userId}`;
  if (!u) return 'UTC';
  if (u.lat != null) return zoneAt(u.lat, u.lng);
  return zoneFor({ lat: u.trip?.lat, lng: u.trip?.lng, homeCountry: u.homeCountry, cityKey: u.trip?.key });
}

export type LadderTally = { sent: number; waiting: number; skipped: number; byChannel: Partial<Record<ChannelId, number>> };
const dryLogged = new Set<string>();
const done = async (r: { userId: string; kind: string; ref: string }, reason: string) =>
  sql`update notification_log set reason = ${reason} where user_id = ${r.userId} and kind = ${r.kind} and ref = ${r.ref} and channel = 'inapp'`;

/** Escalates one unopened event to the first channel that takes it. */
async function escalate(r: { userId: string; kind: string; ref: string; payload: any }, rule: EventRule, b: Builder, now: Date, mode: Mode, t: LadderTally) {
  if (rule.optOut) {
    const [u] = await sql`select ${sql(rule.optOut)} as on from users where id = ${r.userId}`;
    if (!u?.on) { await done(r, 'switched_off'); t.skipped++; return; }
  }
  if (b.stillValid && !(await b.stillValid(r.userId, r.payload))) { await done(r, 'no_longer_valid'); t.skipped++; return; }
  if (quietHours(now, await zoneOfUser(r.userId), rule.urgent)) { t.waiting++; return; }
  const short = b.short(r.payload);
  const msg: OutMessage = { kind: r.kind, ref: r.ref, ...short, email: u => b.email(r.payload, u) };
  for (const ch of CHANNEL_ORDER) {
    const [prev] = await sql`select status from notification_log where user_id = ${r.userId} and kind = ${r.kind} and ref = ${r.ref} and channel = ${ch}`;
    if (prev?.status === 'sent' || prev?.status === 'waiting') { await done(r, 'escalated'); return; }
    if (prev) continue;                                     // tried before: opted out, failed or unreachable there
    if (!(await CHANNELS[ch].available(r.userId))) continue;
    if (mode === 'dry') {
      const key = `${r.kind}:${r.ref}:${r.userId}`;
      if (!dryLogged.has(key)) { dryLogged.add(key); console.log(`ladder (dry): would send ${ch} to user=${r.userId} kind=${r.kind} ref=${r.ref}`); }
      t.waiting++; return;
    }
    // The daily cap and the claim under a per-person lock: two processes never both send the fifth message.
    const claimed = await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'ladder:' + r.userId}, 0))`;
      const [{ n }] = await tx`select count(*)::int as n from notification_log where user_id = ${r.userId} and channel = any(${CHANNEL_ORDER}::text[])
        and status in ('sent', 'waiting') and created_at > ${now}::timestamptz - interval '24 hours'`;
      if (n >= ESCALATIONS_PER_DAY) return 'cap';
      const [c] = await tx`insert into notification_log (user_id, kind, ref, channel, status, created_at) values (${r.userId}, ${r.kind}, ${r.ref}, ${ch}, 'waiting', ${now})
        on conflict (kind, ref, user_id, channel) do nothing returning id`;
      return c ? 'ok' : 'taken';
    });
    if (claimed === 'cap') { t.waiting++; return; }
    if (claimed === 'taken') return;
    let res: Awaited<ReturnType<typeof CHANNELS.email.send>>;
    try { res = await CHANNELS[ch].send(r.userId, msg); } catch (e) { res = 'failed'; console.error('ladder send failed', ch, r.kind, (e as Error)?.message); }
    const status = res === 'sent' ? 'sent' : res === 'failed' ? 'failed' : 'skipped';
    await sql`update notification_log set status = ${status}, reason = ${res === 'sent' ? null : res} where user_id = ${r.userId} and kind = ${r.kind} and ref = ${r.ref} and channel = ${ch}`;
    if (res === 'sent') { t.sent++; t.byChannel[ch] = (t.byChannel[ch] ?? 0) + 1; await done(r, 'escalated'); return; }
  }
  await done(r, 'no_channel');
  t.skipped++;
}

/** One ladder pass (the scheduler, every minute). */
export async function processLadder(now: Date = clock.now(), o: { mode?: Mode } = {}): Promise<LadderTally> {
  const t: LadderTally = { sent: 0, waiting: 0, skipped: 0, byChannel: {} };
  const mode = o.mode ?? config.emailLadder;
  if (mode === 'off') return t;
  await materializeChats(now);
  await materializePlanSoon(now);
  await materializeBuddyRequests(now);
  await refreshRead();
  const kinds = Object.keys(ESCALATION).filter(k => builders.has(k));
  const rows = await sql`select n.user_id, n.kind, n.ref, n.payload, n.created_at, p.status as push_status
    from notification_log n left join notification_log p on p.kind = n.kind and p.ref = n.ref and p.user_id = n.user_id and p.channel = 'push'
    where n.channel = 'inapp' and n.read_at is null and n.opened_at is null and n.reason is null and n.kind = any(${kinds}::text[])
      and n.created_at > ${since(now)} and n.created_at <= ${now}
    order by n.created_at limit 500`;
  for (const r of rows) {
    const rule = ruleFor(r.kind)!;
    const wait = r.pushStatus === 'no_token' ? rule.noTokenDelayMin : rule.delayMin;
    if (new Date(r.createdAt).getTime() > now.getTime() - wait * 60_000) continue;
    try { await escalate(r as any, rule, builders.get(r.kind)!, now, mode, t); }
    catch (e) { console.error('ladder failed', r.kind, r.ref, (e as Error)?.message); }
  }
  return t;
}
