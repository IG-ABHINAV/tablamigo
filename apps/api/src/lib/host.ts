/**
 * The Tablamigo Host: one official team account (users.account_kind = 'team', migration 059), named "Tablamigo Host (Team)",
 * whose profile says it is the team and not a traveller. It is never verified, never onboarded and never a member of a plan.
 *
 * Its one job here: a single welcome DM to each new user who has a location or a trip, through the ordinary DM system.
 * The DM is accepted on both sides, never a message request; nothing is sent to anyone who blocked the Host, declined it, or
 * was blocked by it; post() (lib/chat-post.ts) leaves out muted chats and declined requests from pushes as it does for everyone. The free-tier DM limit (lib/chat-gate.ts) is a
 * paywall for people and does not apply to the team account; the contact shield is applied to everything the welcome
 * quotes from other people (plan titles and places).
 *
 * The welcome is a template, no AI: up to 3 real upcoming plans near the user (lib/emails/activation.ts plansFor, without
 * the Host's own plans; "N going" counts real people only), the next community starter plan there (lib/starter-plans.ts),
 * the real number of people in or heading to that city this week (lib/travellers-week.ts, left out at 0), and a nudge to
 * post a first plan.
 *
 * HOST_WELCOME (config.hostWelcome): 'off' does nothing, 'dry' logs who would get what (once per user per process) and
 * writes nothing, 'on' sends. One welcome per user ever: host_welcomes is claimed before the message is posted.
 * People reply in the DM; the team answers from the admin panel's Host inbox (routes/admin.ts /admin/host/*).
 */
import { sql } from './db.js';
import { config, type Mode } from './config.js';
import { clock } from './clock.js';
import { post, markRead } from './chat-post.js';
import { emitToChat, emitToUser, joinUserToChat } from './realtime.js';
import { plansFor } from './emails/activation.js';
import { firstName } from './emails/templates.js';
import { travellersThisWeek, realPerson, TRAVELLERS_RADIUS_KM } from './travellers-week.js';
import { wallClock, zoneAt } from './local-time.js';
import { findContact } from './contact-shield.js';
import { cachedPlace, cityKey } from './geo.js';
import { curatedCityNear } from './curated-cities.js';
import { STARTER_CITIES } from './starter-venues.js';

export const HOST_EMAIL = 'host@team.tablamigo';
/** Sign-ups get the welcome from 10 minutes to 72 hours after the account was made; older accounts never (no backlog blast). */
export const WELCOME_MIN_AGE_MIN = 10, WELCOME_MAX_AGE_HOURS = 72;
/** Local hours the welcome may arrive in, [from, until). */
export const WELCOME_FROM_HOUR = 9, WELCOME_UNTIL_HOUR = 21;
/** At most this many welcomes per scheduler tick (a minute). */
export const WELCOME_PER_TICK = 20;
/** A starter plan is only mentioned when it starts at least this far ahead (it is decided 3 hours before). */
export const STARTER_MIN_LEAD_HOURS = 4;
export const MAX_WELCOME_CHARS = 2000;

export type Host = { id: string; name: string };
/** The team account, or null when migration 059 hasn't run (or it was deleted or banned). */
export async function getHost(): Promise<Host | null> {
  const [h] = await sql`select id, name from users where account_kind = 'team' and deleted_at is null and banned_at is null limit 1`;
  return h ? { id: h.id as string, name: h.name as string } : null;
}

// --- the text ------------------------------------------------------------------------------------
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "Sat 18 Oct, 4 pm" / "Wed 22 Oct, 5:30 pm" on the wall clock of `zone`. */
export function whenLabel(at: Date | string, zone: string) {
  const w = wallClock(new Date(at).getTime(), zone);
  const dow = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
  return `${DOW[dow]} ${w.d} ${MON[w.mo - 1]}, ${w.h % 12 || 12}${w.mi ? ':' + String(w.mi).padStart(2, '0') : ''} ${w.h < 12 ? 'am' : 'pm'}`;
}

export type WelcomePlan = { id?: string; emoji?: string | null; title: string; startsAt: Date | string; placeName: string; going: number; zone: string };
export type WelcomeInput = {
  name: string | null;
  /** Hinglish for people from India, English for everyone else. */
  hinglish: boolean;
  /** The city the plans and the count are about; null says "near you". */
  city: string | null;
  plans: WelcomePlan[];
  starter: { id?: string; title: string; startsAt: Date | string; placeName: string; zone: string } | null;
  /** Other real people in or heading to the city this week; 0 leaves the line out. */
  others: number;
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
/** Titles and places are other people's words: kept short, so the 2,000-character cap can never cut a plan link in half. */
const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const HAS_ADDRESS = /https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|in|net|org|io|co|me|app|link|ly|xyz|info)\b/i;
/** The plan in the web app; the chat shows it as a link that opens the plan in the app (apps/mobile/src/lib/app-links.ts). */
const planLink = (id: string) => `${config.siteUrl}/app/activity/${id}`;

/** The welcome DM. Pure. Blocks that don't apply are left out; under MAX_WELCOME_CHARS (plan lines are dropped to fit). */
export function renderWelcome(d: WelcomeInput): string {
  const H = d.hinglish;
  const where = d.city ? (H ? `${d.city} mein` : `in ${d.city}`) : (H ? 'aapke aas-paas' : 'near you');
  const build = (plans: WelcomePlan[]) => {
    const blocks: string[] = [];
    blocks.push(H ? `Hi ${firstName(d.name)} 👋 Yeh Tablamigo team ka official account hai, koi traveller nahi.`
      : `Hi ${firstName(d.name)} 👋 This is the official Tablamigo team account, not a traveller.`);
    if (plans.length) {
      blocks.push([
        H ? `${cap(where)} aane wale plans:` : `Upcoming plans ${where}:`,
        ...plans.map(p => `• ${p.emoji ? p.emoji + ' ' : ''}${clip(p.title)} · ${whenLabel(p.startsAt, p.zone)} · ${clip(p.placeName)}${p.going > 0 ? ` · ${p.going} going` : ''}${p.id ? `\n${planLink(p.id)}` : ''}`),
        H ? 'Explore tab pe "Plans nearby" mein Join dabao.' : 'Tap Join under "Plans nearby" on the Explore tab.',
      ].join('\n'));
    }
    if (d.starter) {
      const s = { ...d.starter, title: clip(d.starter.title), placeName: clip(d.starter.placeName) }, when = whenLabel(s.startsAt, s.zone);
      blocks.push(H ? `☕ Tablamigo community meetup: ${s.title}, ${when}, ${s.placeName}. Jo join karte hain woh aapas mein milte hain, team se koi nahi aata. Kam se kam 2 log join karein tabhi hoga.${s.id ? `\nJoin karo: ${planLink(s.id)}` : ''}`
        : `☕ Tablamigo community meetup: ${s.title}, ${when}, ${s.placeName}. Travellers who join meet each other; no Tablamigo staff attends. It only goes ahead if at least 2 people join.${s.id ? `\nJoin here: ${planLink(s.id)}` : ''}`);
    }
    if (d.others > 0) {
      blocks.push(H ? (d.others === 1 ? `Iss hafte ${where} Tablamigo pe 1 aur insaan hai ya aa raha hai.` : `Iss hafte ${where} Tablamigo pe ${d.others} aur log hain ya aa rahe hain.`)
        : (d.others === 1 ? `This week 1 other person on Tablamigo is ${where} or on the way.` : `This week ${d.others} other people on Tablamigo are ${where} or on the way.`));
    }
    const create = H ? 'Pehla plan banao: Explore tab pe "Create" dabao, jagah aur time chuno. Chai, walk, kuch bhi chalega.'
      : 'Post your first plan: tap "Create" on the Explore tab and pick a place and a time. Chai, a walk, anything works.';
    blocks.push(!plans.length && !d.starter
      ? [H ? `${cap(where)} abhi koi khula plan nahi hai, toh pehla plan aapka ho sakta hai.` : `There are no open plans ${where} yet, so the first one could be yours.`, create].join('\n')
      : create);
    blocks.push(H ? 'Koi sawaal ho toh yahin reply karo, team ka koi insaan padhke jawab dega. Milna hamesha public jagah pe.'
      : 'Questions? Reply here and a person from the team will read it and answer. Always meet in a public place.');
    return blocks.join('\n\n');
  };
  // A web address in someone's plan title or place would be a tappable link in the official team's DM: leave that plan out.
  let plans = d.plans.filter(p => !HAS_ADDRESS.test(`${p.title}\n${p.placeName}`)).slice(0, 3);
  let text = build(plans);
  while (text.length > MAX_WELCOME_CHARS && plans.length) { plans = plans.slice(0, -1); text = build(plans); }
  return text.slice(0, MAX_WELCOME_CHARS);
}

// --- what goes in it -----------------------------------------------------------------------------
export type WelcomeUser = { id: string; name: string | null; gender: string | null; homeCountry: string | null; city: string | null; lat: number | null; lng: number | null };
export type WelcomeMeta = { city: string | null; cityKey: string | null; scope: string | null; plans: number; starter: string | null; others: number; chars: number };

const starterCity = (key: string | null) => key ? STARTER_CITIES.find(c => c.key === key) ?? null : null;
const canonical = async (key: string | null) => key ? ((await sql`select canonical_key from city_chat_aliases where alias_key = ${key}`)[0]?.canonicalKey as string | undefined) ?? key : null;

/**
 * The welcome for one user at `now`, and what it is about. Read-only. The city is the one the listed plans are in: the
 * next trip's city when plansFor found plans there, otherwise where the user is (their trip's city when there is no location).
 */
export async function buildWelcome(u: WelcomeUser, now: Date = clock.now()): Promise<{ text: string; meta: WelcomeMeta }> {
  // realGoing: "N going" counts real people only, never a demo persona or a store review account on someone's plan.
  const r = await plansFor({ id: u.id, gender: u.gender }, now, { excludeTeam: true, realGoing: true });
  const [trip] = await sql`select city, city_key, st_y(location::geometry) as lat, st_x(location::geometry) as lng
    from trips where user_id = ${u.id} and end_date >= current_date order by start_date limit 1`;
  const tripScope = r.scope === 'trip_dates' || r.scope === 'trip_city';
  let ctx: { city: string | null; key: string | null; lat: number | null; lng: number | null };
  if (trip && (tripScope || u.lat == null || u.lng == null)) {
    ctx = { city: trip.city, key: await canonical(trip.cityKey), lat: trip.lat ?? null, lng: trip.lng ?? null };
  } else {
    const place = u.lat != null && u.lng != null ? await cachedPlace(u.lat, u.lng) : null;
    // Near a popular city: its canonical chat key, whatever district the cached name gives (as POST /chats/city-here does).
    // The aliases seed-founder-city-chats wrote were made from the old names ('city-of-westminster-gb'), which the cleaned
    // names ('westminster-gb') no longer match.
    const snap = place?.country && u.lat != null && u.lng != null ? curatedCityNear(u.lat, u.lng, place.country) : null;
    const key = snap ? snap.key : place?.city && place.country ? cityKey(place.city, place.country) : null;
    ctx = { city: u.city ?? snap?.city ?? place?.city ?? null, key: await canonical(key), lat: u.lat, lng: u.lng };
  }
  // A trip typed without a point, to one of the starter cities: that city's centre stands in for "here".
  const sc = starterCity(ctx.key);
  const point = ctx.lat != null && ctx.lng != null ? { lat: ctx.lat, lng: ctx.lng } : sc ? { lat: sc.lat, lng: sc.lng } : null;

  // Other people's words go into this message: a plan whose title or place carries contact details is left out.
  const plans: WelcomePlan[] = r.plans
    .filter((p: any) => !findContact(`${p.title}\n${p.placeName}`))
    .map((p: any) => ({ id: p.id, emoji: p.emoji, title: p.title, startsAt: p.startsAt, placeName: p.placeName, going: p.going, zone: zoneAt(p.lat, p.lng) }));

  const [starter] = await sql`select a.id, a.title, a.starts_at, a.place_name, st_y(a.location::geometry) as lat, st_x(a.location::geometry) as lng
    from starter_plans s join activities a on a.id = s.activity_id
    where s.cancelled_at is null and a.status = 'active' and not a.closed
      and a.starts_at >= ${now}::timestamptz + ${STARTER_MIN_LEAD_HOURS + ' hours'}::interval
      and (a.max_people is null or (select count(*) from activity_members m where m.activity_id = a.id and m.rsvp_status = 'going') < a.max_people)
      and ((${!!point} and st_dwithin(a.location, st_setsrid(st_makepoint(${point?.lng ?? null}::float8, ${point?.lat ?? null}::float8), 4326)::geography, ${TRAVELLERS_RADIUS_KM * 1000}))
        or (${ctx.key}::text is not null and s.city_key = ${ctx.key}::text))
    order by a.starts_at limit 1`;

  const others = (await travellersThisWeek({ lat: point?.lat ?? null, lng: point?.lng ?? null, cityKey: ctx.key, excludeUserId: u.id, now })).total;
  const text = renderWelcome({
    name: u.name, hinglish: u.homeCountry === 'IN', city: ctx.city, plans, others,
    starter: starter ? { id: starter.id, title: starter.title, startsAt: starter.startsAt, placeName: starter.placeName, zone: zoneAt(starter.lat, starter.lng) } : null,
  });
  return { text, meta: { city: ctx.city, cityKey: ctx.key, scope: r.scope, plans: Math.min(plans.length, 3), starter: starter?.id ?? null, others, chars: text.length } };
}

// --- sending -------------------------------------------------------------------------------------
/**
 * Opens (or finds) the DM between the Host and a user: both sides are accepted (the team's DMs are never a message request,
 * and a pending one from before is accepted), except that a request the user declined stays declined.
 * The Host's side is accepted whatever it was: a person who wrote to the Host first left it 'pending' (see acceptHostSide).
 */
export async function openHostDm(hostId: string, userId: string): Promise<{ chatId: string; status: string }> {
  const key = [hostId, userId].sort().join(':');   // the same key POST /dm/:userId builds, in JS
  const [c] = await sql`insert into chats (kind, dm_key, last_message_at) values ('dm', ${key}, now())
    on conflict (dm_key) do update set dm_key = excluded.dm_key returning id`;
  await sql`insert into chat_members (chat_id, user_id, request_status) values (${c.id}, ${hostId}, 'accepted')
    on conflict (chat_id, user_id) do update set request_status = 'accepted' where chat_members.request_status <> 'accepted'`;
  // Official team messages never show up as a request: the user's side is accepted (a request they declined stays declined).
  const [theirs] = await sql`insert into chat_members (chat_id, user_id, request_status) values (${c.id}, ${userId}, 'accepted')
    on conflict (chat_id, user_id) do update set request_status = case when chat_members.request_status = 'pending' then 'accepted' else chat_members.request_status end
    returning request_status`;
  if (theirs.requestStatus !== 'declined') joinUserToChat(userId, c.id);
  return { chatId: c.id as string, status: theirs.requestStatus as string };
}

/** Local hour at `now` in `zone` is inside the welcome window. */
export const inWelcomeHours = (now: Date, zone: string) => { const h = wallClock(now.getTime(), zone).h; return h >= WELCOME_FROM_HOUR && h < WELCOME_UNTIL_HOUR; };

/** People due a welcome at `now`, oldest sign-up first, with the point and zone their quiet hours are read in. */
async function candidates(hostId: string, now: Date, o: { emailLike?: string; skip?: string[]; userId?: string }) {
  const rows = await sql`select u.id, u.email, u.name, u.gender, u.home_country, u.city, u.created_at,
      st_y(u.location::geometry) as lat, st_x(u.location::geometry) as lng,
      (select json_build_object('lat', st_y(t.location::geometry), 'lng', st_x(t.location::geometry), 'key', t.city_key)
        from trips t where t.user_id = u.id and t.end_date >= current_date order by t.start_date limit 1) as trip
    from users u
    where ${realPerson()}
      and u.birthdate is not null and u.birthdate <= (${now}::timestamptz at time zone 'UTC')::date - interval '18 years'
      and u.created_at <= ${now}::timestamptz - ${WELCOME_MIN_AGE_MIN + ' minutes'}::interval
      and u.created_at > ${now}::timestamptz - ${WELCOME_MAX_AGE_HOURS + ' hours'}::interval
      and (u.location is not null or exists (select 1 from trips t where t.user_id = u.id and t.end_date >= current_date))
      and not exists (select 1 from host_welcomes w where w.user_id = u.id)
      and not exists (select 1 from blocks b where (b.blocker_id = u.id and b.blocked_id = ${hostId}) or (b.blocker_id = ${hostId} and b.blocked_id = u.id))
      and not exists (select 1 from chats c join chat_members cm on cm.chat_id = c.id and cm.user_id = u.id
          join chat_members hm on hm.chat_id = c.id and hm.user_id = ${hostId}
        where c.kind = 'dm' and cm.request_status = 'declined')
      and not (u.id = any(${o.skip ?? []}::uuid[]))
      and (${o.emailLike ?? null}::text is null or u.email like ${o.emailLike ?? null})
      and (${o.userId ?? null}::uuid is null or u.id = ${o.userId ?? null}::uuid)
    order by u.created_at limit 200`;
  return rows.map(r => {
    const t = r.trip as { lat: number | null; lng: number | null; key: string } | null;
    const zone = r.lat != null ? zoneAt(r.lat, r.lng) : t?.lat != null ? zoneAt(t.lat, t.lng)
      : (r.homeCountry === 'IN' || t?.key?.endsWith('-in')) ? 'Asia/Kolkata' : 'UTC';
    return { ...(r as unknown as WelcomeUser & { email: string }), zone };
  });
}

/** Users the dry run has already logged in this process, so each is logged once. */
const dryLogged = new Set<string>();

export type WelcomeTally = { mode: Mode; sent: number; failed: number; planned: number; quiet: number; error?: string };

/**
 * One pass, run by the scheduler every tick. `mode` defaults to HOST_WELCOME; `emailLike`, `dryLog` and `limit` are for tests.
 */
export async function processHostWelcomes(now: Date = clock.now(), o: { mode?: Mode; emailLike?: string; dryLog?: Set<string>; limit?: number } = {}): Promise<WelcomeTally> {
  const mode = o.mode ?? config.hostWelcome;
  const t: WelcomeTally = { mode, sent: 0, failed: 0, planned: 0, quiet: 0 };
  if (mode === 'off') return t;
  const host = await getHost();
  if (!host) { console.warn('host welcome: no team account (migration 059 has not run?)'); return { ...t, error: 'no_host' }; }
  const logged = o.dryLog ?? dryLogged;
  let budget = o.limit ?? WELCOME_PER_TICK;
  for (const u of await candidates(host.id, now, { emailLike: o.emailLike, skip: mode === 'dry' ? [...logged] : [] })) {
    if (budget <= 0) break;
    if (!inWelcomeHours(now, u.zone)) { t.quiet++; continue; }
    budget--;
    const w = await buildWelcome(u, now);
    if (mode === 'dry') {
      logged.add(u.id);
      t.planned++;
      console.log(`host welcome (dry): user=${u.id} city=${w.meta.city ?? '-'} plans=${w.meta.plans} starter=${w.meta.starter ? 'yes' : 'no'} others=${w.meta.others} chars=${w.meta.chars}`);
      continue;
    }
    const r = await sendWelcome(host, u.id, w);
    if (r === 'sent') t.sent++; else if (r === 'failed') t.failed++;
  }
  return t;
}

/** Claims the user's one welcome, opens the DM and posts it as the Host. Never throws. */
export async function sendWelcome(host: Host, userId: string, w: { text: string; meta: WelcomeMeta }): Promise<'sent' | 'failed' | 'duplicate'> {
  const [claim] = await sql`insert into host_welcomes (user_id, status, meta) values (${userId}, 'pending', ${sql.json(w.meta as any)})
    on conflict (user_id) do nothing returning user_id`;
  if (!claim) return 'duplicate';
  try {
    const dm = await openHostDm(host.id, userId);
    if (dm.status === 'declined') {
      await sql`update host_welcomes set status = 'failed', chat_id = ${dm.chatId}, error = 'declined' where user_id = ${userId}`;
      return 'failed';
    }
    const msg = await post({ id: dm.chatId, kind: 'dm', title: null }, host.id, 'text', w.text, w.text.slice(0, 140), undefined, null, { analytics: false });
    await sql`update host_welcomes set status = 'sent', chat_id = ${dm.chatId}, message_id = ${msg.id}, sent_at = now() where user_id = ${userId}`;
    emitToUser(userId, 'chat:new', { chatId: dm.chatId });
    console.log(`host welcome: sent to user=${userId} city=${w.meta.city ?? '-'} plans=${w.meta.plans} starter=${w.meta.starter ? 'yes' : 'no'} others=${w.meta.others}`);
    return 'sent';
  } catch (e) {
    const err = String((e as Error)?.message ?? e).slice(0, 500);
    await sql`update host_welcomes set status = 'failed', error = ${err} where user_id = ${userId}`.catch(() => {});
    console.error('host welcome failed', userId, err);
    return 'failed';
  }
}

/** The welcome a user would get right now (admin preview), whatever the mode and whether or not they are due one. Read-only. */
export async function previewWelcome(userId: string, now: Date = clock.now()) {
  const host = await getHost();
  const [u] = await sql`select u.id, u.name, u.gender, u.home_country, u.city, st_y(u.location::geometry) as lat, st_x(u.location::geometry) as lng
    from users u where u.id = ${userId}`;
  if (!u) return null;
  const due = host ? (await candidates(host.id, now, { userId })).length > 0 : false;
  const [sent] = await sql`select status, chat_id, sent_at, error from host_welcomes where user_id = ${userId}`;
  return { mode: config.hostWelcome, due, welcome: sent ?? null, ...(await buildWelcome(u as unknown as WelcomeUser, now)) };
}

// --- the admin inbox -----------------------------------------------------------------------------
/** Every DM of the Host: the other person, their side of the request, the last message and what the team hasn't read. */
export async function hostChats(hostId: string) {
  return sql`select c.id, c.last_message_at, cm.request_status, cm.request_decided_at,
      json_build_object('id', u.id, 'name', u.name, 'email', u.email, 'photoUrl', u.photo_url, 'city', u.city, 'deleted', u.deleted_at is not null, 'banned', u.banned_at is not null) as user,
      exists (select 1 from blocks b where b.blocker_id = u.id and b.blocked_id = ${hostId}) as blocked_by_user,
      (select json_build_object('body', left(m.body, 200), 'fromHost', m.sender_id = ${hostId}, 'createdAt', m.created_at)
         from messages m where m.chat_id = c.id and m.deleted_at is null order by m.id desc limit 1) as last_message,
      (select count(*)::int from messages m where m.chat_id = c.id and m.sender_id is not null and m.sender_id <> ${hostId}
         and m.id > coalesce(hm.last_read_message_id, 0)) as unread
    from chats c
    join chat_members hm on hm.chat_id = c.id and hm.user_id = ${hostId}
    join chat_members cm on cm.chat_id = c.id and cm.user_id <> ${hostId}
    join users u on u.id = cm.user_id
    where c.kind = 'dm'
    order by c.last_message_at desc nulls last limit 200`;
}

/** Counts for the admin Host tab: welcomes by status, and how people answered the request. */
export async function hostStats(hostId: string) {
  const [w] = await sql`select count(*) filter (where status = 'sent')::int as sent, count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status = 'pending')::int as pending from host_welcomes`;
  const [r] = await sql`select count(*) filter (where cm.request_status = 'accepted')::int as accepted,
      count(*) filter (where cm.request_status = 'declined')::int as declined,
      count(*) filter (where cm.request_status = 'pending')::int as pending,
      count(*) filter (where exists (select 1 from blocks b where b.blocker_id = cm.user_id and b.blocked_id = ${hostId}))::int as blocked,
      count(*) filter (where exists (select 1 from messages m where m.chat_id = c.id and m.sender_id = cm.user_id))::int as replied
    from chats c join chat_members hm on hm.chat_id = c.id and hm.user_id = ${hostId}
    join chat_members cm on cm.chat_id = c.id and cm.user_id <> ${hostId}
    where c.kind = 'dm'`;
  return { welcomes: w, requests: r };
}

/** The other member of a DM of the Host, or null when `chatId` isn't one. */
export async function hostDmOther(hostId: string, chatId: string) {
  const [o] = await sql`select cm.user_id, cm.request_status from chats c
      join chat_members hm on hm.chat_id = c.id and hm.user_id = ${hostId}
      join chat_members cm on cm.chat_id = c.id and cm.user_id <> ${hostId}
    where c.id = ${chatId} and c.kind = 'dm'`;
  return o ? { userId: o.userId as string, requestStatus: o.requestStatus as string } : null;
}

/**
 * Accepts the Host's side of one of its DMs, as a person's Accept does (POST /chats/:id/accept-request). A person can write
 * to the Host first (Message on its profile, POST /dm/:hostId), which leaves the Host's side a 'pending' request, and
 * markRead() does nothing for a pending side: without this the team's reads and replies would never move the Host's read
 * position, so the admin unread count and the Host tab badge would never clear and the person would never see "Seen".
 * The team opening or answering the request is accepting it.
 */
export async function acceptHostSide(hostId: string, chatId: string) {
  const changed = await sql`update chat_members set request_status = 'accepted', request_decided_at = now()
    where chat_id = ${chatId} and user_id = ${hostId} and request_status <> 'accepted' returning chat_id`;
  if (changed.length) emitToChat(chatId, 'chat:request_accepted', { chatId, userId: hostId });
}

/** The last 100 messages of a Host DM, oldest first; reading them moves the Host's read position ("Seen", as a person reading). */
export async function hostChatMessages(hostId: string, chatId: string) {
  const rows = await sql`select m.id, m.kind, case when m.deleted_at is null then m.body else '' end as body, m.created_at, m.sender_id,
      m.sender_id = ${hostId} as from_host, u.name as sender_name
    from messages m left join users u on u.id = m.sender_id
    where m.chat_id = ${chatId} order by m.id desc limit 100`;
  await acceptHostSide(hostId, chatId);
  await markRead(chatId, hostId);
  return rows.reverse().map(r => ({ ...r, id: String(r.id) }));
}

/** A reply from the team, posted as the Host (post() then moves the Host's read position past everything it answered). */
export async function replyAsHost(hostId: string, chatId: string, body: string) {
  const text = body.trim();
  await acceptHostSide(hostId, chatId);
  // A reply from the team is never a message request for the person either (older welcomes left theirs pending).
  const [acc] = await sql`update chat_members set request_status = 'accepted', request_decided_at = now()
    where chat_id = ${chatId} and user_id <> ${hostId} and request_status = 'pending' returning user_id`;
  if (acc) emitToChat(chatId, 'chat:request_accepted', { chatId, userId: acc.userId });
  return post({ id: chatId, kind: 'dm', title: null }, hostId, 'text', text, text.slice(0, 140), undefined, null, { analytics: false });
}
