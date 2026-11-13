import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { assertClean } from '../lib/moderation.js';
import { addNotice } from '../lib/inbox.js';
import { bad, forbidden, notFound } from '../lib/errors.js';
import { cityFor } from '../lib/geo.js';
import { isOwnUpload } from '../lib/storage.js';

// Moments keep only a neighbourhood, never the exact spot: points are snapped to a 0.01° grid (about 1 km) when stored,
// and the nearby search never looks closer than MIN_RADIUS_KM, so repeated small searches can't pin anyone down.
const COARSE = 100;
const coarse = (x: number) => Math.round(x * COARSE) / COARSE;
export const MIN_RADIUS_KM = 5;

export default async function moments(app: FastifyInstance) {
  // Feed listing with scope, city, nearby, and cursor pagination
  app.get('/moments', async req => {
    let uid: string | null = null;
    try { uid = await requireUser(req); } catch { /* anonymous allowed */ }

    const q = z.object({
      scope: z.enum(['all', 'nearby', 'city', 'following']).default('all'),
      city: z.string().trim().max(100).optional(),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
      radiusKm: z.coerce.number().max(200).default(50).transform(r => Math.max(MIN_RADIUS_KM, r)),
      cursor: z.string().datetime().optional(),
      limit: z.coerce.number().min(1).max(50).default(25),
    }).parse(req.query);

    const rows = await sql`
      select
        m.id, m.user_id as "userId", m.city, m.country_code as "countryCode",
        m.image_url as "imageUrl", m.caption, m.category, m.activity_id as "activityId",
        m.created_at as "createdAt",
        u.name as "userName", u.photo_url as "userPhoto", u.home_country as "userCountry",
        u.verified as "userVerified",
        coalesce(u.boosted_until > now(), false) as "isBoosted",
        a.title as "activityTitle",
        (select count(*)::int from moment_likes ml where ml.moment_id = m.id) as "likesCount",
        (select count(*)::int from moment_comments mc where mc.moment_id = m.id and mc.deleted_at is null) as "commentsCount",
        case when ${uid}::uuid is not null then exists(select 1 from moment_likes ml where ml.moment_id = m.id and ml.user_id = ${uid}::uuid) else false end as "likedByMe"
      from moments m
      join users u on u.id = m.user_id
      left join activities a on a.id = m.activity_id
      where m.deleted_at is null
        and u.deleted_at is null
        and u.banned_at is null
        and (${q.cursor ?? null}::timestamptz is null or m.created_at < ${q.cursor ?? null}::timestamptz)
        and (${q.city ?? null}::text is null or m.city ilike ${q.city ?? null})
        and (
          ${q.scope !== 'nearby' || q.lat === undefined || q.lng === undefined}
          or (m.location is not null and ST_DWithin(m.location, ST_SetSRID(ST_MakePoint(${q.lng ?? 0}, ${q.lat ?? 0}), 4326)::geography, ${q.radiusKm * 1000}))
        )
        and (
          ${q.scope !== 'following' || uid === null}
          or exists(select 1 from connections c where c.user_id = ${uid}::uuid and c.friend_id = m.user_id)
        )
        and (
          ${uid}::uuid is null
          or not exists(select 1 from blocks b where (b.blocker_id = ${uid}::uuid and b.blocked_id = m.user_id) or (b.blocker_id = m.user_id and b.blocked_id = ${uid}::uuid))
        )
      order by m.created_at desc
      limit ${q.limit + 1}
    `;

    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const nextCursor = hasMore ? items[items.length - 1].createdAt : null;

    return { moments: items, nextCursor };
  });

  // Post a new travel moment
  app.post('/moments', async req => {
    const uid = await requireUser(req);
    const b = z.object({
      imageUrl: z.string().url(),
      caption: z.string().trim().min(1).max(1000),
      city: z.string().trim().max(100).optional(),
      countryCode: z.string().length(2).toUpperCase().optional(),
      category: z.enum(['general', 'meetup', 'tip', 'question', 'recommendation']).default('general'),
      activityId: z.string().uuid().optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
    }).parse(req.body);

    // Only a photo the poster uploaded here (the app's chat-photo upload): any other URL would make every reader's
    // browser fetch a host the poster chose.
    if (!isOwnUpload(b.imageUrl, uid, ['chat', 'avatar'])) throw bad('bad_photo', 'Upload the photo from the app.');
    await assertClean(b.caption);
    // A moment can be tagged with a plan the poster is in (their own or one they joined), nothing else: the feed shows the
    // plan's title to everyone, women-only plans included, and a made-up id used to fail inside the insert as a 500.
    if (b.activityId) {
      const [m] = await sql`select 1 from activity_members where activity_id = ${b.activityId} and user_id = ${uid} and rsvp_status in ('going', 'maybe')`;
      if (!m) throw forbidden('not_in_plan', 'You can only tag a plan you are part of.');
    }

    let city = b.city ?? null;
    let countryCode = b.countryCode ?? null;

    if (b.lat !== undefined && b.lng !== undefined && !city) {
      try {
        const geo = await cityFor(b.lat, b.lng);
        city = geo.city ?? city;
        countryCode = geo.country ?? countryCode;
      } catch { /* geo lookup non-fatal */ }
    }

    if (!city) {
      const [u] = await sql`select city, home_country from users where id = ${uid}`;
      city = u?.city ?? 'Worldwide';
      countryCode = countryCode ?? u?.homeCountry ?? 'US';
    }

    const locationSql = (b.lat !== undefined && b.lng !== undefined)
      ? sql`ST_SetSRID(ST_MakePoint(${coarse(b.lng)}, ${coarse(b.lat)}), 4326)::geography`
      : null;

    const [row] = await sql`
      insert into moments (user_id, city, country_code, location, image_url, caption, category, activity_id)
      values (${uid}, ${city}, ${countryCode}, ${locationSql}, ${b.imageUrl}, ${b.caption}, ${b.category}, ${b.activityId ?? null})
      returning id, user_id as "userId", city, country_code as "countryCode", image_url as "imageUrl",
        caption, category, activity_id as "activityId", created_at as "createdAt"
    `;

    const [u] = await sql`select name, photo_url as "photoUrl", home_country as "homeCountry", verified from users where id = ${uid}`;
    await sql`insert into analytics_events (user_id, event_name, properties)
      values (${uid}, 'moment_created', ${sql.json({ momentId: row.id, city, category: b.category } as any)})`;

    return {
      ...row,
      userName: u.name,
      userPhoto: u.photoUrl,
      userCountry: u.homeCountry,
      userVerified: u.verified,
      likesCount: 0,
      likedByMe: false,
      commentsCount: 0,
    };
  });

  // Single moment view (public or authenticated)
  app.get('/moments/:id', async req => {
    let uid: string | null = null;
    try { uid = await requireUser(req); } catch { /* anonymous */ }

    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [m] = await sql`
      select
        m.id, m.user_id as "userId", m.city, m.country_code as "countryCode",
        m.image_url as "imageUrl", m.caption, m.category, m.activity_id as "activityId",
        m.created_at as "createdAt",
        u.name as "userName", u.photo_url as "userPhoto", u.home_country as "userCountry",
        u.verified as "userVerified",
        coalesce(u.boosted_until > now(), false) as "isBoosted",
        a.title as "activityTitle",
        (select count(*)::int from moment_likes ml where ml.moment_id = m.id) as "likesCount",
        (select count(*)::int from moment_comments mc where mc.moment_id = m.id and mc.deleted_at is null) as "commentsCount",
        case when ${uid}::uuid is not null then exists(select 1 from moment_likes ml where ml.moment_id = m.id and ml.user_id = ${uid}::uuid) else false end as "likedByMe"
      from moments m
      join users u on u.id = m.user_id
      left join activities a on a.id = m.activity_id
      where m.id = ${id} and m.deleted_at is null and u.deleted_at is null and u.banned_at is null
    `;

    if (!m) throw notFound('moment_not_found');

    const comments = await sql`
      select c.id, c.user_id as "userId", c.body, c.created_at as "createdAt",
        u.name as "userName", u.photo_url as "userPhoto", u.verified as "userVerified"
      from moment_comments c
      join users u on u.id = c.user_id
      where c.moment_id = ${id} and c.deleted_at is null and u.deleted_at is null and u.banned_at is null
      order by c.created_at asc
      limit 100
    `;

    return { moment: m, comments };
  });

  // Like a moment
  app.post('/moments/:id/like', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [m] = await sql`select user_id, city from moments where id = ${id} and deleted_at is null`;
    if (!m) throw notFound('moment_not_found');

    const [inserted] = await sql`
      insert into moment_likes (moment_id, user_id)
      values (${id}, ${uid})
      on conflict do nothing
      returning 1
    `;

    if (inserted && m.userId !== uid) {
      await addNotice([m.userId], {
        kind: 'moment_like',
        actorId: uid,
        momentId: id,
        body: n => `${n} liked your moment in ${m.city || 'the feed'}`
      });
    }

    const [{ count }] = await sql`select count(*)::int as count from moment_likes where moment_id = ${id}`;
    return { ok: true, liked: true, likesCount: count };
  });

  // Unlike a moment
  app.delete('/moments/:id/like', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    await sql`delete from moment_likes where moment_id = ${id} and user_id = ${uid}`;
    const [{ count }] = await sql`select count(*)::int as count from moment_likes where moment_id = ${id}`;
    return { ok: true, liked: false, likesCount: count };
  });

  // Fetch comments
  app.get('/moments/:id/comments', async req => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await sql`
      select c.id, c.user_id as "userId", c.body, c.created_at as "createdAt",
        u.name as "userName", u.photo_url as "userPhoto", u.verified as "userVerified"
      from moment_comments c
      join users u on u.id = c.user_id
      where c.moment_id = ${id} and c.deleted_at is null and u.deleted_at is null and u.banned_at is null
      order by c.created_at asc
      limit 100
    `;
    return { comments: rows };
  });

  // Add comment
  app.post('/moments/:id/comments', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(500) }).parse(req.body);

    await assertClean(body);

    const [m] = await sql`select user_id from moments where id = ${id} and deleted_at is null`;
    if (!m) throw notFound('moment_not_found');

    const [c] = await sql`
      insert into moment_comments (moment_id, user_id, body)
      values (${id}, ${uid}, ${body})
      returning id, user_id as "userId", body, created_at as "createdAt"
    `;

    const [u] = await sql`select name, photo_url as "photoUrl", verified from users where id = ${uid}`;

    if (m.userId !== uid) {
      await addNotice([m.userId], {
        kind: 'moment_comment',
        actorId: uid,
        momentId: id,
        body: n => `${n} commented on your moment: "${body.slice(0, 60)}"`
      });
    }

    return {
      ...c,
      userName: u.name,
      userPhoto: u.photoUrl,
      userVerified: u.verified
    };
  });

  // Delete moment (author only)
  app.delete('/moments/:id', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [m] = await sql`select user_id from moments where id = ${id} and deleted_at is null`;
    if (!m) throw notFound('moment_not_found');
    if (m.userId !== uid) throw forbidden('not_owner');

    await sql`update moments set deleted_at = now() where id = ${id}`;
    return { ok: true };
  });
}
