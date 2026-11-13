import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireUser, impersonatorOf } from '../lib/auth.js';
import { recordPlanView } from '../lib/engagement.js';
import { limitsFor, plusOf, PLUS_RANK } from '../lib/plus.js';
import { cachedCountry, cityForPlan, fillPlanCityLater } from '../lib/geo.js';
import { notify } from '../lib/push.js';
import { addNotice } from '../lib/inbox.js';
import { emitToChat, emitToUser, joinUserToChat, leaveUsersFromChat } from '../lib/realtime.js';
import { bad, forbidden, notFound, needsPlus, HttpError } from '../lib/errors.js';
import { requireAdmin } from '../lib/admin.js';
import { render } from '../lib/emails/layout.js';
import { safetyAlert } from '../lib/emails/templates.js';
import { sendMail } from '../lib/mail.js';
import { assertClean } from '../lib/moderation.js';
import crypto from 'node:crypto';
import { config } from '../lib/config.js';
import { createTicketOrder, verifyRazorpayTicket, razorpayOn } from '../lib/razorpay.js';
import { ownerSaleAlert, razorpayProduct, razorpayTest } from '../lib/owner-alerts.js';
import { clock } from '../lib/clock.js';
import { generateNextOccurrence, processDueRecurring, processPlanReminders } from '../lib/plan-jobs.js';
import { assertCanJoin, goingCount, lockPlanForJoin } from '../lib/plans.js';
import { alertNearbyPlan, nearestPlanCities } from '../lib/nearby-alerts.js';

export function getEmergencyNumbers(countryCode?: string | null): { police: string; ambulance: string; general: string } {
  const cc = (countryCode || '').toUpperCase();
  switch (cc) {
    case 'US':
    case 'CA':
      return { police: '911', ambulance: '911', general: '911' };
    case 'GB':
      return { police: '999', ambulance: '999', general: '112' };
    case 'IN':
      return { police: '112', ambulance: '108', general: '112' };
    case 'TH':
      return { police: '191', ambulance: '1669', general: '1155 (Tourist Police)' };
    case 'ID':
      return { police: '110', ambulance: '118', general: '112' };
    case 'JP':
      return { police: '110', ambulance: '119', general: '110' };
    case 'VN':
      return { police: '113', ambulance: '115', general: '113' };
    case 'AU':
      return { police: '000', ambulance: '000', general: '112' };
    case 'MX':
      return { police: '911', ambulance: '911', general: '911' };
    case 'BR':
      return { police: '190', ambulance: '192', general: '190' };
    default:
      return { police: '112', ambulance: '112', general: '112' };
  }
}

const CATEGORIES = ['food','drinks','nightlife','explore','outdoors','culture','sports','work','other'] as const;

/** The "this weekend" window of the plan list, in the server's local time: Friday 17:00 to Sunday night (or what is left of it). */
export function getWeekendTimestamps(now: Date = clock.now()): { start: Date; end: Date } {
  const day = now.getDay(); // 0: Sun, 1: Mon, ... 5: Fri, 6: Sat
  const start = new Date(now);
  const end = new Date(now);

  if (day === 0) { // Sunday
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (day === 6) { // Saturday
    start.setHours(0, 0, 0, 0);
    end.setDate(end.getDate() + 1);
    end.setHours(23, 59, 59, 999);
  } else if (day === 5) { // Friday
    if (now.getHours() < 17) {
      start.setHours(17, 0, 0, 0);
    }
    end.setDate(end.getDate() + 2);
    end.setHours(23, 59, 59, 999);
  } else { // Monday - Thursday
    const diff = 5 - day;
    start.setDate(start.getDate() + diff);
    start.setHours(17, 0, 0, 0);
    // From the start, not from `now`: when the coming Friday is in the next month, the day-of-month alone put the end
    // of the window weeks in the past (Monday 28 Sep gave a weekend ending on 4 Sep).
    end.setTime(start.getTime());
    end.setDate(end.getDate() + 2);
    end.setHours(23, 59, 59, 999);
  }
  return { start, end };
}

/** Shape used by every list and detail endpoint. */
const activityCols = (uid: string) => sql`
  a.id, a.title, a.emoji, a.category, a.description, a.place_name, a.place_address, a.city, a.starts_at,
  a.max_people, a.women_only, a.status, a.closed, a.created_at, a.recurrence,
  a.series_id as "seriesId", a.parent_activity_id as "parentActivityId",
  a.occurrence_number as "occurrenceNumber", a.next_activity_id as "nextActivityId", a.auto_advance as "autoAdvance",
  a.is_paid as "isPaid", a.ticket_price_paise as "ticketPricePaise", a.ticket_currency as "ticketCurrency",
  a.max_tickets as "maxTickets", a.tickets_sold as "ticketsSold",
  -- The host's payout UPI ID often contains their phone number: only the host sees it.
  case when a.host_id = ${uid} then a.payout_upi_id end as "payoutUpiId",
  (select json_build_object('id', t.id, 'ticketCode', t.ticket_code, 'status', t.status, 'pricePaise', t.price_paise, 'currency', t.currency, 'createdAt', t.created_at, 'usedAt', t.used_at)
   from activity_tickets t where t.activity_id = a.id and t.user_id = ${uid} and t.status in ('valid', 'used') limit 1) as "myTicket",
  ST_Y(a.location::geometry) as lat, ST_X(a.location::geometry) as lng,
  -- isTeam: the Tablamigo Host (account_kind 'team', lib/host.ts), which lists community meetups; it shows no rating.
  json_build_object(
    'id', h.id, 'name', h.name, 'photoUrl', h.photo_url, 'homeCountry', h.home_country, 'verified', h.verified,
    'isTeam', h.account_kind = 'team',
    'rating', case when h.account_kind = 'team' then null else (select coalesce(round(avg(rating)::numeric, 1)::float, null) from activity_ratings ar where ar.host_id = h.id) end,
    'ratingsCount', case when h.account_kind = 'team' then 0 else (select count(*)::int from activity_ratings ar where ar.host_id = h.id) end
  ) as host,
  (select count(*)::int from activity_members m where m.activity_id = a.id and m.rsvp_status = 'going') as going,
  (select count(*)::int from activity_members m where m.activity_id = a.id and m.rsvp_status = 'maybe') as maybe_count,
  (select count(*)::int from activity_members m where m.activity_id = a.id and m.rsvp_status = 'waitlist') as waitlist_count,
  (select m.rsvp_status from activity_members m where m.activity_id = a.id and m.user_id = ${uid}) as my_rsvp,
  (select m.running_late_mins from activity_members m where m.activity_id = a.id and m.user_id = ${uid}) as my_running_late_mins,
  (select m.running_late_note from activity_members m where m.activity_id = a.id and m.user_id = ${uid}) as my_running_late_note,
  exists(select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${uid} and m.checked_in_at is not null) as my_checked_in,
  (select count(*)::int from activity_members m where m.activity_id = a.id and m.checked_in_at is not null) as checked_in_count,
  (select coalesce(json_agg(x), '[]') from (
      select u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        m.rsvp_status as "rsvpStatus", (m.checked_in_at is not null) as "checkedIn",
        m.running_late_mins as "runningLateMins", m.running_late_note as "runningLateNote"
      from activity_members m join users u on u.id = m.user_id
      where m.activity_id = a.id order by (m.rsvp_status = 'going') desc, (m.rsvp_status = 'maybe') desc, m.joined_at limit 10) x) as members,
  (select coalesce(json_agg(x), '[]') from (
      select u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        m.rsvp_status as "rsvpStatus", (m.checked_in_at is not null) as "checkedIn",
        m.running_late_mins as "runningLateMins", m.running_late_note as "runningLateNote"
      from activity_members m join users u on u.id = m.user_id
      where m.activity_id = a.id order by (m.rsvp_status = 'going') desc, (m.rsvp_status = 'maybe') desc, m.joined_at limit 50) x) as attendees,
  exists(select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${uid} and m.rsvp_status in ('going', 'maybe')) as joined,
  (select count(*)::int from activity_photos ap where ap.activity_id = a.id) as photos_count,
  (select coalesce(json_agg(p), '[]') from (
    select ap.id, ap.url, ap.caption, ap.created_at,
      json_build_object('id', u.id, 'name', u.name, 'photoUrl', u.photo_url) as user
    from activity_photos ap
    join users u on u.id = ap.user_id
    where ap.activity_id = a.id order by ap.created_at asc limit 8
  ) p) as photos,
  (select c.id from chats c where c.activity_id = a.id) as chat_id,
  exists(select 1 from saved_activities sa where sa.activity_id = a.id and sa.user_id = ${uid}) as is_saved,
  (select count(*)::int from saved_activities sa where sa.activity_id = a.id) as saved_count,
  (select count(*)::int from activity_comments ac where ac.activity_id = a.id) as comments_count`;

/**
 * Plans `uid` may see in saved lists and the offline bundle: women-only plans only for women or people already in
 * them (as GET /activities/:id), and never a plan whose host is on either side of a block with them.
 */
const visibleTo = (uid: string) => sql`(not a.women_only
    or exists(select 1 from users v where v.id = ${uid} and v.gender = 'woman')
    or exists(select 1 from activity_members vm where vm.activity_id = a.id and vm.user_id = ${uid}))
  and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = a.host_id) or (b.blocker_id = a.host_id and b.blocked_id = ${uid}))`;

/** Paid events are switched off (config.features.paidEvents): no tickets can be ordered or issued. */
const paidEventsOff = () => new HttpError(404, 'paid_events_unavailable', 'Paid events are not available yet.');

/**
 * ISO country of a plan's meeting point, for local emergency numbers. Null when it can't be told. Cache only: an SOS
 * never waits up to 4 s on a reverse-geocode (lib/geo.ts cachedCountry).
 */
export async function planCountry(lat: number | null | undefined, lng: number | null | undefined) {
  if (lat == null || lng == null) return null;
  return cachedCountry(lat, lng);
}

/** "Running late" can be posted from this long before a plan starts until this long after (the app hides it outside). */
export const RUNNING_LATE_WINDOW = { beforeMins: 60, afterMins: 60 };

/** The radii GET /activities tries, in order, when nothing is within the asked radius (the map's default view only). */
export const WIDER_PLANS_KM = [100, 500, 1500];
/** Fewer plans than this within the radius: GET /activities adds the world list (nearest first) after them. */
export const FEW_NEARBY_PLANS = 5;
/** Rows per page of the world list. */
export const WORLD_PAGE = 20;

export default async function activities(app: FastifyInstance) {
  const listQuery = z.object({
    lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180),
    radiusKm: z.coerce.number().min(1).max(100).default(25),
    category: z.enum(CATEGORIES).optional(),
    when: z.enum(['now','today','tomorrow','weekend','week']).default('week'),
    recurring_only: z.coerce.boolean().optional(),
  });
  type ListQuery = z.infer<typeof listQuery>;

  /**
   * The plans `uid` may see around (lat, lng) under the list's filters. `minKm` (exclusive) and `maxKm` (inclusive) bound the
   * distance; `after` is a world-list cursor (the last row's distance and id), so pages follow on in distance order.
   */
  const plansAround = async (uid: string, q: ListQuery, o: {
    minKm?: number; maxKm?: number; order: 'plus' | 'distance'; limit: number; after?: { d: number; id: string };
  }) => {
    const [me] = await sql`select gender from users where id = ${uid}`;
    let startFilter = sql`now() - interval '2 hours'`;
    let endFilter = sql`now() + interval '14 days'`;
    if (q.when === 'now') {
      endFilter = sql`now() + interval '3 hours'`;
    } else if (q.when === 'today') {
      endFilter = sql`date_trunc('day', now()) + interval '1 day'`;
    } else if (q.when === 'tomorrow') {
      startFilter = sql`date_trunc('day', now()) + interval '1 day'`;
      endFilter = sql`date_trunc('day', now()) + interval '2 days'`;
    } else if (q.when === 'weekend') {
      const wk = getWeekendTimestamps();
      startFilter = sql`${wk.start}`;
      endFilter = sql`${wk.end}`;
    }
    const here = sql`ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography`;
    return sql`
      select * from (
        select ${activityCols(uid)}, ${plusOf('h')} as host_rank,
          ST_Distance(a.location, ${here})::int as distance_m
        from activities a join users h on h.id = a.host_id
        where a.status = 'active'
          and (not a.closed or exists(select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${uid}))
          and a.starts_at between ${startFilter} and ${endFilter}
          and (${o.maxKm ?? null}::float is null or ST_DWithin(a.location, ${here}, ${(o.maxKm ?? 0) * 1000}))
          and (${o.minKm ?? null}::float is null or not ST_DWithin(a.location, ${here}, ${(o.minKm ?? 0) * 1000}))
          and (${q.category ?? null}::text is null or a.category = ${q.category ?? null})
          and (not ${!!q.recurring_only} or a.recurrence is not null)
          and (not a.women_only or ${me?.gender === 'woman'})
          and h.deleted_at is null and h.banned_at is null
          and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = a.host_id) or (b.blocker_id = a.host_id and b.blocked_id = ${uid}))
      ) x
      where ${o.after ? sql`(x.distance_m, x.id) > (${o.after.d}, ${o.after.id}::uuid)` : sql`true`}
      order by ${o.order === 'plus' ? sql`x.host_rank desc nulls last, x.starts_at asc` : sql`x.distance_m asc, x.id asc`}
      limit ${o.limit}`;
  };
  const strip = (rows: postgres.RowList<postgres.Row[]>) => rows.map(({ hostRank: _r, ...a }) => a);
  /** The world list's next-page cursor: the last row's distance and id. */
  const cursorOf = (rows: postgres.Row[], limit: number) =>
    rows.length === limit ? `${rows[rows.length - 1].distanceM}_${rows[rows.length - 1].id}` : null;

  app.get('/activities', async req => {
    const uid = await requireUser(req);
    const q = listQuery.parse(req.query);
    const rows = strip(await plansAround(uid, q, { maxKm: q.radiusKm, order: 'plus', limit: 150 }));
    // Few or no plans nearby: the rest of the world too, nearest first (`world`, the first page of GET /activities/world),
    // under the same filters. Never a duplicate of a nearby row: it starts outside the radius.
    const world = rows.length < FEW_NEARBY_PLANS
      ? strip(await plansAround(uid, q, { minKm: q.radiusKm, order: 'distance', limit: WORLD_PAGE }))
      : null;
    const worldPart = world ? { world: { activities: world, nextCursor: cursorOf(world, WORLD_PAGE) } } : { world: null };
    // Nothing within the radius on the unfiltered map: the nearest plans further out, nearest first, so a new person in a
    // quiet town sees "nearest plan: Goa, 480 km" instead of an empty map (25 of 25 located sign-ups had none within 25 km).
    // `wider` is for apps released before `world` (Android 1.4.1 and older); they ignore `world`.
    if (rows.length || q.category || q.recurring_only || q.when !== 'week') return { activities: rows, ...worldPart };
    // Nothing within 50 km either: the nearest cities that have plans, with distances (lib/nearby-alerts.ts), and whether this
    // person already asked to hear about new plans near them. Apps before 1.4.4 ignore both.
    const [cities, [me]] = await Promise.all([nearestPlanCities(uid, q.lat, q.lng), sql`select nearby_plan_alerts from users where id = ${uid}`]);
    const emptyPart = { nearestCities: cities, nearbyAlerts: !!me?.nearbyPlanAlerts };
    for (const radiusKm of WIDER_PLANS_KM.filter(km => km > q.radiusKm)) {
      const far = strip(await plansAround(uid, q, { maxKm: radiusKm, order: 'distance', limit: 20 }));
      if (far.length) return { activities: rows, wider: { radiusKm, activities: far }, ...worldPart, ...emptyPart };
    }
    return { activities: rows, wider: null, ...worldPart, ...emptyPart };
  });

  // The next pages of the world list: plans outside the radius anywhere, nearest first, under the same filters and rules.
  app.get('/activities/world', async req => {
    const uid = await requireUser(req);
    const q = listQuery.extend({
      cursor: z.string().regex(/^\d{1,9}_[0-9a-f-]{36}$/).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(WORLD_PAGE),
    }).parse(req.query);
    const after = q.cursor ? { d: Number(q.cursor.split('_')[0]), id: q.cursor.slice(q.cursor.indexOf('_') + 1) } : undefined;
    const rows = strip(await plansAround(uid, q, { minKm: q.radiusKm, order: 'distance', limit: q.limit, after }));
    return { activities: rows, nextCursor: cursorOf(rows, q.limit) };
  });

  // Feature 32 / Backlog 7: Saved / bookmarked plans for offline caching and later viewing
  app.get('/activities/saved', async req => {
    const uid = await requireUser(req);
    const rows = await sql`
      select ${activityCols(uid)},
        sa.notes as saved_notes,
        sa.cached_at as cached_at,
        sa.updated_at as updated_at,
        sa.created_at as saved_at
      from saved_activities sa
      join activities a on a.id = sa.activity_id
      join users h on h.id = a.host_id
      where sa.user_id = ${uid}
        and a.status = 'active'
        and h.deleted_at is null and h.banned_at is null
        and ${visibleTo(uid)}
      order by sa.created_at desc
      limit 100
    `;
    return { saved: rows };
  });

  // Feature 32: Offline bundle download containing saved plans, joined upcoming plans, and emergency contacts
  app.get('/activities/saved/offline-bundle', async req => {
    const uid = await requireUser(req);

    // 1. Saved plans
    const saved = await sql`
      select ${activityCols(uid)},
        sa.notes as saved_notes,
        sa.cached_at as cached_at,
        sa.updated_at as updated_at,
        sa.created_at as saved_at
      from saved_activities sa
      join activities a on a.id = sa.activity_id
      join users h on h.id = a.host_id
      where sa.user_id = ${uid}
        and a.status = 'active'
        and h.deleted_at is null and h.banned_at is null
        and ${visibleTo(uid)}
      order by sa.created_at desc
      limit 100
    `;

    // 2. Joined plans (upcoming or happening now)
    const joined = await sql`
      select ${activityCols(uid)},
        m.rsvp_status as my_rsvp_status,
        m.checked_in_at as my_checked_in_at,
        m.joined_at as my_joined_at,
        (select coalesce(json_agg(msg), '[]') from (
          select id, sender_id, kind, body, created_at
          from messages
          where chat_id = (select id from chats c where c.activity_id = a.id)
            and deleted_at is null
          order by id desc
          limit 5
        ) msg) as recent_chat_messages
      from activity_members m
      join activities a on a.id = m.activity_id
      join users h on h.id = a.host_id
      where m.user_id = ${uid}
        and m.rsvp_status in ('going', 'maybe')
        and a.status = 'active'
        and a.starts_at >= (now() - interval '24 hours')
        and h.deleted_at is null and h.banned_at is null
        and ${visibleTo(uid)}
      order by a.starts_at asc
      limit 25
    `;

    // 3. User emergency contact info
    const [user] = await sql`
      select emergency_contact_name as "emergencyContactName",
             emergency_contact_phone as "emergencyContactPhone"
      from users where id = ${uid}
    `;

    // 4. Helplines for traveler safety
    const helplines = [
      { country: 'India', police: '112', ambulance: '102', womenHelpline: '181', touristHelpline: '1363' },
      { country: 'Portugal', police: '112', ambulance: '112', touristHelpline: '112' },
      { country: 'Thailand', police: '191', touristPolice: '1155', ambulance: '1669' },
      { country: 'International', emergency: '112' }
    ];

    return {
      generatedAt: new Date().toISOString(),
      version: 1,
      totalSaved: saved.length,
      totalJoined: joined.length,
      saved,
      joined,
      emergencyContact: {
        name: user?.emergencyContactName || null,
        phone: user?.emergencyContactPhone || null
      },
      helplines
    };
  });

  // Feature 32: Batch auto-sync endpoint for offline queued bookmarks and personal notes
  app.post('/activities/saved/sync', async req => {
    const uid = await requireUser(req);
    const schema = z.object({
      items: z.array(z.object({
        activityId: z.string().uuid(),
        save: z.boolean(),
        notes: z.string().trim().max(500).optional(),
        clientUpdatedAt: z.string().optional()
      })).min(1).max(50)
    });
    const { items } = schema.parse(req.body);

    for (const item of items) {
      if (item.save) {
        const [a] = await sql`select a.id from activities a where a.id = ${item.activityId} and a.status = 'active' and ${visibleTo(uid)}`;
        if (a) {
          await sql`
            insert into saved_activities (user_id, activity_id, notes, cached_at, updated_at)
            values (${uid}, ${item.activityId}, ${item.notes || null}, now(), now())
            on conflict (user_id, activity_id) do update set
              notes = coalesce(${item.notes || null}, saved_activities.notes),
              cached_at = now(),
              updated_at = now()
          `;
        }
      } else {
        await sql`delete from saved_activities where user_id = ${uid} and activity_id = ${item.activityId}`;
      }
    }

    const rows = await sql`
      select ${activityCols(uid)},
        sa.notes as saved_notes,
        sa.cached_at as cached_at,
        sa.updated_at as updated_at,
        sa.created_at as saved_at
      from saved_activities sa
      join activities a on a.id = sa.activity_id
      join users h on h.id = a.host_id
      where sa.user_id = ${uid}
        and a.status = 'active'
        and h.deleted_at is null and h.banned_at is null
        and ${visibleTo(uid)}
      order by sa.created_at desc
      limit 100
    `;

    return { ok: true, syncedCount: items.length, saved: rows };
  });

  // Feature 32 / Backlog 7: Bookmark or unbookmark a plan with optional personal offline notes
  app.post('/activities/:id/save', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { save, notes } = z.object({
      save: z.boolean().optional(),
      notes: z.string().trim().max(500).optional()
    }).parse(req.body ?? {});

    const [a] = await sql`select a.id, a.status from activities a where a.id = ${id} and ${visibleTo(uid)}`;
    if (!a || a.status === 'cancelled') throw notFound('Activity not found');

    const [existing] = await sql`select 1 from saved_activities where user_id = ${uid} and activity_id = ${id}`;
    const shouldSave = save !== undefined ? save : !existing;

    if (shouldSave) {
      await sql`
        insert into saved_activities (user_id, activity_id, notes, cached_at, updated_at)
        values (${uid}, ${id}, ${notes || null}, now(), now())
        on conflict (user_id, activity_id) do update set
          notes = coalesce(${notes || null}, saved_activities.notes),
          cached_at = now(),
          updated_at = now()
      `;
    } else {
      await sql`delete from saved_activities where user_id = ${uid} and activity_id = ${id}`;
    }

    const [{ count }] = await sql`select count(*)::int as count from saved_activities where activity_id = ${id}`;
    return { ok: true, saved: shouldSave, savedCount: count };
  });

  // Feature 32: Save or update private traveler notes on a bookmarked plan
  app.put('/activities/:id/save/notes', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { notes } = z.object({ notes: z.string().trim().max(500) }).parse(req.body ?? {});

    const [a] = await sql`select a.id, a.status from activities a where a.id = ${id} and ${visibleTo(uid)}`;
    if (!a || a.status === 'cancelled') throw notFound('Activity not found');

    const [sa] = await sql`
      insert into saved_activities (user_id, activity_id, notes, cached_at, updated_at)
      values (${uid}, ${id}, ${notes || null}, now(), now())
      on conflict (user_id, activity_id) do update set
        notes = ${notes || null},
        cached_at = now(),
        updated_at = now()
      returning user_id, activity_id, notes, updated_at
    `;

    const [{ count }] = await sql`select count(*)::int as count from saved_activities where activity_id = ${id}`;
    return { ok: true, activityId: id, notes: sa.notes, saved: true, savedCount: count };
  });

  // Feature 36: Get public discussion questions & comments on an activity
  app.get('/activities/:id/comments', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [a] = await sql`select id, host_id, women_only from activities where id = ${id} and status = 'active'`;
    if (!a) throw notFound('Activity not found');

    if (a.womenOnly) {
      const [me] = await sql`select gender from users where id = ${uid}`;
      if (me?.gender !== 'woman') throw forbidden('women_only');
    }

    const rows = await sql`
      select 
        c.id, c.activity_id as "activityId", c.body, c.parent_comment_id as "parentCommentId", c.created_at as "createdAt",
        json_build_object(
          'id', u.id, 'name', u.name, 'photoUrl', u.photo_url, 'homeCountry', u.home_country, 'verified', u.verified,
          'isHost', (u.id = ${a.hostId})
        ) as author
      from activity_comments c
      join users u on u.id = c.user_id
      where c.activity_id = ${id}
        and u.deleted_at is null and u.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = c.user_id) or (b.blocker_id = c.user_id and b.blocked_id = ${uid}))
      order by c.created_at asc
      limit 100
    `;
    return { comments: rows };
  });

  // Feature 36: Post a discussion question or reply on an activity
  app.post('/activities/:id/comments', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { body, parentCommentId } = z.object({
      body: z.string().trim().min(2).max(500),
      parentCommentId: z.string().uuid().optional().nullable()
    }).parse(req.body);

    const [a] = await sql`select id, title, host_id, women_only, status from activities where id = ${id}`;
    if (!a || a.status === 'cancelled') throw notFound('Activity not found or cancelled');

    const [me] = await sql`select name, gender, onboarded from users where id = ${uid}`;
    if (!me?.onboarded) throw forbidden('profile_incomplete', 'Complete onboarding to ask questions.');
    if (a.womenOnly && me.gender !== 'woman') throw forbidden('women_only', 'Only women travelers can comment on women-only plans.');

    await assertClean(body);

    if (parentCommentId) {
      const [parent] = await sql`select id, user_id from activity_comments where id = ${parentCommentId} and activity_id = ${id}`;
      if (!parent) throw notFound('Parent comment not found');
    }

    const [comment] = await sql`
      insert into activity_comments (activity_id, user_id, body, parent_comment_id)
      values (${id}, ${uid}, ${body}, ${parentCommentId ?? null})
      returning id, activity_id as "activityId", body, parent_comment_id as "parentCommentId", created_at as "createdAt"
    `;

    // Notify host if commenter is not host
    if (a.hostId !== uid) {
      await addNotice([a.hostId], {
        kind: 'plan_comment',
        actorId: uid,
        activityId: id,
        body: `${me.name} asked a question on "${a.title}": "${body.slice(0, 60)}${body.length > 60 ? '...' : ''}"`
      });
    }

    // If reply to another traveler's comment, notify them
    if (parentCommentId) {
      const [parent] = await sql`select user_id from activity_comments where id = ${parentCommentId}`;
      if (parent && parent.userId !== uid && parent.userId !== a.hostId) {
        await addNotice([parent.userId], {
          kind: 'plan_comment',
          actorId: uid,
          activityId: id,
          body: `${me.name} replied to your question on "${a.title}"`
        });
      }
    }

    return {
      ...comment,
      author: {
        id: uid,
        name: me.name,
        isHost: (uid === a.hostId)
      }
    };
  });

  // Feature 36: Delete a comment (author or host)
  app.delete('/activities/:id/comments/:commentId', async req => {
    const uid = await requireUser(req);
    const { id, commentId } = z.object({ id: z.string().uuid(), commentId: z.string().uuid() }).parse(req.params);

    const [c] = await sql`
      select c.id, c.user_id, a.host_id
      from activity_comments c
      join activities a on a.id = c.activity_id
      where c.id = ${commentId} and c.activity_id = ${id}
    `;
    if (!c) throw notFound('Comment not found');
    if (c.userId !== uid && c.hostId !== uid) throw forbidden('Not authorized to delete this comment');

    await sql`delete from activity_comments where id = ${commentId}`;
    return { ok: true };
  });

  app.get('/activities/:id', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [a] = await sql`select ${activityCols(uid)} from activities a join users h on h.id = a.host_id where a.id = ${id}`;
    if (!a) throw notFound();
    // Women-only plans are invisible to everyone else, even with a direct link (members keep access).
    if (a.womenOnly && !a.joined) {
      const [me] = await sql`select gender from users where id = ${uid}`;
      if (me?.gender !== 'woman') throw notFound();
    }
    // The host's daily "N people looked at your plan" (lib/engagement.ts). An admin looking through someone's account is not a view.
    if (!impersonatorOf(req)) void recordPlanView(id, uid);
    const attendees = await sql`
      select u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        m.rsvp_status as "rsvpStatus", (m.checked_in_at is not null) as "checkedIn",
        m.running_late_mins as "runningLateMins", m.running_late_note as "runningLateNote"
      from activity_members m join users u on u.id = m.user_id
      where m.activity_id = ${id}
      order by (m.rsvp_status = 'going') desc, (m.rsvp_status = 'maybe') desc, m.joined_at
    `;
    return { ...a, attendees };
  });

  app.post('/activities', async req => {
    const uid = await requireUser(req);
    const b = z.object({
      title: z.string().trim().min(3).max(80),
      emoji: z.string().max(8).default('✨'),
      category: z.enum(CATEGORIES),
      description: z.string().trim().max(600).optional(),
      placeName: z.string().trim().min(2).max(120),
      placeAddress: z.string().max(240).optional(),
      lat: z.number(), lng: z.number(),
      startsAt: z.string().datetime(),
      maxPeople: z.number().int().min(2).max(50).optional(),
      womenOnly: z.boolean().default(false),
      recurrence: z.enum(['weekly', 'biweekly', 'monthly']).optional().nullable(),
      isPaid: z.boolean().default(false),
      ticketPricePaise: z.number().int().min(5000).max(5000000).optional().nullable(),
      maxTickets: z.number().int().min(1).max(500).optional().nullable(),
      payoutUpiId: z.string().trim().max(100).optional().nullable(),
    }).parse(req.body);
    const starts = new Date(b.startsAt);
    if (starts.getTime() < Date.now() - 15 * 60_000 || starts.getTime() > Date.now() + 30 * 86400_000) throw bad('bad_time', 'Pick a time in the next 30 days.');
    if (b.isPaid && !config.features.paidEvents) throw forbidden('paid_events_unavailable', 'Paid events are not available yet.');
    if (b.isPaid && (!b.ticketPricePaise || b.ticketPricePaise < 5000)) {
      throw bad('invalid_ticket_price', 'Ticketed events require a ticket price of at least ₹50 (5000 paise).');
    }
    const [me] = await sql`select gender, onboarded from users where id = ${uid}`;
    if (!me?.onboarded) throw forbidden('profile_incomplete');
    if (b.womenOnly && me.gender !== 'woman') throw forbidden('women_only_host', 'Only women can host women-only activities.');
    const lim = await limitsFor(uid);
    const [{ n }] = await sql`select count(*)::int as n from activities where host_id = ${uid} and created_at > now() - interval '1 day'`;
    if (n >= lim.activitiesPerDay) throw needsPlus('more_activities');
    const city = await cityForPlan(b.lat, b.lng, uid);
    const created = await sql.begin(async tx => {
      const [a] = await tx`insert into activities (host_id, title, emoji, category, description, place_name, place_address, location, city, starts_at, max_people, women_only, recurrence, occurrence_number, auto_advance, is_paid, ticket_price_paise, ticket_currency, max_tickets, payout_upi_id)
        values (${uid}, ${b.title}, ${b.emoji}, ${b.category}, ${b.description ?? null}, ${b.placeName}, ${b.placeAddress ?? null},
          ST_SetSRID(ST_MakePoint(${b.lng}, ${b.lat}), 4326)::geography, ${city}, ${starts}, ${b.maxPeople ?? null}, ${b.womenOnly}, ${b.recurrence ?? null}, 1, true,
          ${b.isPaid}, ${b.isPaid ? (b.ticketPricePaise ?? null) : null}, 'INR', ${b.isPaid ? (b.maxTickets ?? null) : null}, ${b.isPaid ? (b.payoutUpiId ?? null) : null}) returning id`;
      if (b.recurrence) {
        await tx`update activities set series_id = ${a.id} where id = ${a.id}`;
      }
      await tx`insert into activity_members (activity_id, user_id, rsvp_status) values (${a.id}, ${uid}, 'going')`;
      const [c] = await tx`insert into chats (kind, activity_id, title, last_message_at) values ('activity', ${a.id}, ${b.title}, now()) returning id`;
      await tx`insert into chat_members (chat_id, user_id) values (${c.id}, ${uid})`;
      await tx`insert into messages (chat_id, kind, body) values (${c.id}, 'system', ${'Plan posted. Travelers who join will land here, so say hi and agree the details.'})`;
      return { id: a.id, chatId: c.id };
    });
    joinUserToChat(uid, created.chatId);
    if (!city) void fillPlanCityLater(created.id, b.lat, b.lng);
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${uid}, 'plan_created', ${sql.json({ activityId: created.id, category: b.category, city } as any)})`.catch(() => {});
    // People within 50 km who asked to hear about new plans near them (lib/nearby-alerts.ts). Never holds up the answer.
    void alertNearbyPlan(created.id);
    return created;
  });

  app.post('/activities/:id/join', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rsvp } = z.object({ rsvp: z.enum(['going', 'maybe', 'waitlist']).optional() }).parse(req.body ?? {});
    const res = await sql.begin(async tx => {
      // The plan row stays locked until this transaction commits, and every rule (lib/plans.ts) is checked under that lock.
      const a = await lockPlanForJoin(tx, id);
      const { me, already, finalStatus } = await assertCanJoin(tx, a, uid, { rsvp: rsvp ?? 'going', ticketForMembers: true });

      if (already) {
        const prevStatus = already.rsvpStatus;
        if (prevStatus === finalStatus) {
          return { chatId: a.chatId as string, hostId: a.hostId as string, title: a.title as string, msg: null, waitlisted: finalStatus === 'waitlist', rsvpStatus: finalStatus, promotedMember: null };
        }

        await tx`update activity_members set rsvp_status = ${finalStatus} where activity_id = ${id} and user_id = ${uid}`;

        let promotedMember = null;
        if (prevStatus === 'going' && finalStatus !== 'going') {
          const [promoted] = await tx`
            select m.user_id, u.name from activity_members m
            join users u on u.id = m.user_id
            where m.activity_id = ${id} and m.rsvp_status = 'waitlist'
            order by m.joined_at asc limit 1`;
          if (promoted) {
            await tx`update activity_members set rsvp_status = 'going' where activity_id = ${id} and user_id = ${promoted.userId}`;
            promotedMember = promoted;
          }
        }

        const actionText = finalStatus === 'waitlist' ? ' joined the waitlist' : finalStatus === 'maybe' ? ' is interested (maybe)' : ' joined';
        const [msg] = await tx`insert into messages (chat_id, kind, body)
          values (${a.chatId}, 'system', ${(me.name ?? 'Someone') + actionText})
          returning id, chat_id, kind, body, created_at, sender_id`;
        await tx`update chats set last_message_at = now() where id = ${a.chatId}`;

        return { chatId: a.chatId as string, hostId: a.hostId as string, title: a.title as string, msg, waitlisted: finalStatus === 'waitlist', rsvpStatus: finalStatus, promotedMember };
      }

      await tx`insert into activity_members (activity_id, user_id, rsvp_status) values (${id}, ${uid}, ${finalStatus})`;
      await tx`insert into chat_members (chat_id, user_id) values (${a.chatId}, ${uid}) on conflict do nothing`;

      const actionText = finalStatus === 'waitlist' ? ' joined the waitlist' : finalStatus === 'maybe' ? ' is interested (maybe)' : ' joined';
      const [msg] = await tx`insert into messages (chat_id, kind, body)
        values (${a.chatId}, 'system', ${(me.name ?? 'Someone') + actionText})
        returning id, chat_id, kind, body, created_at, sender_id`;
      await tx`update chats set last_message_at = now() where id = ${a.chatId}`;

      return { chatId: a.chatId as string, hostId: a.hostId as string, title: a.title as string, msg, waitlisted: finalStatus === 'waitlist', rsvpStatus: finalStatus, promotedMember: null };
    });

    joinUserToChat(uid, res.chatId);
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${uid}, 'plan_joined', ${sql.json({ activityId: id, rsvpStatus: res.rsvpStatus } as any)})`.catch(() => {});
    if (res.msg) {
      emitToChat(res.chatId, 'message:new', res.msg);
      emitToUser(res.hostId, 'activity:joined', { activityId: id, rsvpStatus: res.rsvpStatus });
      notify([res.hostId], { title: `${res.msg.body} your plan 🎉`, body: res.title, data: { chatId: res.chatId }, tag: res.chatId });
      const noticeKind = res.rsvpStatus === 'maybe' ? 'rsvp_update' : 'join';
      await addNotice([res.hostId], { kind: noticeKind, actorId: uid, activityId: id, chatId: res.chatId, body: `${res.msg.body} ${res.title}` });
    }
    if (res.promotedMember) {
      const [pMsg] = await sql`insert into messages (chat_id, kind, body)
        values (${res.chatId}, 'system', ${`${res.promotedMember.name} was promoted from the waitlist to going! 🎉`})
        returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${res.chatId}`;
      emitToChat(res.chatId, 'message:new', pMsg);
      notify([res.promotedMember.userId], { title: `A spot opened up! 🎉`, body: `You're now going to ${res.title}`, data: { chatId: res.chatId }, tag: res.chatId });
      await addNotice([res.promotedMember.userId], { kind: 'join', actorId: uid, activityId: id, chatId: res.chatId, body: `A spot opened up! You were promoted from the waitlist to going for ${res.title}.` });
    }
    return { ok: true, chatId: res.chatId, waitlisted: res.waitlisted, rsvpStatus: res.rsvpStatus };
  });

  // Dedicated RSVP update endpoint
  app.post('/activities/:id/rsvp', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rsvp } = z.object({ rsvp: z.enum(['going', 'maybe', 'waitlist']) }).parse(req.body ?? {});

    const res = await sql.begin(async tx => {
      // Same rules as /join (lib/plans.ts); a ticketed event is joined by buying a ticket, never by an RSVP.
      const a = await lockPlanForJoin(tx, id);
      const { me, already, finalStatus } = await assertCanJoin(tx, a, uid, { rsvp, ticketForMembers: false });

      if (already) {
        const prevStatus = already.rsvpStatus;
        if (prevStatus === finalStatus) {
          return { chatId: a.chatId as string, hostId: a.hostId as string, title: a.title as string, msg: null, waitlisted: finalStatus === 'waitlist', rsvpStatus: finalStatus, promotedMember: null };
        }

        await tx`update activity_members set rsvp_status = ${finalStatus} where activity_id = ${id} and user_id = ${uid}`;

        let promotedMember = null;
        if (prevStatus === 'going' && finalStatus !== 'going') {
          const [promoted] = await tx`
            select m.user_id, u.name from activity_members m
            join users u on u.id = m.user_id
            where m.activity_id = ${id} and m.rsvp_status = 'waitlist'
            order by m.joined_at asc limit 1`;
          if (promoted) {
            await tx`update activity_members set rsvp_status = 'going' where activity_id = ${id} and user_id = ${promoted.userId}`;
            promotedMember = promoted;
          }
        }

        const actionText = finalStatus === 'waitlist' ? ' joined the waitlist' : finalStatus === 'maybe' ? ' is interested (maybe)' : ' joined';
        const [msg] = await tx`insert into messages (chat_id, kind, body)
          values (${a.chatId}, 'system', ${(me.name ?? 'Someone') + actionText})
          returning id, chat_id, kind, body, created_at, sender_id`;
        await tx`update chats set last_message_at = now() where id = ${a.chatId}`;

        return { chatId: a.chatId as string, hostId: a.hostId as string, title: a.title as string, msg, waitlisted: finalStatus === 'waitlist', rsvpStatus: finalStatus, promotedMember };
      }

      await tx`insert into activity_members (activity_id, user_id, rsvp_status) values (${id}, ${uid}, ${finalStatus})`;
      await tx`insert into chat_members (chat_id, user_id) values (${a.chatId}, ${uid}) on conflict do nothing`;

      const actionText = finalStatus === 'waitlist' ? ' joined the waitlist' : finalStatus === 'maybe' ? ' is interested (maybe)' : ' joined';
      const [msg] = await tx`insert into messages (chat_id, kind, body)
        values (${a.chatId}, 'system', ${(me.name ?? 'Someone') + actionText})
        returning id, chat_id, kind, body, created_at, sender_id`;
      await tx`update chats set last_message_at = now() where id = ${a.chatId}`;

      return { chatId: a.chatId as string, hostId: a.hostId as string, title: a.title as string, msg, waitlisted: finalStatus === 'waitlist', rsvpStatus: finalStatus, promotedMember: null };
    });

    joinUserToChat(uid, res.chatId);
    if (res.msg) {
      emitToChat(res.chatId, 'message:new', res.msg);
      emitToUser(res.hostId, 'activity:joined', { activityId: id, rsvpStatus: res.rsvpStatus });
      notify([res.hostId], { title: `${res.msg.body} your plan 🎉`, body: res.title, data: { chatId: res.chatId }, tag: res.chatId });
      const noticeKind = res.rsvpStatus === 'maybe' ? 'rsvp_update' : 'join';
      await addNotice([res.hostId], { kind: noticeKind, actorId: uid, activityId: id, chatId: res.chatId, body: `${res.msg.body} ${res.title}` });
    }
    if (res.promotedMember) {
      const [pMsg] = await sql`insert into messages (chat_id, kind, body)
        values (${res.chatId}, 'system', ${`${res.promotedMember.name} was promoted from the waitlist to going! 🎉`})
        returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${res.chatId}`;
      emitToChat(res.chatId, 'message:new', pMsg);
      notify([res.promotedMember.userId], { title: `A spot opened up! 🎉`, body: `You're now going to ${res.title}`, data: { chatId: res.chatId }, tag: res.chatId });
      await addNotice([res.promotedMember.userId], { kind: 'join', actorId: uid, activityId: id, chatId: res.chatId, body: `A spot opened up! You were promoted from the waitlist to going for ${res.title}.` });
    }
    return { ok: true, chatId: res.chatId, waitlisted: res.waitlisted, rsvpStatus: res.rsvpStatus };
  });

  app.post('/activities/:id/leave', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // The leave and the waitlist promotion hold the plan row lock that /join takes (lib/plans.ts). Before, they were separate
    // statements with no lock: a Join landing between them took the freed seat and the promotion then put the plan one over.
    const { a, promoted } = await sql.begin(async tx => {
      const a = await lockPlanForJoin(tx, id);
      if (a.hostId === uid) throw bad('host_cannot_leave', 'Cancel the activity instead.');
      const [deleted] = await tx`delete from activity_members where activity_id = ${id} and user_id = ${uid} returning rsvp_status`;
      await tx`delete from chat_members where chat_id = ${a.chatId} and user_id = ${uid}`;
      // A confirmed attendee leaving moves the earliest waitlisted member up, only into a seat that is really free.
      let promoted: postgres.Row | undefined;
      if (deleted?.rsvpStatus === 'going' && (!a.maxPeople || (await goingCount(tx, id)) < a.maxPeople)) {
        [promoted] = await tx`
          select m.user_id, u.name from activity_members m
          join users u on u.id = m.user_id
          where m.activity_id = ${id} and m.rsvp_status = 'waitlist'
          order by m.joined_at asc limit 1`;
        if (promoted) await tx`update activity_members set rsvp_status = 'going' where activity_id = ${id} and user_id = ${promoted.userId}`;
      }
      return { a, promoted };
    });
    leaveUsersFromChat([uid], a.chatId);

    if (promoted) {
      const [pMsg] = await sql`insert into messages (chat_id, kind, body)
        values (${a.chatId}, 'system', ${`${promoted.name} was promoted from the waitlist to going! 🎉`})
        returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${a.chatId}`;
      emitToChat(a.chatId, 'message:new', pMsg);
      notify([promoted.userId], { title: `A spot opened up! 🎉`, body: `You're now going to ${a.title}`, data: { chatId: a.chatId }, tag: a.chatId });
      await addNotice([promoted.userId], { kind: 'join', actorId: uid, activityId: id, chatId: a.chatId, body: `A spot opened up! You were promoted from the waitlist to going for ${a.title}.` });
    }

    return { ok: true };
  });

  app.post('/activities/:id/cancel', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // Only an active plan changes: cancelling again (a retry, a double tap) must not repeat the notices.
    const [a] = await sql`update activities set status = 'cancelled' where id = ${id} and host_id = ${uid} and status = 'active' returning id, title`;
    if (!a) {
      const [own] = await sql`select 1 from activities where id = ${id} and host_id = ${uid}`;
      if (!own) throw forbidden();
      return { ok: true };
    }
    const [c] = await sql`select id from chats where activity_id = ${id}`;
    const [msg] = await sql`insert into messages (chat_id, kind, body) values (${c.id}, 'system', 'The host cancelled this plan.') returning id, chat_id, kind, body, created_at, sender_id`;
    await sql`update chats set last_message_at = now() where id = ${c.id}`;
    emitToChat(c.id, 'message:new', msg);
    const members = await sql`select user_id from activity_members where activity_id = ${id}`;
    await addNotice(members.map(m => m.userId), { kind: 'cancelled', actorId: uid, activityId: id, chatId: c.id, body: `${a.title} was cancelled by the host` });
    return { ok: true };
  });

  // Host stops (or restarts) new people joining without cancelling for those already in.
  app.post('/activities/:id/close', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { closed } = z.object({ closed: z.boolean() }).parse(req.body ?? {});
    const [a] = await sql`update activities set closed = ${closed} where id = ${id} and host_id = ${uid} and status = 'active' and closed <> ${closed} returning id`;
    if (!a) {
      const [cur] = await sql`select 1 from activities where id = ${id} and host_id = ${uid} and status = 'active'`;
      if (!cur) throw forbidden();
      return { ok: true, closed };
    }
    const [c] = await sql`select id from chats where activity_id = ${id}`;
    const [msg] = await sql`insert into messages (chat_id, kind, body) values (${c.id}, 'system', ${closed ? 'The host closed this plan to new people.' : 'The host reopened this plan to new people.'}) returning id, chat_id, kind, body, created_at, sender_id`;
    await sql`update chats set last_message_at = now() where id = ${c.id}`;
    emitToChat(c.id, 'message:new', msg);
    return { ok: true, closed };
  });

  // Plan photo album (after plan starts/ends)
  app.get('/activities/:id/photos', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const photos = await sql`
      select ap.id, ap.url, ap.caption, ap.created_at,
        json_build_object('id', u.id, 'name', u.name, 'photoUrl', u.photo_url) as user,
        coalesce((select count(*)::int from activity_photo_reactions apr where apr.photo_id = ap.id), 0) as reactions_count,
        (select apr.emoji from activity_photo_reactions apr where apr.photo_id = ap.id and apr.user_id = ${uid} limit 1) as my_reaction,
        coalesce(
          (select json_agg(json_build_object('emoji', r.emoji, 'count', r.c))
           from (
             select emoji, count(*)::int as c
             from activity_photo_reactions
             where photo_id = ap.id
             group by emoji
             order by c desc
           ) r),
          '[]'::json
        ) as reactions
      from activity_photos ap
      join users u on u.id = ap.user_id
      where ap.activity_id = ${id}
      order by ap.created_at asc`;
    return { photos };
  });

  app.post('/activities/:id/photos', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { url, caption } = z.object({
      url: z.string().url(),
      caption: z.string().max(200).optional().nullable(),
    }).parse(req.body);

    const [member] = await sql`select 1 from activity_members where activity_id = ${id} and user_id = ${uid}`;
    if (!member) throw forbidden('not_a_member', 'Only members of this plan can add photos.');

    const [a] = await sql`select starts_at, status from activities where id = ${id}`;
    if (!a) throw notFound('activity_not_found');
    if (a.status === 'cancelled') throw bad('activity_cancelled', 'Cannot add photos to a cancelled plan.');

    const existing = await sql`select count(*)::int as count from activity_photos where activity_id = ${id} and user_id = ${uid}`;
    if ((existing[0]?.count ?? 0) >= 10) throw bad('photo_limit_reached', 'You can upload up to 10 photos per plan.');

    const [photo] = await sql`
      insert into activity_photos (activity_id, user_id, url, caption)
      values (${id}, ${uid}, ${url}, ${caption ?? null})
      returning id, activity_id, user_id, url, caption, created_at`;

    const [c] = await sql`select id from chats where activity_id = ${id}`;
    if (c) {
      const [u] = await sql`select name from users where id = ${uid}`;
      const [msg] = await sql`insert into messages (chat_id, kind, body) values (${c.id}, 'system', ${`${u?.name || 'A traveler'} added a photo to the plan album.`}) returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${c.id}`;
      emitToChat(c.id, 'message:new', msg);
    }

    return { ok: true, photo };
  });

  app.delete('/activities/:id/photos/:photoId', async req => {
    const uid = await requireUser(req);
    const { id, photoId } = z.object({ id: z.string().uuid(), photoId: z.string().uuid() }).parse(req.params);
    const [a] = await sql`select host_id from activities where id = ${id}`;
    const [deleted] = await sql`
      delete from activity_photos
      where id = ${photoId} and activity_id = ${id} and (user_id = ${uid} or ${a?.hostId === uid})
      returning id`;
    if (!deleted) throw notFound('photo_not_found');
    return { ok: true };
  });

  // Toggle reaction to a photo in the plan album
  app.post('/activities/:id/photos/:photoId/react', async req => {
    const uid = await requireUser(req);
    const { id, photoId } = z.object({ id: z.string().uuid(), photoId: z.string().uuid() }).parse(req.params);
    const { emoji } = z.object({
      emoji: z.enum(['❤️', '🔥', '🙌', '👏', '😍']),
    }).parse(req.body);

    const [photo] = await sql`
      select ap.id, ap.user_id, ap.activity_id, a.title, a.place_name
      from activity_photos ap
      join activities a on a.id = ap.activity_id
      where ap.id = ${photoId} and ap.activity_id = ${id}`;
    if (!photo) throw notFound('photo_not_found');

    const [existing] = await sql`
      select emoji from activity_photo_reactions
      where photo_id = ${photoId} and user_id = ${uid}`;

    let reacted = false;
    let currentEmoji: string | null = null;

    if (existing) {
      if (existing.emoji === emoji) {
        // Toggle off
        await sql`delete from activity_photo_reactions where photo_id = ${photoId} and user_id = ${uid}`;
        reacted = false;
        currentEmoji = null;
      } else {
        // Update emoji
        await sql`
          update activity_photo_reactions
          set emoji = ${emoji}, created_at = now()
          where photo_id = ${photoId} and user_id = ${uid}`;
        reacted = true;
        currentEmoji = emoji;
      }
    } else {
      await sql`
        insert into activity_photo_reactions (photo_id, user_id, emoji)
        values (${photoId}, ${uid}, ${emoji})`;
      reacted = true;
      currentEmoji = emoji;

      if (photo.userId !== uid) {
        const [reactor] = await sql`select name from users where id = ${uid}`;
        await addNotice([photo.userId], {
          kind: 'photo_reaction',
          actorId: uid,
          activityId: id,
          body: `${reactor?.name || 'A traveler'} reacted ${emoji} to your photo in "${photo.title || photo.placeName}".`,
        }).catch(() => {});
      }
    }

    const [stats] = await sql`
      select
        coalesce((select count(*)::int from activity_photo_reactions where photo_id = ${photoId}), 0) as count,
        coalesce(
          (select json_agg(json_build_object('emoji', r.emoji, 'count', r.c))
           from (
             select emoji, count(*)::int as c
             from activity_photo_reactions
             where photo_id = ${photoId}
             group by emoji
             order by c desc
           ) r),
          '[]'::json
        ) as reactions`;

    return {
      ok: true,
      reacted,
      myReaction: currentEmoji,
      reactionsCount: stats?.count ?? 0,
      reactions: stats?.reactions ?? [],
    };
  });

  // Check in at the meetup (within 350m, 30m before to 6h after start)
  app.post('/activities/:id/checkin', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { lat, lng } = z.object({ lat: z.number(), lng: z.number() }).parse(req.body);

    const [a] = await sql`
      select a.id, a.place_name, a.host_id, a.starts_at, c.id as chat_id,
        ST_DWithin(a.location, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, 350) as nearby
      from activities a
      join chats c on c.activity_id = a.id
      where a.id = ${id} and a.status = 'active'`;
    if (!a) throw notFound('activity_not_found');

    const starts = new Date(a.startsAt).getTime();
    const now = Date.now();
    if (now < starts - 30 * 60_000 || now > starts + 6 * 3600_000) {
      throw bad('checkin_window', 'Check-in is available from 30 minutes before start until 6 hours after.');
    }
    if (!a.nearby) {
      throw bad('too_far', 'You need to be within 300 meters of the meeting point to check in.');
    }

    const [member] = await sql`
      update activity_members
      set checked_in_at = coalesce(checked_in_at, now())
      where activity_id = ${id} and user_id = ${uid}
      returning checked_in_at`;
    if (!member) throw forbidden('not_a_member', 'Only confirmed attendees can check in.');

    const [u] = await sql`select name from users where id = ${uid}`;
    const [msg] = await sql`insert into messages (chat_id, kind, body)
      values (${a.chatId}, 'system', ${`📍 ${u?.name || 'A traveler'} arrived and checked in at ${a.placeName}!`})
      returning id, chat_id, kind, body, created_at, sender_id`;
    await sql`update chats set last_message_at = now() where id = ${a.chatId}`;
    emitToChat(a.chatId, 'message:new', msg);
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${uid}, 'plan_checked_in', ${sql.json({ activityId: id } as any)})`.catch(() => {});

    return { ok: true, checkedIn: true };
  });

  // Feature 11: Report running late
  app.post('/activities/:id/running-late', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      mins: z.number().int().min(1).max(180).optional(),
      minutes: z.number().int().min(1).max(180).optional(),
      note: z.string().max(140).optional().nullable(),
    }).parse(req.body ?? {});

    const delayMins = body.mins ?? body.minutes ?? 15;

    const [a] = await sql`
      select a.id, a.title, a.status, a.starts_at, a.place_name, c.id as chat_id
      from activities a
      left join chats c on c.activity_id = a.id
      where a.id = ${id}
    `;
    if (!a) throw notFound();
    if (a.status !== 'active') throw bad('not_active', 'Plan is not active.');

    const [m] = await sql`
      select rsvp_status, checked_in_at from activity_members
      where activity_id = ${id} and user_id = ${uid}
    `;
    if (!m) throw forbidden('not_a_member', 'You are not a member of this plan.');
    if (m.rsvpStatus !== 'going') throw bad('not_going', 'Only confirmed attendees can report running late.');
    // Only around the start: 3 of 7 real hosts tapped it within 2 minutes of creating a plan that started hours or days later,
    // and the group got "running 15 minutes late" for a plan nowhere near starting.
    const startMs = new Date(a.startsAt).getTime(), nowMs = Date.now();
    if (nowMs < startMs - RUNNING_LATE_WINDOW.beforeMins * 60_000) throw bad('running_late_too_early', `You can tell the group you're running late from ${RUNNING_LATE_WINDOW.beforeMins} minutes before the plan starts.`);
    if (nowMs > startMs + RUNNING_LATE_WINDOW.afterMins * 60_000) throw bad('running_late_over', 'This plan started a while ago.');

    const cleanNote = body.note?.trim() || null;
    await sql`
      update activity_members
      set running_late_mins = ${delayMins},
          running_late_at = now(),
          running_late_note = ${cleanNote}
      where activity_id = ${id} and user_id = ${uid}
    `;

    const [u] = await sql`select name from users where id = ${uid}`;
    const name = u?.name || 'A traveler';
    const noteText = cleanNote ? ` ("${cleanNote}")` : '';
    const bodyText = `🏃 ${name} is running about ${delayMins} minutes late! See you shortly.${noteText}`;

    if (a.chatId) {
      const [msg] = await sql`insert into messages (chat_id, kind, body)
        values (${a.chatId}, 'system', ${bodyText})
        returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${a.chatId}`;
      emitToChat(a.chatId, 'message:new', msg);
    }

    // Send notifications to other attendees
    const attendees = await sql`
      select user_id from activity_members
      where activity_id = ${id} and rsvp_status = 'going' and user_id <> ${uid}
    `;
    const recipientIds = attendees.map((att: any) => att.userId || att.user_id);
    if (recipientIds.length > 0) {
      await addNotice(recipientIds, {
        kind: 'running_late',
        actorId: uid,
        activityId: id,
        chatId: a.chatId,
        body: `${name} is running ~${delayMins}m late for "${a.title}"${noteText}`,
      });
    }

    return { ok: true, minutes: delayMins, runningLateMins: delayMins, runningLateNote: cleanNote };
  });

  // Clear running late status (e.g. arrived or on time)
  app.delete('/activities/:id/running-late', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [a] = await sql`
      select a.id, a.title, a.status, c.id as chat_id
      from activities a
      left join chats c on c.activity_id = a.id
      where a.id = ${id}
    `;
    if (!a) throw notFound();

    await sql`
      update activity_members
      set running_late_mins = null,
          running_late_at = null,
          running_late_note = null
      where activity_id = ${id} and user_id = ${uid}
    `;

    const [u] = await sql`select name from users where id = ${uid}`;
    const name = u?.name || 'A traveler';
    const bodyText = `✅ ${name} has arrived / is on time!`;

    if (a.chatId) {
      const [msg] = await sql`insert into messages (chat_id, kind, body)
        values (${a.chatId}, 'system', ${bodyText})
        returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${a.chatId}`;
      emitToChat(a.chatId, 'message:new', msg);
    }

    return { ok: true };
  });

  // Rate the host after meetup starts
  app.post('/activities/:id/rate', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { rating, tags, feedback } = z.object({
      rating: z.number().int().min(1).max(5),
      tags: z.array(z.string().max(30)).max(6).default([]),
      feedback: z.string().max(500).optional().nullable(),
    }).parse(req.body);

    const [a] = await sql`select host_id, starts_at, status from activities where id = ${id}`;
    if (!a) throw notFound('activity_not_found');
    if (a.hostId === uid) throw bad('cannot_rate_self', 'Hosts cannot rate their own meetup.');

    const [member] = await sql`select 1 from activity_members where activity_id = ${id} and user_id = ${uid}`;
    if (!member) throw forbidden('not_a_member', 'Only meetup attendees can rate the host.');

    if (new Date(a.startsAt).getTime() > Date.now()) {
      throw bad('too_early', 'You can rate the host once the meetup has started.');
    }

    const [rated] = await sql`
      insert into activity_ratings (activity_id, rater_id, host_id, rating, tags, feedback)
      values (${id}, ${uid}, ${a.hostId}, ${rating}, ${tags}, ${feedback ?? null})
      on conflict (activity_id, rater_id) do update set
        rating = excluded.rating, tags = excluded.tags, feedback = excluded.feedback, created_at = now()
      returning id, rating, tags, feedback`;

    return { ok: true, rated };
  });

  app.get('/activities/:id/ratings', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [a] = await sql`select host_id from activities where id = ${id}`;
    if (!a) throw notFound('activity_not_found');
    if (a.hostId !== uid) throw forbidden('hosts_only', 'Only the host can view private ratings for this meetup.');

    const ratings = await sql`
      select ar.id, ar.rating, ar.tags, ar.feedback, ar.created_at,
        json_build_object('name', u.name, 'photoUrl', u.photo_url) as rater
      from activity_ratings ar
      join users u on u.id = ar.rater_id
      where ar.activity_id = ${id}
      order by ar.created_at desc`;
    return { ratings };
  });

  // Travelers around you: people who opened the app nearby in the last 3 days.
  app.get('/travelers/nearby', async req => {
    const uid = await requireUser(req);
    const q = z.object({
      lat: z.coerce.number(),
      lng: z.coerce.number(),
      radiusKm: z.coerce.number().max(100).default(30),
      women_only: z.coerce.boolean().optional()
    }).parse(req.query);
    const [me] = await sql`select interests, gender from users where id = ${uid}`;
    if (q.women_only && me?.gender !== 'woman') {
      throw forbidden('women_only', 'Women-only traveler discovery is reserved for women travelers.');
    }
    const rows = await sql`select * from (
      select u.id, u.name, u.photo_url, u.home_country, u.verified, u.interests,
        date_part('year', age(u.birthdate))::int as age,
        ST_Distance(u.location, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography)::int as distance_m,
        cardinality(array(select unnest(u.interests) intersect select unnest(${me?.interests ?? []}::text[]))) as shared,
        u.location_at > now() - interval '30 minutes' as online,
        ${plusOf('u')} as plus
      from users u
      where u.id <> ${uid} and u.onboarded and u.deleted_at is null and u.banned_at is null
        and (u.snoozed_until is null or u.snoozed_until <= now())
        and u.location_at > now() - interval '3 days'
        and (not ${!!q.women_only} or u.gender = 'woman')
        and ST_DWithin(u.location, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography, ${q.radiusKm * 1000})
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
      ) x
      -- Plus members get seen first, but only among people at a similar distance (lib/plus.ts PLUS_RANK).
      order by online desc, shared desc, floor(distance_m / ${PLUS_RANK.distanceBandM}), plus desc, distance_m asc
      limit 200`;
    // Distance is rounded to 500 m so nobody can be triangulated.
    return { count: rows.length, travelers: rows.map(r => ({ ...r, distanceM: Math.max(500, Math.round(r.distanceM / 500) * 500) })) };
  });

  // Share links to a plan (POST /activities/:id/share, GET /safe/:token and turning them off) are in routes/shares.ts.

  // In-meetup SOS emergency alert
  app.post('/activities/:id/sos', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { lat, lng, note } = z.object({
      lat: z.number().optional(),
      lng: z.number().optional(),
      note: z.string().max(500).optional()
    }).parse(req.body ?? {});

    const [a] = await sql`
      select a.id, a.title, a.place_name, a.place_address, a.city, a.starts_at,
        ST_Y(a.location::geometry) as plan_lat, ST_X(a.location::geometry) as plan_lng,
        exists(select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${uid}) as is_member,
        a.host_id = ${uid} as is_host
      from activities a where a.id = ${id}`;
    if (!a) throw notFound('activity_not_found');
    if (!a.isMember && !a.isHost) throw forbidden('not_in_plan');

    const [user] = await sql`
      select id, name, email, home_country, emergency_contact_name, emergency_contact_phone
      from users where id = ${uid}`;

    const alertLat = lat ?? a.planLat;
    const alertLng = lng ?? a.planLng;

    await sql`
      insert into safety_alerts (activity_id, user_id, latitude, longitude, note)
      values (${id}, ${uid}, ${alertLat}, ${alertLng}, ${note ?? null})`;

    const mapUrl = `https://www.google.com/maps/search/?api=1&query=${alertLat},${alertLng}`;
    // Local numbers for where the plan is (the traveller is abroad, so never their home country).
    const emergencyNumbers = getEmergencyNumbers(await planCountry(a.planLat, a.planLng));

    // The only email goes to the person who pressed SOS. Nobody else is contacted by Tablamigo: the app hands them
    // ready-made WhatsApp/SMS messages for their trusted contacts instead, which they send themselves.
    let emailedYou = false;
    if (user?.email) {
      try {
        const e = render(safetyAlert({
          userName: user.name || 'Traveler',
          planTitle: a.title,
          placeName: a.placeName,
          city: a.city,
          placeAddress: a.placeAddress,
          mapUrl,
          note,
          emergencyNumbers
        }), { unsubscribeUrl: null });
        await sendMail({
          to: user.email,
          subject: e.subject,
          html: e.html,
          text: e.text
        });
        emailedYou = true;
      } catch (err) {
        console.error('Failed to send SOS email dispatch:', err);
      }
    }

    const contacts = await sql`
      select id, name, phone, relationship
      from user_trusted_contacts
      where user_id = ${uid}
      order by created_at asc`;

    const dispatches = contacts.map(c => {
      const cleanPhone = c.phone.replace(/[^0-9+]/g, '');
      const locText = mapUrl ? `\n📍 Current GPS Map: ${mapUrl}` : '';
      const planText = `\n🗺️ Meetup: "${a.title}" at ${a.placeName}, ${a.city}`;
      const noteText = note ? `\n💬 Note: ${note}` : '';
      const msg = `🚨 EMERGENCY ALERT from ${user?.name || 'Traveler'} on Tablamigo:${locText}${planText}${noteText}\n\nPlease check in or contact local authorities if unavailable.`;
      const encodedMsg = encodeURIComponent(msg);
      return {
        contactId: c.id,
        name: c.name,
        phone: c.phone,
        relationship: c.relationship,
        whatsappUrl: `https://api.whatsapp.com/send?phone=${cleanPhone.replace(/^\+/, '')}&text=${encodedMsg}`,
        smsUrl: `sms:${cleanPhone}?body=${encodedMsg}`,
        message: msg
      };
    });

    return {
      ok: true,
      // What actually happened: the alert is logged and (when it sent) a copy went to the user's own email.
      // No contact is messaged by the server, so these stay false until something really sends to them.
      alertLogged: true,
      emailedYou,
      emergencyContactNotified: false,
      contactsNotified: 0,
      emergencyContact: {
        name: user?.emergencyContactName ?? null,
        phone: user?.emergencyContactPhone ?? null
      },
      dispatches,
      emergencyNumbers,
      venue: {
        name: a.placeName,
        address: a.placeAddress,
        city: a.city,
        mapUrl
      }
    };
  });

  // Advance recurring activity to next session
  app.post('/activities/:id/advance-recurrence', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [a] = await sql`select host_id, recurrence from activities where id = ${id}`;
    if (!a) throw notFound();
    if (a.hostId !== uid) {
      const [u] = await sql`select role from users where id = ${uid}`;
      if (u?.role !== 'admin') throw forbidden('host_only', 'Only the host or admin can advance a recurring series.');
    }
    return await generateNextOccurrence(id);
  });

  // Update recurring series settings (pause/resume automatic next generation or change recurrence)
  app.patch('/activities/:id/recurrence', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = z.object({
      autoAdvance: z.boolean().optional(),
      recurrence: z.enum(['weekly', 'biweekly', 'monthly']).optional().nullable(),
    }).parse(req.body);

    const [act] = await sql`select id, host_id, series_id, recurrence, auto_advance as "autoAdvance" from activities where id = ${id}`;
    if (!act) throw notFound();
    if (act.hostId !== uid) throw forbidden('host_only', 'Only the host can modify series recurrence settings.');

    const updates: any = {};
    if (body.autoAdvance !== undefined) updates.auto_advance = body.autoAdvance;
    if (body.recurrence !== undefined) updates.recurrence = body.recurrence;

    if (Object.keys(updates).length > 0) {
      await sql`update activities set ${sql(updates)} where id = ${id}`;
      if (act.seriesId && body.autoAdvance !== undefined) {
        await sql`update activities set auto_advance = ${body.autoAdvance} where series_id = ${act.seriesId} and starts_at > now()`;
      }
    }

    const [updated] = await sql`select id, recurrence, auto_advance as "autoAdvance" from activities where id = ${id}`;
    return { ok: true, activity: updated };
  });

  // Series overview: list all sessions in the series
  app.get('/activities/:id/series', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [act] = await sql`select host_id, series_id, recurrence, auto_advance as "autoAdvance" from activities where id = ${id}`;
    if (!act) throw notFound();
    const seriesId = act.seriesId || id;
    const sessions = await sql`
      select a.id, a.title, a.emoji, a.starts_at, a.occurrence_number, a.status, a.closed,
        (a.id = ${id}) as is_current,
        (select count(*)::int from activity_members m where m.activity_id = a.id and m.rsvp_status = 'going') as going_count,
        exists(select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${uid} and m.rsvp_status = 'going') as joined
      from activities a
      where a.series_id = ${seriesId} or a.id = ${seriesId}
      order by a.occurrence_number asc, a.starts_at asc
    `;
    return {
      seriesId,
      recurrence: act.recurrence,
      autoAdvance: act.autoAdvance,
      isHost: act.hostId === uid,
      totalSessions: sessions.length,
      sessions
    };
  });

  // Admin runner: process due recurring activities (the scheduler does this every minute; lib/plan-jobs.ts)
  app.post('/admin/activities/process-recurring', async req => {
    await requireAdmin(req);
    return { ok: true, ...(await processDueRecurring()) };
  });

  // Feature 15: Paid & Ticketed Events (Workshops, Tours, Masterclasses). Off unless config.features.paidEvents.

  /**
   * Everything /join checks, for a ticket buyer: an active plan that hasn't ended, not their own, women-only for women,
   * no block either way with the host, not closed, and a ticket and a place left. `db` is the caller's transaction
   * when the plan row is locked.
   */
  async function assertCanBuyTicket(db: typeof sql, id: string, uid: string, lock = false) {
    const [act] = await db`
      select a.id, a.title, a.host_id as "hostId", a.is_paid as "isPaid", a.status, a.closed, a.starts_at as "startsAt",
             a.women_only as "womenOnly", a.max_people as "maxPeople",
             a.ticket_price_paise as "ticketPricePaise", a.ticket_currency as "ticketCurrency",
             a.max_tickets as "maxTickets", a.tickets_sold as "ticketsSold", c.id as "chatId"
      from activities a left join chats c on c.activity_id = a.id
      where a.id = ${id} ${lock ? db`for update of a` : db``}`;
    if (!act || act.status !== 'active') throw notFound();
    act.going = await goingCount(db, id);
    if (!act.isPaid || !act.ticketPricePaise) throw bad('not_ticketed', 'This activity is free and does not require tickets.');
    if (act.hostId === uid) throw bad('cannot_buy_own_event', 'Hosts cannot purchase tickets to their own event.');
    if (new Date(act.startsAt).getTime() < Date.now() - 2 * 3600_000) throw bad('event_over', 'This event has already ended.');
    const [me] = await db`select gender, onboarded from users where id = ${uid}`;
    if (!me?.onboarded) throw forbidden('profile_incomplete');
    if (act.womenOnly && me.gender !== 'woman') throw forbidden('women_only');
    const [blocked] = await db`select 1 from blocks where (blocker_id = ${act.hostId} and blocked_id = ${uid}) or (blocker_id = ${uid} and blocked_id = ${act.hostId})`;
    if (blocked) throw forbidden();
    const [member] = await db`select 1 from activity_members where activity_id = ${id} and user_id = ${uid}`;
    if (act.closed && !member) throw bad('event_closed', 'The host has closed this event to new attendees.');
    const [existing] = await db`select 1 from activity_tickets where activity_id = ${id} and user_id = ${uid} and status in ('valid', 'used')`;
    if (existing) throw bad('already_has_ticket', 'You already have an active ticket for this event.');
    if (act.maxTickets && act.ticketsSold >= act.maxTickets) throw bad('tickets_sold_out', 'Tickets for this event are sold out.');
    if (act.maxPeople && act.going >= act.maxPeople) throw bad('full', 'This plan is full.');
    return act;
  }

  // Initiate purchase of a ticket for a paid/ticketed activity
  app.post('/activities/:id/ticket/order', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!config.features.paidEvents) throw paidEventsOff();
    const act = await assertCanBuyTicket(sql, id, uid);
    // No mock orders: without Razorpay there is no way to pay, so there is nothing to order.
    if (!razorpayOn()) throw bad('payments_unavailable', 'Payments are not available yet.');
    try {
      // The order's notes (service, user_id, activity_id) are what /ticket/verify checks the payment against.
      const order = await createTicketOrder(uid, id, act.ticketPricePaise, act.ticketCurrency);
      return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: config.razorpay.keyId, activityId: id, title: act.title };
    } catch (e: any) {
      req.log.error(e, 'razorpay ticket order failed');
      throw bad('payment_gateway_error', 'Unable to initiate payment with Razorpay.');
    }
  });

  // Issue a ticket for a Razorpay payment the server has verified: Checkout's signature over order|payment, and the
  // order fetched from Razorpay must be ours, made by /ticket/order for this user and this plan, for this price.
  // Never issues anything without that (no mock or test fallback, whatever keys are loaded).
  app.post('/activities/:id/ticket/verify', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    if (!config.features.paidEvents) throw paidEventsOff();
    const parsed = z.object({
      orderId: z.string().min(1).max(64),
      paymentId: z.string().min(1).max(64),
      signature: z.string().min(1).max(256),
    }).safeParse(req.body ?? {});
    if (!parsed.success) throw bad('payment_required', 'A completed payment is needed for a ticket.');
    const b = parsed.data;
    if (!razorpayOn()) throw bad('payments_unavailable', 'Payments are not available yet.');

    const ticketCols = sql`id, ticket_code as "ticketCode", price_paise as "pricePaise", host_payout_paise as "hostPayoutPaise",
      currency, status, created_at as "createdAt"`;
    const [replay] = await sql`select ${ticketCols}, user_id as "userId", activity_id as "activityId" from activity_tickets where razorpay_payment_id = ${b.paymentId}`;
    if (replay) {
      // A retry of the same payment gets the same ticket; the payment can't buy anything else.
      if (replay.userId !== uid || replay.activityId !== id) throw bad('payment_already_used');
      const { userId: _u, activityId: _a, ...ticket } = replay;
      return { ok: true, ticket };
    }
    // Refuse before anything is captured, so a buyer who can't attend is never charged.
    await assertCanBuyTicket(sql, id, uid);

    const res = await sql.begin(async tx => {
      // The plan row stays locked from the re-check to the ticket insert: no overselling, no duplicate tickets.
      const act = await assertCanBuyTicket(tx as unknown as typeof sql, id, uid, true);
      try {
        await verifyRazorpayTicket(uid, id, b.orderId, b.paymentId, b.signature, act.ticketPricePaise);
      } catch (e) {
        // Our own check codes (bad_signature, not_our_order, ...) go back as the reason; gateway error text does not.
        const reason = /^[a-z_]+$/.test((e as Error).message) ? (e as Error).message : 'gateway_error';
        throw new HttpError(400, 'payment_not_verified', 'We could not confirm this payment.', { reason });
      }
      // 10% platform fee, 90% host share
      const pricePaise = act.ticketPricePaise as number;
      const platformFeePaise = Math.round(pricePaise * 0.10);
      const ticketCode = `TM-TKT-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
      const [t] = await tx`
        insert into activity_tickets
          (activity_id, user_id, ticket_code, price_paise, platform_fee_paise, host_payout_paise,
           currency, status, payment_platform, razorpay_order_id, razorpay_payment_id)
        values
          (${id}, ${uid}, ${ticketCode}, ${pricePaise}, ${platformFeePaise}, ${pricePaise - platformFeePaise},
           ${act.ticketCurrency}, 'valid', 'razorpay', ${b.orderId}, ${b.paymentId})
        returning ${ticketCols}`;
      await tx`update activities set tickets_sold = tickets_sold + 1 where id = ${id}`;
      await tx`
        insert into activity_members (activity_id, user_id, rsvp_status)
        values (${id}, ${uid}, 'going')
        on conflict (activity_id, user_id) do update set rsvp_status = 'going'`;
      if (act.chatId) await tx`insert into chat_members (chat_id, user_id) values (${act.chatId}, ${uid}) on conflict do nothing`;
      return { ticket: t, act };
    });
    const { ticket, act } = res;
    // Same key as the forwarded payment.captured / order.paid for this payment (lib/razorpay-webhook.ts).
    ownerSaleAlert(`rzp:pay:${b.paymentId}`, () => ({
      kind: 'ticket_purchase', provider: 'razorpay', userId: uid, product: razorpayProduct('activity_ticket'),
      amountMinor: Number(ticket.pricePaise), currency: ticket.currency, ids: { paymentId: b.paymentId, orderId: b.orderId }, test: razorpayTest(),
      details: [['Event', act.title], ['Host share', `${Number(ticket.hostPayoutPaise) / 100} ${ticket.currency}`]],
    }));

    if (act.chatId) {
      joinUserToChat(uid, act.chatId);
      emitToChat(act.chatId, 'chat:members', { activityId: id, memberCount: act.ticketsSold + 1 });
    }

    // Send inbox notice to host
    const [buyer] = await sql`select name from users where id = ${uid}`;
    await addNotice([act.hostId], {
      kind: 'ticket_purchased',
      actorId: uid,
      activityId: id,
      body: `${buyer?.name || 'Someone'} booked a ticket (${ticket.ticketCode}) for "${act.title}"!`,
    });

    emitToUser(act.hostId, 'ticket:sold', { activityId: id, ticketCode: ticket.ticketCode });

    return { ok: true, ticket };
  });

  // Host ticket management: list all sold tickets, revenue, and check-in status
  app.get('/activities/:id/tickets', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [act] = await sql`select id, title, host_id as "hostId", is_paid as "isPaid", ticket_price_paise as "ticketPricePaise", tickets_sold as "ticketsSold" from activities where id = ${id}`;
    if (!act) throw notFound();
    if (act.hostId !== uid) throw forbidden('host_only', 'Only the host can view tickets for this meetup.');

    const tickets = await sql`
      select t.id, t.ticket_code as "ticketCode", t.price_paise as "pricePaise",
             t.host_payout_paise as "hostPayoutPaise", t.currency, t.status,
             t.created_at as "createdAt", t.used_at as "usedAt",
             u.id as "userId", u.name as "userName", u.photo_url as "userPhotoUrl", u.home_country as "userCountry"
      from activity_tickets t
      join users u on u.id = t.user_id
      where t.activity_id = ${id}
      order by t.created_at desc`;

    const totalSold = tickets.length;
    const totalRevenuePaise = tickets.reduce((acc, t) => acc + Number(t.pricePaise), 0);
    const hostEarningsPaise = tickets.reduce((acc, t) => acc + Number(t.hostPayoutPaise), 0);

    return {
      activityId: id,
      title: act.title,
      totalSold,
      totalRevenuePaise,
      hostEarningsPaise,
      tickets,
    };
  });

  // Host validates and checks in a ticket at the door
  app.post('/activities/:id/tickets/:ticketId/check-in', async req => {
    const uid = await requireUser(req);
    const { id, ticketId } = z.object({ id: z.string().uuid(), ticketId: z.string().uuid() }).parse(req.params);
    const [act] = await sql`select host_id as "hostId" from activities where id = ${id}`;
    if (!act) throw notFound();
    if (act.hostId !== uid) throw forbidden('host_only', 'Only the host can check in tickets.');

    const [ticket] = await sql`
      select id, ticket_code as "ticketCode", status, user_id as "userId"
      from activity_tickets where id = ${ticketId} and activity_id = ${id}`;
    if (!ticket) throw notFound('ticket_not_found');
    if (ticket.status === 'used') throw bad('ticket_already_used', 'This ticket has already been used.');
    if (ticket.status !== 'valid') throw bad('ticket_invalid', `Ticket is ${ticket.status}.`);

    await sql.begin(async tx => {
      await tx`
        update activity_tickets
        set status = 'used', used_at = now(), checked_in_by = ${uid}
        where id = ${ticketId}`;

      await tx`
        update activity_members
        set checked_in_at = now()
        where activity_id = ${id} and user_id = ${ticket.userId}`;
    });

    emitToUser(ticket.userId, 'ticket:checked_in', { activityId: id, ticketCode: ticket.ticketCode });

    return { ok: true, ticketCode: ticket.ticketCode, status: 'used', usedAt: new Date().toISOString() };
  });

  // Traveler's purchased tickets list
  app.get('/me/tickets', async req => {
    const uid = await requireUser(req);
    const tickets = await sql`
      select t.id, t.ticket_code as "ticketCode", t.price_paise as "pricePaise",
             t.currency, t.status, t.created_at as "createdAt", t.used_at as "usedAt",
             a.id as "activityId", a.title as "activityTitle", a.emoji, a.category,
             a.starts_at as "startsAt", a.place_name as "placeName", a.city,
             h.id as "hostId", h.name as "hostName", h.photo_url as "hostPhotoUrl"
      from activity_tickets t
      join activities a on a.id = t.activity_id
      join users h on h.id = a.host_id
      where t.user_id = ${uid}
      order by a.starts_at desc`;

    return { tickets };
  });

  // Feature 11: Process due 2h and 15m reminders
  app.post('/admin/activities/process-reminders', async req => {
    await requireAdmin(req);
    const res = await processPlanReminders();
    return { ok: true, ...res };
  });
}
