import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { forbidden, notFound } from '../lib/errors.js';
import { newShareToken, shareExpiry, shareUrl, SHARE_TOKEN_RE } from '../lib/share-links.js';
import { getEmergencyNumbers, planCountry } from './activities.js';

/**
 * Share links for a plan (lib/share-links.ts). The page they open is a read-only snapshot of the plan's details, not a
 * live location: venue, start time, host, who is going and who has checked in.
 */
export default async function shares(app: FastifyInstance) {
  // A link for someone who isn't on Tablamigo. Only a member or the host of an active plan can make one.
  app.post('/activities/:id/share', { config: { rateLimit: { max: 30, timeWindow: '1 hour' } } }, async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { note } = z.object({ note: z.string().max(300).optional() }).parse(req.body ?? {});

    const [a] = await sql`
      select a.id, a.starts_at,
        exists(select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${uid}) as is_member,
        a.host_id = ${uid} as is_host
      from activities a where a.id = ${id} and a.status = 'active'`;
    if (!a) throw notFound('activity_not_found');
    if (!a.isMember && !a.isHost) throw forbidden('not_in_plan', 'You must be attending or hosting this plan to share a link to it.');

    const token = newShareToken();
    const [row] = await sql`
      insert into plan_shares (activity_id, user_id, token, note, expires_at)
      values (${id}, ${uid}, ${token}, ${note ?? null}, ${shareExpiry(a.startsAt)})
      returning token, expires_at`;

    return { token: row.token, shareUrl: shareUrl(row.token), expiresAt: row.expiresAt };
  });

  // The caller's own links to this plan that still work, so the app can offer to turn them off.
  app.get('/activities/:id/shares', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const rows = await sql`select id, created_at, expires_at, note from plan_shares
      where activity_id = ${id} and user_id = ${uid} and expires_at > now() order by created_at desc`;
    return { shares: rows };
  });

  // Turn off every link the caller made to this plan.
  app.delete('/activities/:id/shares', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const gone = await sql`delete from plan_shares where activity_id = ${id} and user_id = ${uid} returning id`;
    return { ok: true, revoked: gone.length };
  });

  // Turn off one link. Only the person who made it can; anyone else, and a link that is already gone, gets a 404.
  app.delete('/safe/:token', async req => {
    const uid = await requireUser(req);
    const { token } = z.object({ token: z.string().regex(SHARE_TOKEN_RE) }).parse(req.params);
    const gone = await sql`delete from plan_shares where token = ${token} and user_id = ${uid} returning id`;
    if (!gone.length) throw notFound('link_expired_or_invalid');
    return { ok: true, revoked: true };
  });

  // The public page behind a link (no sign-in). A link that was never valid, has expired or was turned off is one 404.
  app.get('/safe/:token', async req => {
    const { token } = req.params as { token: string };
    if (!SHARE_TOKEN_RE.test(token)) throw notFound('link_expired_or_invalid');
    const [s] = await sql`
      select ps.id, ps.activity_id, ps.user_id, ps.note, ps.created_at, ps.expires_at,
        u.name as sharer_name, u.photo_url as sharer_photo
      from plan_shares ps
      join users u on u.id = ps.user_id
      where ps.token = ${token} and ps.expires_at > now() and u.deleted_at is null and u.banned_at is null`;
    if (!s) throw notFound('link_expired_or_invalid');

    const [a] = await sql`
      select a.id, a.title, a.emoji, a.category, a.description, a.place_name, a.place_address, a.city, a.starts_at, a.status, a.closed,
        ST_Y(a.location::geometry) as lat, ST_X(a.location::geometry) as lng,
        u.id as host_id, u.name as host_name, u.photo_url as host_photo, u.verified as host_verified, u.home_country as host_country
      from activities a
      join users u on u.id = a.host_id
      where a.id = ${s.activityId}`;
    if (!a) throw notFound('activity_not_found');

    const cancelled = a.status === 'cancelled';
    // Nobody is listed for a plan that was cancelled.
    const attendees = cancelled ? [] : await sql`
      select u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry", u.verified,
        (m.checked_in_at is not null) as "checkedIn"
      from activity_members m
      join users u on u.id = m.user_id
      where m.activity_id = ${s.activityId} and m.rsvp_status = 'going'
      order by (m.checked_in_at is not null) desc, m.joined_at asc`;

    // What the clock says about the plan, not where anyone is: nothing here knows whether people have arrived.
    const now = Date.now();
    const startTime = new Date(a.startsAt).getTime();
    let liveStatus: 'upcoming' | 'happening_now' | 'completed' | 'cancelled' = 'upcoming';
    if (cancelled) liveStatus = 'cancelled';
    else if (a.status === 'completed' || now > startTime + 4 * 3600_000) liveStatus = 'completed';
    else if (now >= startTime - 1800_000 && now <= startTime + 4 * 3600_000) liveStatus = 'happening_now';

    // Numbers for where the plan is, never the host's or the viewer's home country.
    const emergencyNumbers = getEmergencyNumbers(await planCountry(a.lat, a.lng));

    return {
      plan: {
        id: a.id,
        title: a.title,
        emoji: a.emoji,
        category: a.category,
        description: a.description,
        placeName: a.placeName,
        placeAddress: a.placeAddress,
        city: a.city,
        startsAt: a.startsAt,
        lat: a.lat,
        lng: a.lng,
        mapUrl: `https://www.google.com/maps/search/?api=1&query=${a.lat},${a.lng}`,
        liveStatus
      },
      host: {
        name: a.hostName,
        photoUrl: a.hostPhoto,
        verified: a.hostVerified,
        homeCountry: a.hostCountry
      },
      sharer: {
        name: s.sharerName,
        photoUrl: s.sharerPhoto,
        note: s.note
      },
      attendees,
      attendeeCount: attendees.length,
      emergencyNumbers,
      sharedAt: s.createdAt,
      expiresAt: s.expiresAt
    };
  });
}
