/**
 * Trip match alerts: when two real people will be in the same city (or within MATCH_RADIUS_KM) on overlapping dates, each is
 * told about the other once, by a DM from the Tablamigo Host (which pushes to their phone like any DM) and an email. This is
 * what the team did by hand on 31 Oct 2026 for the first paid user (Ubud, 13-18 Nov), for everyone.
 *
 * Who is matched (both sides, at discovery and again just before sending): a real traveller (lib/team-dm.ts realTraveller:
 * never the team account, a demo persona, a store review or admin account, a test address, a deleted or banned account), not
 * snoozed, not incognito, with trip match alerts on (Profile; off also hides them from everyone else's matches), nobody on
 * either side of a block, not already connected, not already talking in a DM, and no travel buddy request between them.
 *
 * What is said: the other person's first name, the overlap dates, up to 3 shared interests and a link to their profile. All
 * of that is on their public profile already (trips are on the public timeline; plan history, which hide_plan_history
 * hides, is never mentioned).
 *
 * Once: one match per pair per visit. A pair is only matched again when no earlier match of theirs is within SAME_VISIT_DAYS,
 * checked under a per-pair advisory lock, so deleting and re-adding a trip, trips in two neighbouring towns, a second process
 * or both people adding trips at the same moment never send a second introduction.
 *
 * Limits: at most config.tripMatchPerDay alerts per person per rolling 24 hours (the rest wait, Plus counterparts first, as
 * "Plus members get seen first" everywhere else), only in the person's daytime (9:00-21:00 in their trip's city), and a free
 * account is only told about people its own trip screen would show it: the first LIMITS.free.overlapPreview people of the
 * overlap list (lib/plus.ts), and at most that many per trip. Plus accounts are told about everyone. No new paywall.
 *
 * TRIP_MATCH (config.tripMatch): 'off' does nothing, 'dry' logs the pairs it would match (once per pair per process) and
 * writes nothing, 'on' matches and sends. Discovery runs for a trip as soon as it is added (routes/trips.ts) and over every
 * upcoming trip once an hour from the scheduler, which also sends what is due every minute.
 */
import { sql } from './db.js';
import { config, type Mode } from './config.js';
import { clock } from './clock.js';
import { LIMITS, isPlus, plusOf } from './plus.js';
import { getHost, type Host } from './host.js';
import { notify } from './push.js';
import { deliver } from './emails/send.js';
import { firstName, fmtRange } from './emails/templates.js';
import type { Email } from './emails/layout.js';
import { findContact } from './contact-shield.js';
import { localDate } from './local-time.js';
import { realTraveller, inDaytime, zoneFor, appLink, postAsTeam, alertsOffUrl } from './team-dm.js';
import { recordInApp, registerFallback } from './ladder.js';

export const MATCH_RADIUS_KM = 20;
/** Two matches of one pair closer than this are one visit. */
export const SAME_VISIT_DAYS = 14;
export const DELIVER_PER_TICK = 30;
export const SWEEP_EVERY_MS = 3600_000;

/** A person who can be matched, as the users row `alias`. */
export const matchable = (alias: string) => {
  const u = sql(alias);
  return sql`(${realTraveller(alias)} and (${u}.snoozed_until is null or ${u}.snoozed_until <= now())
    and not coalesce(${u}.is_incognito, false) and ${u}.trip_match_alerts)`;
};

/**
 * Everyone else in this city on overlapping dates, never deleted, banned, snoozed or blocked (either way) accounts, Plus first
 * ("Plus members get seen first"). GET /trips/:id/overlaps and the trip buddies list show these; a free account sees the first
 * LIMITS.free.overlapPreview of them.
 */
export function overlapping(uid: string, cityKey: string, startDate: string, endDate: string) {
  return sql`select * from (
      select distinct on (u.id) u.id, u.name, u.photo_url, u.home_country, u.interests,
        date_part('year', age(u.birthdate))::int as age, o.start_date, o.end_date,
        ${plusOf('u')} as plus
      from trips o join users u on u.id = o.user_id
      where o.city_key = ${cityKey} and o.user_id <> ${uid} and o.start_date <= ${endDate} and o.end_date >= ${startDate}
        and u.deleted_at is null and u.banned_at is null and (u.snoozed_until is null or u.snoozed_until <= now())
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
      order by u.id, o.start_date) x
    order by plus desc, start_date, id`;
}

// --- the text ------------------------------------------------------------------------------------
export type MatchText = {
  /** otherCity: the other person's town when it is a different one within MATCH_RADIUS_KM ("Tegallalang, near Ubud"). */
  name: string | null; hinglish: boolean; city: string; otherCity?: string | null; otherName: string | null; otherId: string;
  /** The recipient, for the one-tap "stop these alerts" link in the email. */
  userId?: string;
  overlapStart: string; overlapEnd: string; shared: string[];
};

/** The other person's first name, or a neutral stand-in when their name carries contact details. */
export const safeFirstName = (name: string | null) => { const f = firstName(name); return f === 'there' || findContact(f) ? null : f; };
const andList = (xs: string[], and: string) => xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} ${and} ${xs[xs.length - 1]}`;

/** The DM. Pure. */
export function renderMatchDm(d: MatchText): string {
  const other = safeFirstName(d.otherName), when = fmtRange(d.overlapStart, d.overlapEnd), link = appLink(`/user/${d.otherId}`);
  const where = d.otherCity ? (d.hinglish ? `${d.otherCity} (${d.city} ke paas)` : `${d.otherCity}, near ${d.city},`) : d.city;
  if (d.hinglish) {
    return [
      `Hi ${firstName(d.name)} 👋 Aapki ${d.city} trip ke liye good news: ${other ?? 'ek aur traveller'}${other ? ', Tablamigo pe ek aur traveller,' : ''} bhi ${when} ${where} mein hai.`
        + (d.shared.length ? ` Aap dono ko ${andList(d.shared, 'aur')} pasand hai.` : ''),
      `${other ? `${other} ka` : 'Unka'} profile dekho aur hi bolo: ${link}`,
      'Pehli baar hamesha public jagah pe milna. Trip match alerts nahi chahiye? Profile mein "Trip match alerts" band kar do.',
    ].join('\n\n');
  }
  return [
    `Hi ${firstName(d.name)} 👋 Good news for your ${d.city} trip: ${other ?? 'another traveller'}${other ? ', another traveller on Tablamigo,' : ' on Tablamigo'} will be in ${where} on ${when} too.`
      + (d.shared.length ? ` You both like ${andList(d.shared, 'and')}.` : ''),
    `See ${other ? `${other}'s` : 'their'} profile and say hi: ${link}`,
    'Always meet in a public place first. Don\'t want trip match alerts? Switch off "Trip match alerts" in Profile.',
  ].join('\n\n');
}

/** The email. Pure. */
export function tripMatchEmail(d: MatchText): Email {
  const other = safeFirstName(d.otherName), when = fmtRange(d.overlapStart, d.overlapEnd);
  const who = other ?? 'Another traveller';
  const where = d.otherCity ? `${d.otherCity}, near ${d.city}` : d.city;
  return {
    subject: `${who} is in ${d.city} on your dates`.slice(0, 70), category: 'activity',
    preheader: `${when}. See their profile and say hi.`,
    blocks: [
      { t: 'eyebrow', text: 'Trip match' },
      { t: 'h1', text: `${who} will be in ${d.city} too` },
      { t: 'p', text: `Hi ${firstName(d.name)}, ${other ?? 'another traveller on Tablamigo'} will be in ${where} on ${when}, the same days as you.`
        + (d.shared.length ? ` You both like ${andList(d.shared, 'and')}.` : '') },
      { t: 'button', label: other ? `See ${other}'s profile` : 'See their profile', url: appLink(`/user/${d.otherId}`) },
      { t: 'small', text: `Say hi in the app and meet in a busy public place first. [Stop trip match alerts](${alertsOffUrl(d.userId ?? '', 'trip_match')}) or switch them off in Profile.` },
    ],
  };
}

// --- discovery -----------------------------------------------------------------------------------
export type Candidate = { aUser: string; aTrip: string; bUser: string; bTrip: string; cityKey: string; overlapStart: string; overlapEnd: string };

/**
 * Pairs to introduce, from the trips `tripIds` (every upcoming trip when omitted). Each pair once, earliest overlap first.
 * Read-only.
 */
export async function findCandidates(o: { tripIds?: string[]; today: string }): Promise<Candidate[]> {
  const ids = o.tripIds ?? null;
  const rows = await sql`
    with t as (
      select t.id, t.user_id, t.city_key, coalesce(al.canonical_key, t.city_key) as k, t.location, t.start_date, t.end_date
      from trips t left join city_chat_aliases al on al.alias_key = t.city_key
      where t.end_date >= ${o.today}::date)
    select a.id as a_trip, a.user_id as a_user, b.id as b_trip, b.user_id as b_user, a.k as city_key,
      greatest(a.start_date, b.start_date)::text as overlap_start, least(a.end_date, b.end_date)::text as overlap_end
    from t a
    join t b on b.user_id <> a.user_id and b.start_date <= a.end_date and b.end_date >= a.start_date
      and (b.k = a.k or (a.location is not null and b.location is not null and st_dwithin(a.location, b.location, ${MATCH_RADIUS_KM * 1000})))
    join users ua on ua.id = a.user_id
    join users ub on ub.id = b.user_id
    where (${ids}::uuid[] is null or a.id = any(${ids}::uuid[]))
      and ${matchable('ua')} and ${matchable('ub')}
      and not exists (select 1 from blocks x where (x.blocker_id = ua.id and x.blocked_id = ub.id) or (x.blocker_id = ub.id and x.blocked_id = ua.id))
      and not exists (select 1 from connections x where (x.user_id = ua.id and x.friend_id = ub.id) or (x.user_id = ub.id and x.friend_id = ua.id))
      and not exists (select 1 from travel_buddy_requests x where (x.sender_id = ua.id and x.recipient_id = ub.id) or (x.sender_id = ub.id and x.recipient_id = ua.id))
      and not exists (select 1 from chats c join chat_members x on x.chat_id = c.id and x.user_id = ua.id
          join chat_members y on y.chat_id = c.id and y.user_id = ub.id
        where c.kind = 'dm' and exists (select 1 from messages m where m.chat_id = c.id))
      and not exists (select 1 from trip_matches tm where tm.user_lo = least(ua.id, ub.id) and tm.user_hi = greatest(ua.id, ub.id)
        and tm.overlap_start <= least(a.end_date, b.end_date) + ${SAME_VISIT_DAYS}::int
        and tm.overlap_end >= greatest(a.start_date, b.start_date) - ${SAME_VISIT_DAYS}::int)
    order by greatest(a.start_date, b.start_date), a.id, b.id
    limit 5000`;
  const seen = new Set<string>(), out: Candidate[] = [];
  for (const r of rows) {
    const key = [r.aUser, r.bUser].sort().join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ aUser: r.aUser, aTrip: r.aTrip, bUser: r.bUser, bTrip: r.bTrip, cityKey: r.cityKey, overlapStart: r.overlapStart, overlapEnd: r.overlapEnd });
  }
  return out;
}

/** Records the match and one pending notice per side, unless the pair already has a match within SAME_VISIT_DAYS. */
export async function claimMatch(c: Candidate): Promise<string | null> {
  const [lo, hi] = [c.aUser, c.bUser].sort();
  const [loTrip, hiTrip] = lo === c.aUser ? [c.aTrip, c.bTrip] : [c.bTrip, c.aTrip];
  return sql.begin(async tx => {
    await tx`select pg_advisory_xact_lock(hashtextextended(${'trip-match:' + lo + ':' + hi}, 0))`;
    const [dup] = await tx`select 1 from trip_matches where user_lo = ${lo} and user_hi = ${hi}
      and overlap_start <= ${c.overlapEnd}::date + ${SAME_VISIT_DAYS}::int and overlap_end >= ${c.overlapStart}::date - ${SAME_VISIT_DAYS}::int`;
    if (dup) return null;
    const [m] = await tx`insert into trip_matches (user_lo, user_hi, trip_lo, trip_hi, city_key, overlap_start, overlap_end)
      values (${lo}, ${hi}, ${loTrip}, ${hiTrip}, ${c.cityKey}, ${c.overlapStart}, ${c.overlapEnd}) returning id`;
    await tx`insert into trip_match_notices (match_id, user_id, other_id, trip_id)
      values (${m.id}, ${lo}, ${hi}, ${loTrip}), (${m.id}, ${hi}, ${lo}, ${hiTrip})`;
    return m.id as string;
  });
}

const dryLogged = new Set<string>();

/** Finds and records new matches. In 'dry' mode only logs them (once per pair per process). Returns how many were new. */
export async function discover(now: Date, o: { mode: Mode; tripIds?: string[]; dryLog?: Set<string> }): Promise<number> {
  if (o.mode === 'off') return 0;
  // The earliest "today" anywhere on Earth (UTC-12), so a trip that ends today in its own city still counts.
  const today = new Date(now.getTime() - 12 * 3600_000).toISOString().slice(0, 10);
  const found = await findCandidates({ tripIds: o.tripIds, today });
  let n = 0;
  for (const c of found) {
    if (o.mode === 'dry') {
      const key = [c.aUser, c.bUser].sort().join(':'), logged = o.dryLog ?? dryLogged;
      if (logged.has(key)) continue;
      logged.add(key);
      console.log(`trip match (dry): ${key} city=${c.cityKey} overlap=${c.overlapStart}..${c.overlapEnd}`);
      n++;
      continue;
    }
    if (await claimMatch(c)) n++;
  }
  return n;
}

// --- delivery ------------------------------------------------------------------------------------
type Due = { matchId: string; userId: string; otherId: string; tripId: string | null; otherTripId: string | null; overlapStart: string; overlapEnd: string };

/** The facts one notice needs, re-read now: both people still matchable and unblocked, both trips still there and overlapping. */
async function facts(n: Due) {
  const [r] = await sql`
    select u.name, u.home_country, u.interests, ${matchable('u')} as u_ok,
      o.name as other_name, o.interests as other_interests, ${matchable('o')} as o_ok,
      exists (select 1 from blocks x where (x.blocker_id = u.id and x.blocked_id = o.id) or (x.blocker_id = o.id and x.blocked_id = u.id)) as blocked,
      t.city, t.city_key, t.start_date::text as start_date, t.end_date::text as end_date,
      st_y(t.location::geometry) as lat, st_x(t.location::geometry) as lng,
      ot.id as other_trip, ot.city as other_city
    from users u join users o on o.id = ${n.otherId}
      left join trips t on t.id = ${n.tripId}::uuid and t.user_id = u.id
      left join trips ot on ot.id = ${n.otherTripId}::uuid and ot.user_id = o.id
        and ot.start_date <= t.end_date and ot.end_date >= t.start_date
    where u.id = ${n.userId}`;
  return r;
}

export type DeliverTally = { sent: number; skipped: number; failed: number; waiting: number };

/**
 * Sends what is due. A notice waits (stays pending) outside the person's daytime and while they are at their daily cap; it is
 * skipped for good when either person stopped being matchable, a block, a trip gone or over, or the free preview.
 */
export async function deliverDue(now: Date, o: { host?: Host | null; limit?: number; userIds?: string[] } = {}): Promise<DeliverTally> {
  const t: DeliverTally = { sent: 0, skipped: 0, failed: 0, waiting: 0 };
  const host = o.host ?? await getHost();
  const ids = o.userIds ?? null;
  const due = await sql`select n.match_id, n.user_id, n.other_id, n.trip_id,
      case when n.user_id = m.user_lo then m.trip_hi else m.trip_lo end as other_trip_id,
      m.overlap_start::text as overlap_start, m.overlap_end::text as overlap_end
    from trip_match_notices n join trip_matches m on m.id = n.match_id join users o on o.id = n.other_id
    where n.status = 'pending' and (n.next_try_at is null or n.next_try_at <= ${now})
      and (${ids}::uuid[] is null or n.user_id = any(${ids}::uuid[]))
    order by ${plusOf('o')} desc, m.overlap_start, n.created_at
    limit ${o.limit ?? DELIVER_PER_TICK}` as unknown as Due[];
  const skip = async (n: Due, reason: string) => {
    await sql`update trip_match_notices set status = 'skipped', reason = ${reason} where match_id = ${n.matchId} and user_id = ${n.userId} and status = 'pending'`;
    t.skipped++;
  };
  // A notice that has to wait (night, daily cap) is not looked at again before next_try_at, so it never fills the page.
  const later = async (n: Due, until: Date) => {
    await sql`update trip_match_notices set next_try_at = ${until} where match_id = ${n.matchId} and user_id = ${n.userId} and status = 'pending'`;
    t.waiting++;
  };
  for (const n of due) {
    try { await one(n); } catch (e) {
      // One bad row never blocks the rest: it is marked failed and the loop goes on.
      const err = String((e as Error)?.message ?? e).slice(0, 300);
      await sql`update trip_match_notices set status = 'failed', reason = ${err} where match_id = ${n.matchId} and user_id = ${n.userId} and status in ('pending', 'sending')`.catch(() => {});
      console.error('trip match failed', n.userId, err);
      t.failed++;
    }
  }
  return t;

  async function one(n: Due) {
    const f = await facts(n);
    if (!f || !f.uOk) { await skip(n, 'not_matchable'); return; }
    if (!f.oOk) { await skip(n, 'other_not_matchable'); return; }
    if (f.blocked) { await skip(n, 'blocked'); return; }
    if (!f.city) { await skip(n, 'trip_gone'); return; }
    if (!f.otherTrip) { await skip(n, 'other_trip_gone'); return; }
    if (f.endDate < localDate(now, zoneFor({ lat: f.lat, lng: f.lng, homeCountry: f.homeCountry, cityKey: f.cityKey }))) { await skip(n, 'trip_over'); return; }
    if (!host) { await later(n, new Date(now.getTime() + 30 * 60_000)); return; }
    const zone = zoneFor({ lat: f.lat, lng: f.lng, homeCountry: f.homeCountry, cityKey: f.cityKey });
    if (!inDaytime(now, zone)) { await later(n, new Date(now.getTime() + 30 * 60_000)); return; }

    // A free account is only told about people its own trip screen shows it (lib/plus.ts overlapPreview).
    const plus = await isPlus(n.userId);
    if (!plus) {
      const list = await overlapping(n.userId, f.cityKey, f.startDate, f.endDate);
      const at = list.findIndex(x => x.id === n.otherId);
      // Not on the list at all (a neighbouring town within MATCH_RADIUS_KM, or another spelling of the city): nothing is
      // paywalled there, so it is allowed, and the per-trip cap below still holds.
      if (at >= LIMITS.free.overlapPreview) { await skip(n, 'free_preview_locked'); return; }
    }
    // The claim: under a per-person lock, so the daily cap and the free per-trip cap hold against concurrent senders.
    const claimed = await sql.begin(async tx => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'trip-match-user:' + n.userId}, 0))`;
      const [{ today }] = await tx`select count(*)::int as today from trip_match_notices
        where user_id = ${n.userId} and status in ('sending', 'sent') and sent_at > ${now}::timestamptz - interval '24 hours'`;
      if (today >= config.tripMatchPerDay) return 'cap';
      if (!plus) {
        const [{ trip }] = await tx`select count(*)::int as trip from trip_match_notices
          where user_id = ${n.userId} and trip_id = ${n.tripId} and status in ('sending', 'sent')`;
        if (trip >= LIMITS.free.overlapPreview) {
          await tx`update trip_match_notices set status = 'skipped', reason = 'free_preview_full' where match_id = ${n.matchId} and user_id = ${n.userId} and status = 'pending'`;
          return 'full';
        }
      }
      const [c] = await tx`update trip_match_notices set status = 'sending', sent_at = ${now}
        where match_id = ${n.matchId} and user_id = ${n.userId} and status = 'pending' returning 1`;
      return c ? 'ok' : 'gone';
    });
    if (claimed === 'cap') {
      const [{ free }] = await sql`select min(sent_at) + interval '24 hours' as free from trip_match_notices
        where user_id = ${n.userId} and status in ('sending', 'sent') and sent_at > ${now}::timestamptz - interval '24 hours'`;
      await later(n, free ? new Date(free) : new Date(now.getTime() + 3600_000));
      return;
    }
    if (claimed === 'full') { t.skipped++; return; }
    if (claimed !== 'ok') return;

    const shared = (f.interests ?? []).filter((i: string) => (f.otherInterests ?? []).includes(i) && !findContact(i)).slice(0, 3);
    const text: MatchText = { userId: n.userId, name: f.name, hinglish: f.homeCountry === 'IN', city: f.city, otherCity: f.otherCity && f.otherCity !== f.city ? f.otherCity : null, otherName: f.otherName, otherId: n.otherId,
      overlapStart: n.overlapStart, overlapEnd: n.overlapEnd, shared };
    try {
      const dm = await postAsTeam(host, n.userId, renderMatchDm(text));
      if (dm.status === 'sent') {
        // In-app and push now; the email only if the DM is still unread after FALLBACK_WAIT_MIN.trip_match (lib/ladder.ts).
        await recordInApp(n.userId, 'trip_match', n.matchId, { chatId: dm.chatId, messageId: dm.messageId, payload: text });
      } else {
        // Declined the Host's DMs: no message. The alert itself still goes, to their phone and their inbox.
        const who = safeFirstName(f.otherName);
        void notify([n.userId], { title: `${who ?? 'Someone'} is in ${f.city} on your dates`, body: 'Tap to see their profile and say hi.', data: { userId: n.otherId, nkind: 'trip_match', nref: n.matchId }, tag: `trip-match-${n.matchId}` });
        await deliver({ kind: 'trip_match', userId: n.userId, periodKey: n.matchId, ref: n.matchId, build: u => tripMatchEmail({ ...text, name: u.name }) });
      }
      await sql`update trip_match_notices set status = 'sent', chat_id = ${dm.chatId}, message_id = ${dm.status === 'sent' ? dm.messageId : null},
        reason = ${dm.status === 'declined' ? 'dm_declined' : null} where match_id = ${n.matchId} and user_id = ${n.userId}`;
      console.log(`trip match: told user=${n.userId} about=${n.otherId} match=${n.matchId} city=${f.cityKey}`);
      t.sent++;
    } catch (e) {
      const err = String((e as Error)?.message ?? e).slice(0, 300);
      await sql`update trip_match_notices set status = 'failed', reason = ${err} where match_id = ${n.matchId} and user_id = ${n.userId}`.catch(() => {});
      console.error('trip match failed', n.userId, err);
      t.failed++;
    }
  }
}

// --- entry points --------------------------------------------------------------------------------
const sweep = { at: 0 };
export type TripMatchTally = { mode: Mode; matched: number } & DeliverTally;

/** The scheduler's pass: every upcoming trip once an hour (or when `force`), then whatever is due. */
export async function processTripMatches(now: Date = clock.now(), o: { mode?: Mode; force?: boolean; state?: { at: number }; dryLog?: Set<string> } = {}): Promise<TripMatchTally> {
  const mode = o.mode ?? config.tripMatch;
  const empty = { mode, matched: 0, sent: 0, skipped: 0, failed: 0, waiting: 0 };
  if (mode === 'off') return empty;
  const state = o.state ?? sweep;
  let matched = 0;
  if (o.force || now.getTime() - state.at >= SWEEP_EVERY_MS) {
    matched = await discover(now, { mode, dryLog: o.dryLog });
    state.at = now.getTime();
  }
  if (mode === 'dry') return { ...empty, matched };
  return { mode, matched, ...(await deliverDue(now)) };
}

/** A trip was just added: match it now and tell whoever is due. Never throws (runs after the response). */
export async function onTripAdded(tripId: string, userId: string, now: Date = clock.now(), mode: Mode = config.tripMatch) {
  if (mode === 'off') return;
  try {
    await discover(now, { mode, tripIds: [tripId] });
    if (mode !== 'on') return;
    const others = await sql`select case when user_lo = ${userId} then user_hi else user_lo end as id from trip_matches
      where (trip_lo = ${tripId} or trip_hi = ${tripId})`;
    await deliverDue(now, { userIds: [userId, ...others.map(r => r.id as string)] });
  } catch (e) { console.error('trip match on add failed', tripId, (e as Error)?.message); }
}

// The email the ladder sends when the DM went unread: only while both people can still be matched and nothing blocks them.
registerFallback('trip_match', {
  email: (p: MatchText, u) => tripMatchEmail({ ...p, name: u.name }),
  short: (p: MatchText) => ({ title: `${safeFirstName(p.otherName) ?? 'Another traveller'} is in ${p.otherCity ?? p.city} on your dates`,
    body: `${fmtRange(p.overlapStart, p.overlapEnd)}. See their profile and say hi.`, url: appLink(`/user/${p.otherId}`) }),
  stillValid: async (userId, p: MatchText) => {
    const [r] = await sql`select ${matchable('u')} and ${matchable('o')}
        and not exists (select 1 from blocks x where (x.blocker_id = u.id and x.blocked_id = o.id) or (x.blocker_id = o.id and x.blocked_id = u.id)) as ok
      from users u, users o where u.id = ${userId} and o.id = ${p.otherId}`;
    return !!r?.ok;
  },
});
