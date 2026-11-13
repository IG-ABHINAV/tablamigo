/**
 * Community starter plans: in the curated cities (lib/starter-venues.ts) where real people are, the Tablamigo Host keeps up to
 * 3 upcoming plans at public places, such as "Saturday café meetup (community)" or "Sunset walk (community)". The Host only
 * lists them: it is never a member, so the "going" count is only the real people who joined, and nobody from the team attends.
 *
 * Honesty rules, all enforced here:
 *  - The description says it plainly (STARTER_DESCRIPTION), and every title says "(community)".
 *  - A meetup only goes ahead with at least MIN_REAL_GOING real people going (not demo personas, review accounts or the team
 *    account). From DECIDE_HOURS before the start it is decided on every tick: too few, and it is cancelled the way a plan of
 *    a deleted host is (lib/plans.ts announceCancelled: a system line and a 'cancelled' inbox notice) plus a push to the
 *    members; enough, and a "pakka" line goes in its chat once. Someone dropping out after that still cancels it.
 *  - Don't flood: a city only gets plans while at least DEMAND_PEOPLE real people are around it (located there in the last
 *    30 days, or with a trip there in the next 14), never more than MAX_OPEN_PER_CITY open ones, each slot listed once
 *    per date, from 72 hours to 10 days ahead. No push, no analytics event, no plan_created (that would inflate the funnel).
 *
 * STARTER_PLANS (config.starterPlans) governs listing new plans, once an hour: 'off' lists none, 'dry' logs what it would
 * list, 'on' lists them. The decision on plans already listed runs on every tick whatever the mode, because their
 * description promised it.
 */
import { sql } from './db.js';
import { config, type Mode } from './config.js';
import { clock } from './clock.js';
import { notify } from './push.js';
import { announceCancelled } from './plans.js';
import { emitToChat } from './realtime.js';
import { instantAt, localDate, wallClock, zoneAt } from './local-time.js';
import { realPerson, TRAVELLERS_RADIUS_KM } from './travellers-week.js';
import { getHost } from './host.js';
import { insertHostPlan } from './host-plans.js';
import { STARTER_CITIES, type StarterCity, type VenueKind } from './starter-venues.js';

export const MIN_REAL_GOING = 2;
export const DECIDE_HOURS = 3;
export const MAX_OPEN_PER_CITY = 3;
export const MAX_PEOPLE = 8;
export const CREATE_FROM_HOURS = 72, CREATE_UNTIL_DAYS = 10;
export const DEMAND_PEOPLE = 2, DEMAND_RECENT_DAYS = 30, DEMAND_TRIP_DAYS = 14;

export const STARTER_DESCRIPTION = 'Tablamigo community meetup: travellers who join meet each other; no Tablamigo staff attends. '
  + 'Yeh tabhi hoga jab kam se kam 2 log join karein, warna start se 3 ghante pehle apne aap cancel ho jayega. '
  + 'Public jagah, din ka time. Milne ka exact spot group chat mein tay karo.';
export const OPENING_LINE = 'Tablamigo community meetup. Jo join karega woh yahin milega; Tablamigo team se koi nahi aata.';
export const goLine = (n: number) => `✅ ${n} log going hain, meetup pakka. Team se koi nahi aayega: exact spot aur time yahin tay karo, aur public jagah pe hi milo.`;
export const CANCEL_LINE = 'Is meetup mein 2 log join nahi hue, isliye yeh cancel ho gaya. Agla community meetup jald list hoga.';
export const cancelNotice = (title: string) => `${title} cancelled: 2 people hadn't joined`;
export const cancelPush = (title: string) => ({ title: 'Meetup cancelled', body: `${title}: kam se kam 2 log join nahi hue.` });

export type Slot = { slot: string; weekday: number; h: number; mi: number; title: string; emoji: string; category: 'food' | 'outdoors'; venue: VenueKind };
/** Local wall-clock times of the venue's city. weekday: 0 = Sunday. */
export const SLOTS: Slot[] = [
  { slot: 'sat_cafe', weekday: 6, h: 16, mi: 0, title: 'Saturday café meetup (community)', emoji: '☕', category: 'food', venue: 'cafe' },
  { slot: 'sun_sunset', weekday: 0, h: 17, mi: 0, title: 'Sunset walk (community)', emoji: '🌅', category: 'outdoors', venue: 'sunset' },
  { slot: 'wed_chai', weekday: 3, h: 17, mi: 30, title: 'Wednesday chai & chat (community)', emoji: '☕', category: 'food', venue: 'chai' },
];

const H = 3600_000, D = 24 * H;

/** The times of `slot` that can be listed at `now`: its days in `zone`, from CREATE_FROM_HOURS to CREATE_UNTIL_DAYS ahead. */
export function slotTimes(now: Date, zone: string, s: Slot): Date[] {
  const w = wallClock(now.getTime(), zone);
  const out: Date[] = [];
  for (let k = 0; k <= CREATE_UNTIL_DAYS + 1; k++) {
    const day = new Date(Date.UTC(w.y, w.mo - 1, w.d + k));
    if (day.getUTCDay() !== s.weekday) continue;
    const at = new Date(instantAt(zone, { y: day.getUTCFullYear(), mo: day.getUTCMonth() + 1, d: day.getUTCDate(), h: s.h, mi: s.mi, s: 0 }));
    const lead = at.getTime() - now.getTime();
    if (lead >= CREATE_FROM_HOURS * H && lead < CREATE_UNTIL_DAYS * D) out.push(at);
  }
  return out;
}

/** Real people going to a plan: not demo personas, review accounts or the team account (which can't be a member anyway). */
export async function realGoing(activityId: string) {
  const [{ n }] = await sql`select count(*)::int as n from activity_members m join users u on u.id = m.user_id
    where m.activity_id = ${activityId} and m.rsvp_status = 'going' and ${realPerson()}`;
  return n as number;
}

/** Real people around a starter city at `now`: located within 30 km in the last 30 days, or with a trip there in the next 14. */
export async function cityDemand(c: StarterCity, now: Date) {
  const today = localDate(now, zoneAt(c.lat, c.lng));
  const centre = sql`st_setsrid(st_makepoint(${c.lng}::float8, ${c.lat}::float8), 4326)::geography`;
  const m = TRAVELLERS_RADIUS_KM * 1000;
  const [{ n }] = await sql`select count(*)::int as n from users u
    where ${realPerson()}
      and ((u.location is not null and u.location_at > ${now}::timestamptz - ${DEMAND_RECENT_DAYS + ' days'}::interval
            and u.location_at <= ${now}::timestamptz and st_dwithin(u.location, ${centre}, ${m}))
        or exists (select 1 from trips t left join city_chat_aliases al on al.alias_key = t.city_key
          where t.user_id = u.id and t.end_date >= ${today}::date and t.start_date <= ${today}::date + ${DEMAND_TRIP_DAYS}::int
            and ((t.location is not null and st_dwithin(t.location, ${centre}, ${m})) or coalesce(al.canonical_key, t.city_key) = ${c.key})))`;
  return n as number;
}

const SKIP = new Error('starter plan already listed');

/** Lists one starter plan in one transaction: the plan (no members), its chat with the opening line, and the starter_plans row. */
async function createStarterPlan(hostId: string, c: StarterCity, s: Slot, at: Date): Promise<string | null> {
  const v = c.venues[s.venue];
  try {
    return await sql.begin(async tx => {
      const a = await insertHostPlan(tx, hostId, { title: s.title, emoji: s.emoji, category: s.category, description: STARTER_DESCRIPTION, placeName: v.name,
        lat: v.lat, lng: v.lng, city: c.city, startsAt: at, maxPeople: MAX_PEOPLE }, OPENING_LINE);
      const [row] = await tx`insert into starter_plans (activity_id, city_key, slot, starts_at, venue) values (${a.id}, ${c.key}, ${s.slot}, ${at}, ${v.name})
        on conflict (city_key, slot, starts_at) do nothing returning activity_id`;
      if (!row) throw SKIP;   // another process listed it first: roll this one back
      return a.id as string;
    });
  } catch (e) {
    if (e === SKIP) return null;
    throw e;
  }
}

/** Process-wide memory of what the dry run already logged, so each would-be plan is logged once. */
const dryLogged = new Set<string>();

export type Maintained = { cities: { key: string; demand: number; open: number }[]; created: { key: string; slot: string; at: string; id?: string }[] };

/** Lists what is due in every curated city with demand. 'dry' only logs. Never more than MAX_OPEN_PER_CITY open per city. */
export async function maintainStarterPlans(now: Date, mode: Exclude<Mode, 'off'>, o: { cities?: StarterCity[]; dryLog?: Set<string> } = {}): Promise<Maintained> {
  const out: Maintained = { cities: [], created: [] };
  const host = await getHost();
  if (!host) { console.warn('starter plans: no team account (migration 059 has not run?)'); return out; }
  const logged = o.dryLog ?? dryLogged;
  for (const c of o.cities ?? STARTER_CITIES) {
    const demand = await cityDemand(c, now);
    const [{ open }] = await sql`select count(*)::int as open from starter_plans s join activities a on a.id = s.activity_id
      where s.city_key = ${c.key} and a.status = 'active' and a.starts_at > ${now}`;
    out.cities.push({ key: c.key, demand, open });
    if (demand < DEMAND_PEOPLE) continue;
    let room = MAX_OPEN_PER_CITY - open;
    const zone = zoneAt(c.lat, c.lng);
    const due = SLOTS.flatMap(s => slotTimes(now, zone, s).map(at => ({ s, at }))).sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const { s, at } of due) {
      if (room <= 0) break;
      const [listed] = await sql`select 1 from starter_plans where city_key = ${c.key} and slot = ${s.slot} and starts_at = ${at}`;
      if (listed) continue;   // listed before, even if it was cancelled since: never listed twice
      if (mode === 'dry') {
        const k = `${c.key}/${s.slot}/${at.toISOString()}`;
        if (!logged.has(k)) { logged.add(k); console.log(`starter (dry): would create ${k} @ ${c.venues[s.venue].name}`); }
        out.created.push({ key: c.key, slot: s.slot, at: at.toISOString() });
        room--;
        continue;
      }
      const id = await createStarterPlan(host.id, c, s, at);
      if (!id) continue;
      room--;
      out.created.push({ key: c.key, slot: s.slot, at: at.toISOString(), id });
      console.log(`starter: created ${c.key}/${s.slot} ${at.toISOString()} @ ${c.venues[s.venue].name} (${id})`);
    }
  }
  return out;
}

type DuePlan = { id: string; title: string; chatId: string | null; goAnnouncedAt: Date | null };

async function cancelStarter(d: DuePlan, n: number, now: Date) {
  const [a] = await sql`update activities set status = 'cancelled' where id = ${d.id} and status = 'active' returning id`;
  if (!a) return false;
  await sql`update starter_plans set cancelled_at = ${now}, real_going_at_cancel = ${n} where activity_id = ${d.id}`;
  await announceCancelled([d.id], CANCEL_LINE, cancelNotice);
  const members = (await sql`select user_id from activity_members where activity_id = ${d.id}`).map(m => m.userId as string);
  if (members.length && d.chatId) notify(members, { ...cancelPush(d.title), data: { chatId: d.chatId }, tag: d.chatId }).catch(() => {});
  console.log(`starter: cancelled ${d.id} "${d.title}" (${n} real going)`);
  return true;
}

async function announceGo(d: DuePlan, n: number, now: Date) {
  if (!d.chatId) return false;
  const [claim] = await sql`update starter_plans set go_announced_at = ${now} where activity_id = ${d.id} and go_announced_at is null returning activity_id`;
  if (!claim) return false;
  const body = goLine(n);
  const [msg] = await sql`insert into messages (chat_id, kind, body) values (${d.chatId}, 'system', ${body}) returning id, chat_id, kind, body, created_at, sender_id`;
  await sql`update chats set last_message_at = now() where id = ${d.chatId}`;
  emitToChat(d.chatId, 'message:new', { ...msg, id: String(msg.id) });
  console.log(`starter: going ahead ${d.id} "${d.title}" (${n} real going)`);
  return true;
}

/** Decides every listed starter plan that starts within DECIDE_HOURS of `now`: cancel below MIN_REAL_GOING, else announce once. */
export async function decideStarterPlans(now: Date) {
  const due = await sql<DuePlan[]>`select s.activity_id as id, a.title, s.go_announced_at, (select c.id from chats c where c.activity_id = a.id) as chat_id
    from starter_plans s join activities a on a.id = s.activity_id
    where s.cancelled_at is null and a.status = 'active'
      and s.starts_at > ${now}::timestamptz and s.starts_at <= ${now}::timestamptz + ${DECIDE_HOURS + ' hours'}::interval
    order by s.starts_at limit 100`;
  let cancelled = 0, confirmed = 0;
  for (const d of due) {
    try {
      const n = await realGoing(d.id);
      if (n < MIN_REAL_GOING) { if (await cancelStarter(d, n, now)) cancelled++; }
      else if (!d.goAnnouncedAt && await announceGo(d, n, now)) confirmed++;
    } catch (e) { console.error('starter plan decision failed', d.id, (e as Error).message); }
  }
  return { cancelled, confirmed };
}

/** The hour (UTC) listing last ran in this process; listing runs once an hour, the decision every tick. */
const listed = { hour: null as string | null };

/** One scheduler pass. `mode` defaults to STARTER_PLANS; `state` is for tests. */
export async function processStarterPlans(now: Date = clock.now(), state: { hour: string | null } = listed, o: { mode?: Mode; cities?: StarterCity[]; dryLog?: Set<string> } = {}) {
  const mode = o.mode ?? config.starterPlans;
  const decided = await decideStarterPlans(now);
  let maintained: Maintained | { error: string } | null = null;
  const hour = now.toISOString().slice(0, 13);
  if (mode !== 'off' && state.hour !== hour) {
    try {
      maintained = await maintainStarterPlans(now, mode, { cities: o.cities, dryLog: o.dryLog });
      state.hour = hour;
    } catch (e) {
      console.error('starter plans: listing failed', (e as Error).message);
      maintained = { error: (e as Error).message };
    }
  }
  return { mode, ...decided, maintained };
}

/** For the admin Host tab: every starter plan from `since` on, with how many real people are going. */
export async function starterPlansList(since: Date) {
  return sql`select s.activity_id as id, s.city_key, s.slot, s.starts_at, s.venue, s.go_announced_at, s.cancelled_at, s.real_going_at_cancel,
      a.title, a.status, a.city, (select c.id from chats c where c.activity_id = a.id) as chat_id,
      (select count(*)::int from activity_members m join users u on u.id = m.user_id where m.activity_id = a.id and m.rsvp_status = 'going' and ${realPerson()}) as real_going,
      (select count(*)::int from activity_members m where m.activity_id = a.id) as members
    from starter_plans s join activities a on a.id = s.activity_id
    where s.starts_at >= ${since}
    order by s.starts_at limit 300`;
}
