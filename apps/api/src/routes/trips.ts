import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { limitsFor, plusOf } from '../lib/plus.js';
import { cityKey, cityFor, legacyCityKey } from '../lib/geo.js';
import { joinUserToChat, emitToChat, dropNonListeners, leaveUsersFromChat } from '../lib/realtime.js';
import { bad, notFound, needsPlus, forbidden } from '../lib/errors.js';
import { assertClean } from '../lib/moderation.js';
import { addNotice } from '../lib/inbox.js';
import { assertNoContactsTo } from '../lib/chat-gate.js';
import { cityChatId } from '../lib/city-chats.js';
import { curatedCityNear } from '../lib/curated-cities.js';
import { overlapping, onTripAdded } from '../lib/trip-match.js';

/**
 * The point the app (up to 1.3) put in place of a location it didn't have: central Bangkok. It reaches the API from people who
 * are nowhere near Bangkok, so it is never taken as where someone is. Exported for the test.
 */
export const LEGACY_NO_FIX_POINT = { lat: 13.7466, lng: 100.5346 };
export const isLegacyNoFixPoint = (lat: number, lng: number) =>
  Math.abs(lat - LEGACY_NO_FIX_POINT.lat) < 1e-6 && Math.abs(lng - LEGACY_NO_FIX_POINT.lng) < 1e-6;

/**
 * The day a trip's city chat opens to someone whose plan lets them in `daysAhead` days before arrival (free: 3, Plus: 365), or
 * null when it is open to them now. GET /trips carries it, so the trip screen says when the chat opens before anyone taps,
 * instead of the tap answering 402 and opening the paywall (it did for every new trip a free account added a week out).
 */
export function cityChatOpensOn(startDate: string, daysAhead: number, now = Date.now()): string | null {
  const start = new Date(startDate).getTime();
  if ((start - now) / 86400_000 <= daysAhead) return null;
  return new Date(start - daysAhead * 86400_000).toISOString().slice(0, 10);
}

/** Free accounts see the first `overlapPreview` people of a list (the rest is Plus), plus how many are hidden. */
async function previewFor<T>(uid: string, rows: T[]) {
  const lim = await limitsFor(uid);
  const shown = lim.overlapPreview === Infinity ? rows.length : Math.min(rows.length, lim.overlapPreview);
  return { total: rows.length, locked: rows.length > shown, hiddenCount: rows.length - shown, shown: rows.slice(0, shown) };
}

/** The trip circle chat for one of the caller's trips (same city, same month), and whether they're in it. */
async function circleOf(uid: string, tripId: string) {
  const [t] = await sql`select city_key, start_date, end_date from trips where id = ${tripId} and user_id = ${uid}`;
  if (!t) return null;
  const d = new Date(t.startDate);
  const key = `${t.cityKey}:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const [c] = await sql`select c.id, exists(select 1 from chat_members cm where cm.chat_id = c.id and cm.user_id = ${uid}) as is_member
    from chats c where c.trip_key = ${key}`;
  return c ? { chatId: c.id as string, isMember: !!c.isMember } : null;
}

/** Free: the first `overlapPreview` people plus how many more a Trip Pass or Plus would show. */
async function overlapView(uid: string, cityKey: string, startDate: string, endDate: string) {
  const rows = await overlapping(uid, cityKey, startDate, endDate);
  const lim = await limitsFor(uid);
  const shown = lim.overlapPreview === Infinity ? rows.length : Math.min(rows.length, lim.overlapPreview);
  return { total: rows.length, locked: rows.length > shown, hiddenCount: rows.length - shown, travelers: rows.slice(0, shown) };
}

export default async function trips(app: FastifyInstance) {
  app.get('/trips', async req => {
    const uid = await requireUser(req);
    // Same people as /trips/:id/overlaps: never deleted, banned, snoozed or blocked (either way) accounts.
    const others = sql`from trips o join users u on u.id = o.user_id
      where o.city_key = t.city_key and o.user_id <> ${uid} and o.start_date <= t.end_date and o.end_date >= t.start_date
        and u.deleted_at is null and u.banned_at is null and (u.snoozed_until is null or u.snoozed_until <= now())
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))`;
    const rows = await sql`
      select t.id, t.city, t.country_code, t.city_key, t.start_date, t.end_date,
        (select count(distinct u.id)::int ${others}) as overlap_count,
        (select coalesce(json_agg(x), '[]') from (select distinct on (u.id) u.id, u.photo_url as "photoUrl", u.name ${others} limit 5) x) as overlap_faces
      from trips t where t.user_id = ${uid} and t.end_date >= current_date order by t.start_date`;
    const lim = await limitsFor(uid);
    return { trips: rows.map(t => ({ ...t, cityChatOpensOn: cityChatOpensOn(t.startDate, lim.cityChatDaysAhead) })) };
  });

  app.post('/trips', async req => {
    const uid = await requireUser(req);
    const b = z.object({
      city: z.string().trim().min(2).max(80), countryCode: z.string().length(2).toUpperCase(),
      lat: z.number().optional(), lng: z.number().optional(),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    }).parse(req.body);
    if (b.endDate < b.startDate) throw bad('bad_dates');
    const [{ n }] = await sql`select count(*)::int as n from trips where user_id = ${uid} and end_date >= current_date`;
    if (n >= 12) throw bad('too_many_trips');
    const key = cityKey(b.city, b.countryCode);
    const [t] = await sql`insert into trips (user_id, city, country_code, city_key, location, start_date, end_date)
      values (${uid}, ${b.city}, ${b.countryCode}, ${key},
        ${b.lat != null && b.lng != null ? sql`ST_SetSRID(ST_MakePoint(${b.lng}, ${b.lat}), 4326)::geography` : null},
        ${b.startDate}, ${b.endDate}) returning id, city, country_code, city_key, start_date, end_date`;
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${uid}, 'trip_created', ${sql.json({ tripId: t.id, cityKey: t.cityKey } as any)})`.catch(() => {});
    // The moment of intent: how many people will be there, and how many a free account can't see yet.
    const v = await overlapView(uid, key, b.startDate, b.endDate);
    // Trip match alerts (lib/trip-match.ts): after the response, never in its way.
    void onTripAdded(t.id, uid);
    return { ...t, overlapCount: v.total, hiddenCount: v.hiddenCount };
  });

  app.delete('/trips/:id', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await sql`delete from trips where id = ${id} and user_id = ${uid}`;
    return { ok: true };
  });

  // Busiest cities over the next 60 days. Hidden people (deleted, banned, snoozed) aren't counted or shown.
  app.get('/trips/trending', async req => {
    const uid = await requireUser(req);
    const visible = sql`u.deleted_at is null and u.banned_at is null and (u.snoozed_until is null or u.snoozed_until <= now())`;
    const rows = await sql`select min(t.city) as city, min(t.country_code) as country_code, t.city_key, count(distinct t.user_id)::int as travelers,
        greatest(min(t.start_date), current_date) as first_date, max(t.end_date) as last_date,
        (select coalesce(json_agg(f), '[]') from (select u.id, u.photo_url as "photoUrl", u.name from users u
           where u.id in (select o.user_id from trips o where o.city_key = t.city_key and o.end_date >= current_date and o.start_date <= current_date + 60)
             and u.id <> ${uid} and ${visible}
             and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
           order by u.photo_url is null, u.last_seen_at desc limit 3) f) as faces
      from trips t join users u on u.id = t.user_id
      where t.end_date >= current_date and t.start_date <= current_date + 60 and ${visible}
        -- Only cities with a guide: a card opens /city/<cityKey>, and GET /cities/:slug resolves curated guides only,
        -- so an unguided city was a 'City guide not found' dead end (5 of 9 cards on 18 Oct). Same match as guideFor().
        and exists (select 1 from city_guides cg where cg.chat_key = t.city_key or cg.slug = t.city_key
                     or cg.slug = split_part(t.city_key, '-', 1))
      group by t.city_key order by travelers desc, t.city_key limit 12`;
    return { cities: rows };
  });

  // Who else is in this city on your dates. Free: count + a preview; Plus: everyone.
  app.get('/trips/:id/overlaps', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [t] = await sql`select city_key, start_date, end_date from trips where id = ${id} and user_id = ${uid}`;
    if (!t) throw notFound();
    return overlapView(uid, t.cityKey, t.startDate, t.endDate);
  });

  // City chat: open to people in the city now or arriving within the free window.
  app.post('/trips/:id/city-chat', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({ womenOnly: z.boolean().optional() }).optional().parse(req.body ?? {});
    const [t] = await sql`select city, country_code, city_key, start_date from trips where id = ${id} and user_id = ${uid}`;
    if (!t) throw notFound();
    const lim = await limitsFor(uid);
    if (cityChatOpensOn(t.startDate, lim.cityChatDaysAhead)) throw needsPlus('city_chat_early');
    return joinCityChat(uid, t.city, t.cityKey, !!body?.womenOnly, legacyCityKey(t.city, t.countryCode));
  });

  // Trip Overlap Circle Chat: group chat with travelers visiting the city in the same month
  app.get('/trips/:id/group-chat', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [t] = await sql`select city, country_code, city_key, start_date, end_date from trips where id = ${id} and user_id = ${uid}`;
    if (!t) throw notFound();

    const d = new Date(t.startDate);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const monthName = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
    const key = `${t.cityKey}:${ym}`;
    const title = `${t.city} · ${monthName} ${d.getUTCFullYear()} Circle ✈️`;

    const [c] = await sql`
      select c.id, c.topic, c.topic_updated_at as "topicUpdatedAt",
        (select u.name from users u where u.id = c.topic_updated_by) as "topicAuthor"
      from chats c where c.trip_key = ${key}
    `;
    if (!c) {
      return { chatId: null, title, memberCount: 0, isMember: false, members: [], topic: null, topicUpdatedAt: null, topicAuthor: null, proposalsCount: 0 };
    }

    const [{ isMember }] = await sql`select exists(select 1 from chat_members where chat_id = ${c.id} and user_id = ${uid}) as "isMember"`;
    const [{ proposalsCount }] = await sql`select count(*)::int as "proposalsCount" from trip_circle_proposals where chat_id = ${c.id}`;
    // The faces and the count follow the same rules as the member directory and the overlap list: never anyone snoozed or on
    // either side of a block with the viewer, and a free account sees the preview (3 people), not 6.
    const visible = sql`u.deleted_at is null and u.banned_at is null
      and (u.id = ${uid} or u.snoozed_until is null or u.snoozed_until <= now())
      and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))`;
    const faces = Math.min(6, (await limitsFor(uid)).overlapPreview);
    const [{ count }] = await sql`select count(*)::int as count from chat_members cm join users u on u.id = cm.user_id where cm.chat_id = ${c.id} and ${visible}`;
    const members = await sql`
      select u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry"
      from chat_members cm
      join users u on u.id = cm.user_id
      where cm.chat_id = ${c.id} and ${visible}
      order by cm.joined_at desc
      limit ${faces}
    `;
    return {
      chatId: c.id,
      title,
      memberCount: count,
      isMember,
      members,
      topic: c.topic ?? null,
      topicUpdatedAt: c.topicUpdatedAt ?? null,
      topicAuthor: c.topicAuthor ?? null,
      proposalsCount
    };
  });

  // Feature 18: Full directory of travelers in this trip circle with dates & travel style
  app.get('/trips/:id/circle-directory', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [myTrip] = await sql`select city, country_code, city_key, start_date, end_date from trips where id = ${id} and user_id = ${uid}`;
    if (!myTrip) throw notFound('Trip not found');

    const d = new Date(myTrip.startDate);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = `${myTrip.cityKey}:${ym}`;

    const [c] = await sql`select id, title, topic from chats where trip_key = ${key}`;
    if (!c) throw notFound('Circle chat not found');

    const [{ isMember }] = await sql`select exists(select 1 from chat_members where chat_id = ${c.id} and user_id = ${uid}) as "isMember"`;
    if (!isMember) throw forbidden('not_a_member', 'Join this circle to view the member directory');

    const members = await sql`
      select u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        u.travel_style as "travelStyle", u.verified, (${plusOf('u')}) as "isPlus",
        t.start_date as "startDate", t.end_date as "endDate",
        cm.joined_at as "joinedCircleAt"
      from chat_members cm
      join users u on u.id = cm.user_id
      left join lateral (
        select start_date, end_date from trips tr
        where tr.user_id = u.id and tr.city_key = ${myTrip.cityKey}
          and tr.start_date <= ${myTrip.endDate} and tr.end_date >= ${myTrip.startDate}
        order by tr.start_date asc limit 1
      ) t on true
      where cm.chat_id = ${c.id} and u.deleted_at is null and u.banned_at is null
        -- Same people as the overlap list: never anyone snoozed or on either side of a block with the viewer.
        and (u.id = ${uid} or u.snoozed_until is null or u.snoozed_until <= now())
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
      order by (u.id = ${uid}) desc, cm.joined_at asc
      limit 100
    `;
    // Free accounts get the same preview as the overlap list (themselves first, then the earliest members).
    const v = await previewFor(uid, members);

    return {
      circleTitle: c.title,
      topic: c.topic,
      totalMembers: v.total,
      locked: v.locked,
      hiddenCount: v.hiddenCount,
      members: v.shown
    };
  });

  // Feature 18: Set or update the trip circle discussion topic
  app.put('/trips/:id/circle-topic', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { topic } = z.object({ topic: z.string().trim().min(3).max(280) }).parse(req.body);

    const [myTrip] = await sql`select city, country_code, city_key, start_date from trips where id = ${id} and user_id = ${uid}`;
    if (!myTrip) throw notFound('Trip not found');

    const d = new Date(myTrip.startDate);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = `${myTrip.cityKey}:${ym}`;

    const [c] = await sql`select id, title from chats where trip_key = ${key}`;
    if (!c) throw notFound('Circle chat not found');

    const [{ isMember }] = await sql`select exists(select 1 from chat_members where chat_id = ${c.id} and user_id = ${uid}) as "isMember"`;
    if (!isMember) throw forbidden('not_a_member', 'Join this circle to set a discussion topic');

    await sql`
      update chats set
        topic = ${topic},
        topic_updated_at = now(),
        topic_updated_by = ${uid},
        last_message_at = now()
      where id = ${c.id}
    `;

    const [u] = await sql`select name from users where id = ${uid}`;
    const [msg] = await sql`
      insert into messages (chat_id, kind, body)
      values (${c.id}, 'system', ${`🎯 ${u?.name || 'A traveler'} set the circle topic: "${topic}"`})
      returning id, chat_id, kind, body, created_at, sender_id
    `;
    emitToChat(c.id, 'message:new', msg);

    return { ok: true, topic, updatedAt: new Date().toISOString(), updatedBy: u?.name };
  });

  // Feature 18: Get all proposed meetup ideas for this trip circle
  app.get('/trips/:id/circle-proposals', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [myTrip] = await sql`select city, country_code, city_key, start_date from trips where id = ${id} and user_id = ${uid}`;
    if (!myTrip) throw notFound('Trip not found');

    const d = new Date(myTrip.startDate);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = `${myTrip.cityKey}:${ym}`;

    const [c] = await sql`select id from chats where trip_key = ${key}`;
    if (!c) return { proposals: [] };

    const rows = await sql`
      select p.id, p.chat_id as "chatId", p.title, p.category, p.proposed_date as "proposedDate",
        p.created_at as "createdAt",
        json_build_object('id', u.id, 'name', u.name, 'photoUrl', u.photo_url) as proposer,
        cardinality(p.votes)::int as "voteCount",
        (${uid}::uuid = any(p.votes)) as "hasVoted"
      from trip_circle_proposals p
      join users u on u.id = p.proposer_id
      where p.chat_id = ${c.id}
      order by cardinality(p.votes) desc, p.created_at desc
      limit 50
    `;
    return { proposals: rows };
  });

  // Feature 18: Pitch a new meetup idea to the trip circle
  app.post('/trips/:id/circle-proposals', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const schema = z.object({
      title: z.string().trim().min(3).max(120),
      category: z.enum(['drinks','food','outdoors','culture','nightlife','coworking','sports']),
      proposedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
    });
    const body = schema.parse(req.body);

    const [myTrip] = await sql`select city, country_code, city_key, start_date from trips where id = ${id} and user_id = ${uid}`;
    if (!myTrip) throw notFound('Trip not found');

    const d = new Date(myTrip.startDate);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = `${myTrip.cityKey}:${ym}`;

    let [c] = await sql`select id, title from chats where trip_key = ${key}`;
    if (!c) {
      const circleTitle = `${myTrip.city} · ${d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })} ${d.getUTCFullYear()} Circle ✈️`;
      [c] = await sql`insert into chats (kind, trip_key, title, last_message_at)
        values ('trip', ${key}, ${circleTitle}, now())
        on conflict (trip_key) do update set title = excluded.title returning id, title`;
    }

    // Auto join user to circle if not member
    await sql`insert into chat_members (chat_id, user_id) values (${c.id}, ${uid}) on conflict do nothing`;

    const [proposal] = await sql`
      insert into trip_circle_proposals (chat_id, proposer_id, title, category, proposed_date, votes)
      values (${c.id}, ${uid}, ${body.title}, ${body.category}, ${body.proposedDate}, array[${uid}]::uuid[])
      returning id, chat_id as "chatId", title, category, proposed_date as "proposedDate", created_at as "createdAt"
    `;

    const [u] = await sql`select name from users where id = ${uid}`;
    const [msg] = await sql`
      insert into messages (chat_id, kind, body)
      values (${c.id}, 'system', ${`💡 ${u?.name || 'A traveler'} proposed a meetup idea: "${body.title}" on ${body.proposedDate}`})
      returning id, chat_id, kind, body, created_at, sender_id
    `;
    await sql`update chats set last_message_at = now() where id = ${c.id}`;
    emitToChat(c.id, 'message:new', msg);

    return { ok: true, proposal: { ...proposal, voteCount: 1, hasVoted: true } };
  });

  // Feature 18: Vote / unvote on a meetup proposal in the circle. Only members of that circle can vote, and the toggle
  // is one statement, so two taps at once can't add the same vote twice.
  app.post('/trips/:id/circle-proposals/:proposalId/vote', async req => {
    const uid = await requireUser(req);
    const { id, proposalId } = z.object({ id: z.string().uuid(), proposalId: z.string().uuid() }).parse(req.params);
    const circle = await circleOf(uid, id);
    if (!circle) throw notFound('Trip not found');
    if (!circle.isMember) throw forbidden('not_a_member', 'Join this circle to vote');

    const [updated] = await sql`
      update trip_circle_proposals
      set votes = case when ${uid}::uuid = any(votes) then array_remove(votes, ${uid}::uuid) else array_append(votes, ${uid}::uuid) end
      where id = ${proposalId} and chat_id = ${circle.chatId}
      returning ${uid}::uuid = any(votes) as has_voted, cardinality(votes)::int as vote_count`;
    if (!updated) throw notFound('Proposal not found');

    return {
      ok: true,
      hasVoted: !!updated.hasVoted,
      voteCount: updated.voteCount
    };
  });

  app.post('/trips/:id/group-chat', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return joinTripChat(uid, id);
  });

  app.delete('/trips/:id/group-chat', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [t] = await sql`select city, country_code, city_key, start_date from trips where id = ${id} and user_id = ${uid}`;
    if (!t) throw notFound();

    const d = new Date(t.startDate);
    const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const key = `${t.cityKey}:${ym}`;
    const [c] = await sql`select id, title from chats where trip_key = ${key}`;
    if (!c) return { ok: true, left: false };

    const [deleted] = await sql`delete from chat_members where chat_id = ${c.id} and user_id = ${uid} returning user_id`;
    leaveUsersFromChat([uid], c.id);
    if (deleted) {
      const [u] = await sql`select name from users where id = ${uid}`;
      const [msg] = await sql`insert into messages (chat_id, kind, body)
        values (${c.id}, 'system', ${`${u?.name || 'A traveler'} left the circle.`})
        returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${c.id}`;
      emitToChat(c.id, 'message:new', msg);
    }
    return { ok: true, left: !!deleted };
  });

  // The city chat for wherever you are right now: no Plus gate, you're already there. Without a point in the body the place
  // the server last saw you (users.location) is used. Apps up to 1.3 sent a fixed Bangkok point when they had no location
  // (LEGACY_NO_FIX_POINT), which put people in Istanbul or Casablanca into the Bangkok chat: that point counts as no point.
  app.post('/chats/city-here', async req => {
    const uid = await requireUser(req);
    const b = z.object({
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      womenOnly: z.boolean().optional()
    }).parse(req.body ?? {});
    const sent = b.lat != null && b.lng != null && !isLegacyNoFixPoint(b.lat, b.lng) ? { lat: b.lat, lng: b.lng } : null;
    const [saved] = sent ? [] : await sql`select ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng from users where id = ${uid} and location is not null`;
    const at = sent ?? (saved ? { lat: Number(saved.lat), lng: Number(saved.lng) } : null);
    if (!at) throw bad('city_unknown');
    const { lat, lng } = at, womenOnly = b.womenOnly;
    const { city, country } = await cityFor(lat, lng);
    // Within reach of a popular city's chat: that one, whatever district Nominatim names ('Üsküdar' is Istanbul).
    const snap = country ? curatedCityNear(lat, lng, country) : null;
    if (snap) return { ...(await joinCityChat(uid, snap.city, snap.key, !!womenOnly)), city: snap.city };
    if (!city || !country) throw bad('city_unknown');
    return { ...(await joinCityChat(uid, city, cityKey(city, country), !!womenOnly, legacyCityKey(city, country))), city };
  });

  // Travel Buddy Matching: score travelers with overlapping trips and compatible travel styles
  app.get('/travelers/buddies', async req => {
    const uid = await requireUser(req);
    const [me] = await sql`select travel_style as "travelStyle", interests from users where id = ${uid}`;
    const myStyles: string[] = me?.travelStyle ?? [];
    const myInterests: string[] = me?.interests ?? [];

    const rows = await sql`
      select distinct on (u.id)
        u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        date_part('year', age(u.birthdate))::int as age, u.verified,
        ${plusOf('u')} as plus,
        u.travel_style as "travelStyle", u.interests,
        t_other.city, t_other.country_code as "countryCode",
        t_other.start_date as "startDate", t_other.end_date as "endDate",
        t_my.start_date as "myStartDate", t_my.end_date as "myEndDate"
      from trips t_my
      join trips t_other on t_other.city_key = t_my.city_key
      join users u on u.id = t_other.user_id
      where t_my.user_id = ${uid} and t_other.user_id <> ${uid}
        and t_my.end_date >= current_date and t_other.end_date >= current_date
        and t_other.start_date <= t_my.end_date and t_other.end_date >= t_my.start_date
        and u.deleted_at is null and u.banned_at is null
        and (u.snoozed_until is null or u.snoozed_until <= now())
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
      order by u.id, t_other.start_date`;

    const scored = rows.map(r => {
      const matchingStyles = (r.travelStyle ?? []).filter((s: string) => myStyles.includes(s));
      const matchingInterests = (r.interests ?? []).filter((i: string) => myInterests.includes(i));
      const overlapStart = Math.max(new Date(r.startDate).getTime(), new Date(r.myStartDate).getTime());
      const overlapEnd = Math.min(new Date(r.endDate).getTime(), new Date(r.myEndDate).getTime());
      const overlapDays = Math.max(1, Math.round((overlapEnd - overlapStart) / 86400_000) + 1);

      let score = overlapDays * 2 + matchingStyles.length * 5 + matchingInterests.length * 2;
      if (r.verified) score += 3;
      if (r.plus) score += 2;

      return {
        id: r.id,
        name: r.name,
        photoUrl: r.photoUrl,
        homeCountry: r.homeCountry,
        age: r.age,
        verified: r.verified,
        plus: r.plus,
        city: r.city,
        countryCode: r.countryCode,
        startDate: r.startDate,
        endDate: r.endDate,
        overlapDays,
        matchingStyles,
        matchingInterests,
        score
      };
    });

    scored.sort((a, b) => b.score - a.score);
    // Free accounts get the overlap preview here too (it lists the same people as /trips/:id/overlaps).
    const v = await previewFor(uid, scored.slice(0, 30));
    return { buddies: v.shown, total: v.total, locked: v.locked, hiddenCount: v.hiddenCount };
  });

  // Feature 23: Suggested travel buddies for a specific trip with compatibility breakdown and connection status
  app.get('/trips/:id/buddies', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [t] = await sql`select city, country_code, city_key, start_date, end_date from trips where id = ${id} and user_id = ${uid}`;
    if (!t) throw notFound('trip_not_found');

    const [me] = await sql`select travel_style as "travelStyle", interests from users where id = ${uid}`;
    const myStyles: string[] = me?.travelStyle ?? [];
    const myInterests: string[] = me?.interests ?? [];

    const rows = await sql`
      select distinct on (u.id)
        u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        date_part('year', age(u.birthdate))::int as age, u.verified,
        ${plusOf('u')} as plus,
        u.travel_style as "travelStyle", u.interests, u.languages,
        o.start_date as "startDate", o.end_date as "endDate",
        (exists (select 1 from connections c where (c.user_id = ${uid} and c.friend_id = u.id) or (c.user_id = u.id and c.friend_id = ${uid}))) as is_connected,
        (select status from travel_buddy_requests br where br.sender_id = ${uid} and br.recipient_id = u.id and br.city_key = ${t.cityKey} limit 1) as sent_status,
        (select status from travel_buddy_requests br where br.sender_id = u.id and br.recipient_id = ${uid} and br.city_key = ${t.cityKey} limit 1) as received_status
      from trips o
      join users u on u.id = o.user_id
      where o.city_key = ${t.cityKey} and o.user_id <> ${uid}
        and o.start_date <= ${t.endDate} and o.end_date >= ${t.startDate}
        and u.deleted_at is null and u.banned_at is null
        and (u.snoozed_until is null or u.snoozed_until <= now())
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
      order by u.id, o.start_date`;

    const companions = rows.map(r => {
      const matchingStyles = (r.travelStyle ?? []).filter((s: string) => myStyles.includes(s));
      const matchingInterests = (r.interests ?? []).filter((i: string) => myInterests.includes(i));
      const overlapStart = Math.max(new Date(r.startDate).getTime(), new Date(t.startDate).getTime());
      const overlapEnd = Math.min(new Date(r.endDate).getTime(), new Date(t.endDate).getTime());
      const overlapDays = Math.max(1, Math.round((overlapEnd - overlapStart) / 86400_000) + 1);

      const matchScore = Math.min(99, Math.max(50, 45 + (overlapDays * 4) + (matchingStyles.length * 12) + (matchingInterests.length * 5) + (r.verified ? 6 : 0) + (r.plus ? 4 : 0)));

      let requestStatus: 'none' | 'sent' | 'received' | 'connected' = 'none';
      if (r.isConnected || r.sentStatus === 'accepted' || r.receivedStatus === 'accepted') {
        requestStatus = 'connected';
      } else if (r.sentStatus === 'pending') {
        requestStatus = 'sent';
      } else if (r.receivedStatus === 'pending') {
        requestStatus = 'received';
      }

      return {
        id: r.id,
        name: r.name,
        photoUrl: r.photoUrl,
        homeCountry: r.homeCountry,
        age: r.age,
        verified: r.verified,
        plus: r.plus,
        startDate: r.startDate,
        endDate: r.endDate,
        overlapDays,
        matchScore,
        matchingStyles,
        matchingInterests,
        languages: r.languages ?? [],
        requestStatus
      };
    });

    companions.sort((a, b) => b.matchScore - a.matchScore);
    // Free accounts get the overlap preview here too (it lists the same people as /trips/:id/overlaps).
    const v = await previewFor(uid, companions);
    return { companions: v.shown, total: v.total, locked: v.locked, hiddenCount: v.hiddenCount };
  });

  // Feature 23: Send a travel buddy connection invite to an overlapping traveler
  app.post('/trips/:id/buddy-requests', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { recipientId, introNote } = z.object({
      recipientId: z.string().uuid(),
      introNote: z.string().trim().max(300).optional()
    }).parse(req.body);

    if (recipientId === uid) throw bad('cannot_invite_self');

    const [t] = await sql`select city, country_code, city_key, start_date, end_date from trips where id = ${id} and user_id = ${uid}`;
    if (!t) throw notFound('trip_not_found');

    const [recipient] = await sql`
      select u.id, u.name from users u
      where u.id = ${recipientId} and u.deleted_at is null and u.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))`;
    if (!recipient) throw notFound('recipient_not_found');

    // A note to a stranger: moderated (awaited, so a flagged note is never stored or delivered) and held to the DM
    // contact rule, so it can't carry a phone number or handle to someone the sender hasn't met.
    if (introNote) {
      await assertClean(introNote);
      await assertNoContactsTo(uid, recipientId, [introNote]);
    }

    const lim = await limitsFor(uid);
    if (lim.buddyRequestsPerDay !== Infinity) {
      const [{ count }] = await sql`
        select count(*)::int as count from travel_buddy_requests
        where sender_id = ${uid} and created_at > now() - interval '24 hours'`;
      if (count >= lim.buddyRequestsPerDay) {
        throw needsPlus('buddy_requests_limit');
      }
    }

    const [request] = await sql`
      insert into travel_buddy_requests (sender_id, recipient_id, trip_id, city_key, intro_note, status, created_at)
      values (${uid}, ${recipientId}, ${id}, ${t.cityKey}, ${introNote ?? null}, 'pending', now())
      on conflict (sender_id, recipient_id, city_key)
      do update set intro_note = excluded.intro_note, status = 'pending', responded_at = null, created_at = now()
      returning id, status, created_at`;

    await addNotice([recipientId], {
      kind: 'buddy_request',
      actorId: uid,
      body: actorName => `${actorName} sent you a travel buddy request in ${t.city}!`
    });

    return { ok: true, request };
  });

  // Feature 23: List received and sent travel buddy requests
  app.get('/travel-buddies/requests', async req => {
    const uid = await requireUser(req);
    const received = await sql`
      select r.id, r.sender_id as "senderId", r.city_key as "cityKey", r.intro_note as "introNote", r.created_at as "createdAt",
        u.name as "senderName", u.photo_url as "senderPhotoUrl", u.home_country as "senderCountry",
        date_part('year', age(u.birthdate))::int as "senderAge", u.verified as "senderVerified",
        u.travel_style as "senderTravelStyle",
        t.city, t.start_date as "startDate", t.end_date as "endDate"
      from travel_buddy_requests r
      join users u on u.id = r.sender_id
      left join trips t on t.id = r.trip_id
      where r.recipient_id = ${uid} and r.status = 'pending'
        and u.deleted_at is null and u.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
      order by r.created_at desc`;

    const sent = await sql`
      select r.id, r.recipient_id as "recipientId", r.city_key as "cityKey", r.status, r.created_at as "createdAt",
        u.name as "recipientName", u.photo_url as "recipientPhotoUrl"
      from travel_buddy_requests r
      join users u on u.id = r.recipient_id
      where r.sender_id = ${uid}
      order by r.created_at desc limit 20`;

    return { received, sent };
  });

  // Feature 23: Accept or decline a travel buddy request
  app.post('/travel-buddies/requests/:id/respond', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { action } = z.object({ action: z.enum(['accept', 'decline']) }).parse(req.body);

    const [r] = await sql`
      select r.id, r.sender_id, r.city_key, t.city
      from travel_buddy_requests r
      left join trips t on t.id = r.trip_id
      where r.id = ${id} and r.recipient_id = ${uid} and r.status = 'pending'`;
    if (!r) throw notFound('request_not_found');

    const status = action === 'accept' ? 'accepted' : 'declined';
    await sql`update travel_buddy_requests set status = ${status}, responded_at = now() where id = ${id}`;

    let chatId: string | null = null;
    if (action === 'accept') {
      // Connect both travelers
      await sql`
        insert into connections (user_id, friend_id)
        values (${uid}, ${r.senderId}), (${r.senderId}, ${uid})
        on conflict do nothing`;

      // Notify sender
      await addNotice([r.senderId], {
        kind: 'buddy_accepted',
        actorId: uid,
        body: actorName => `${actorName} accepted your travel buddy request! Say hi and plan your trip together.`
      });

      // Ensure a DM chat is ready between them
      const dmKey = [uid, r.senderId].sort().join(':');
      let [c] = await sql`select id from chats where dm_key = ${dmKey}`;
      if (!c) {
        [c] = await sql`insert into chats (kind, dm_key, last_message_at) values ('dm', ${dmKey}, now())
          on conflict (dm_key) do update set dm_key = excluded.dm_key returning id`;
      }
      await sql`
        insert into chat_members (chat_id, user_id, request_status)
        values (${c.id}, ${uid}, 'accepted'), (${c.id}, ${r.senderId}, 'accepted')
        on conflict (chat_id, user_id) do update set request_status = 'accepted'`;
      chatId = c.id;
    }

    return { ok: true, status, chatId };
  });
}

async function joinCityChat(uid: string, city: string, key: string, womenOnly = false, legacyKey?: string) {
  if (womenOnly) {
    const [me] = await sql`select gender from users where id = ${uid}`;
    if (me?.gender !== 'woman') {
      throw forbidden('women_only', 'Only women travelers can join women-only city chats.');
    }
  }
  const chatTitle = womenOnly ? `${city} Women Nomads 🌸` : `${city} travelers`;

  // The key is built from a normalised city key (lib/geo.ts cityKey: letters, digits, dashes), the same one the city
  // guide pages use (lib/city-chats.ts), and a women's chat is always women_only, even if a row with that key already existed.
  const chatId = await cityChatId(key, chatTitle, womenOnly, legacyKey);
  await sql`insert into chat_members (chat_id, user_id) values (${chatId}, ${uid}) on conflict do nothing`;
  joinUserToChat(uid, chatId);
  // A pre-existing mixed chat on this key just became women-only: anyone else's sockets leave its room.
  if (womenOnly) await dropNonListeners(chatId);
  return { chatId };
}

export async function joinTripChat(uid: string, tripId: string) {
  const [t] = await sql`select city, country_code, city_key, start_date, end_date from trips where id = ${tripId} and user_id = ${uid}`;
  if (!t) throw notFound();

  const d = new Date(t.startDate);
  const ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  const monthName = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const key = `${t.cityKey}:${ym}`;
  const title = `${t.city} · ${monthName} ${d.getUTCFullYear()} Circle ✈️`;

  let [c] = await sql`select id from chats where trip_key = ${key}`;
  if (!c) {
    [c] = await sql`insert into chats (kind, trip_key, title, last_message_at)
      values ('trip', ${key}, ${title}, now())
      on conflict (trip_key) do update set title = excluded.title returning id`;
  }

  const [existing] = await sql`select 1 from chat_members where chat_id = ${c.id} and user_id = ${uid}`;
  await sql`insert into chat_members (chat_id, user_id) values (${c.id}, ${uid}) on conflict do nothing`;
  joinUserToChat(uid, c.id);

  if (!existing) {
    const [u] = await sql`select name from users where id = ${uid}`;
    const [msg] = await sql`insert into messages (chat_id, kind, body)
      values (${c.id}, 'system', ${`✈️ ${u?.name || 'A traveler'} joined the ${title}!`})
      returning id, chat_id, kind, body, created_at, sender_id`;
    await sql`update chats set last_message_at = now() where id = ${c.id}`;
    emitToChat(c.id, 'message:new', msg);
  }

  const [{ count }] = await sql`select count(*)::int as count from chat_members where chat_id = ${c.id}`;
  return { chatId: c.id as string, title, memberCount: count };
}

