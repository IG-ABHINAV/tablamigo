import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { forbidden, needsPlus } from '../lib/errors.js';
import { reportWithTicket } from '../lib/support.js';
import { limitsFor } from '../lib/plus.js';
import { getEmergencyNumbers, planCountry } from './activities.js';
import { cachedCountry } from '../lib/geo.js';
import { REPORT_TARGET_TYPES, checkReportTarget, reportDetails } from '../lib/report-targets.js';
import shares from './shares.js';

export default async function safety(app: FastifyInstance) {
  app.post('/reports', { config: { rateLimit: { max: 20, timeWindow: '1 hour' } } }, async req => {
    const uid = await requireUser(req);
    const b = z.object({
      targetType: z.enum(REPORT_TARGET_TYPES), targetId: z.string().min(1).max(64),
      reason: z.enum(['harassment','spam','fake_profile','inappropriate','unsafe','underage','other']),
      details: z.string().max(1000).optional(),
    }).parse(req.body);
    // Moments, comments, city tips and circle ideas must exist, be visible to the reporter and not be on either side of a
    // block with them; what was reported is copied into the details (lib/report-targets.ts).
    const target = await checkReportTarget(uid, b.targetType, b.targetId);
    // Also a support ticket: the reporter gets a TM- reference by email, support@ gets a copy.
    const { ref } = await reportWithTicket(uid, { ...b, details: reportDetails(b.details, b.targetType, target) });
    return { ok: true, ref };
  });

  app.post('/blocks/:userId', async req => {
    const uid = await requireUser(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (userId === uid) throw forbidden();
    await sql`insert into blocks (blocker_id, blocked_id) values (${uid}, ${userId}) on conflict do nothing`;
    return { ok: true };
  });

  app.delete('/blocks/:userId', async req => {
    const uid = await requireUser(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    await sql`delete from blocks where blocker_id = ${uid} and blocked_id = ${userId}`;
    return { ok: true };
  });

  // Feature 26: List user's trusted emergency contacts
  app.get('/safety/contacts', async req => {
    const uid = await requireUser(req);
    const rows = await sql`
      select id, name, phone, relationship, notify_on_plan_join as "notifyOnPlanJoin", created_at as "createdAt"
      from user_trusted_contacts
      where user_id = ${uid}
      order by created_at asc`;
    const lim = await limitsFor(uid);
    return {
      contacts: rows,
      limit: lim.maxTrustedContacts,
      remaining: Math.max(0, lim.maxTrustedContacts - rows.length)
    };
  });

  // Feature 26: Add or update a trusted emergency contact
  app.post('/safety/contacts', async req => {
    const uid = await requireUser(req);
    const b = z.object({
      name: z.string().trim().min(1).max(80),
      phone: z.string().trim().min(5).max(30),
      relationship: z.enum(['parent', 'partner', 'friend', 'sibling', 'family', 'other']).default('friend'),
      notifyOnPlanJoin: z.boolean().default(true)
    }).parse(req.body);

    const lim = await limitsFor(uid);
    const [{ count }] = await sql`select count(*)::int as count from user_trusted_contacts where user_id = ${uid}`;
    if (count >= lim.maxTrustedContacts) {
      throw needsPlus('trusted_contacts_limit');
    }

    const [contact] = await sql`
      insert into user_trusted_contacts (user_id, name, phone, relationship, notify_on_plan_join)
      values (${uid}, ${b.name}, ${b.phone}, ${b.relationship}, ${b.notifyOnPlanJoin})
      on conflict (user_id, phone) do update
      set name = excluded.name, relationship = excluded.relationship, notify_on_plan_join = excluded.notify_on_plan_join
      returning id, name, phone, relationship, notify_on_plan_join as "notifyOnPlanJoin", created_at as "createdAt"`;

    return { ok: true, contact };
  });

  // Feature 26: Delete a trusted emergency contact
  app.delete('/safety/contacts/:id', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await sql`delete from user_trusted_contacts where id = ${id} and user_id = ${uid}`;
    return { ok: true };
  });

  // Feature 27: 1-Tap SOS dispatch payload for trusted contacts
  app.post('/safety/sos/dispatch', async req => {
    const uid = await requireUser(req);
    const { activityId, lat, lng, note } = z.object({
      activityId: z.string().uuid().optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      note: z.string().max(500).optional()
    }).parse(req.body ?? {});

    let planInfo: { title: string; placeName: string; city: string; placeAddress?: string | null; planLat?: number; planLng?: number } | null = null;
    if (activityId) {
      // Only a plan the caller hosts or is in: anyone else would get its title, place and coordinates.
      const [a] = await sql`
        select title, place_name, city, place_address,
          ST_Y(location::geometry) as plan_lat, ST_X(location::geometry) as plan_lng
        from activities a where a.id = ${activityId}
          and (a.host_id = ${uid} or exists(select 1 from activity_members m where m.activity_id = a.id and m.user_id = ${uid}))`;
      if (!a) throw forbidden('not_in_plan');
      planInfo = {
        title: a.title,
        placeName: a.placeName,
        city: a.city,
        placeAddress: a.placeAddress,
        planLat: a.planLat,
        planLng: a.planLng
      };
    }

    const [user] = await sql`select name from users where id = ${uid}`;
    const userName = user?.name || 'Traveler';
    const alertLat = lat ?? planInfo?.planLat ?? null;
    const alertLng = lng ?? planInfo?.planLng ?? null;

    let alertId: string | null = null;
    if (activityId) {
      const [alert] = await sql`
        insert into safety_alerts (activity_id, user_id, latitude, longitude, note)
        values (${activityId}, ${uid}, ${alertLat}, ${alertLng}, ${note ?? null})
        returning id`;
      alertId = alert.id;
    }

    const mapUrl = (alertLat != null && alertLng != null)
      ? `https://www.google.com/maps/search/?api=1&query=${alertLat},${alertLng}`
      : null;

    const contacts = await sql`
      select id, name, phone, relationship
      from user_trusted_contacts
      where user_id = ${uid}
      order by created_at asc`;

    // Local numbers for where the person is: the plan's country, else the country at the given point, else the
    // international 112 set. Never their home country (a traveller is usually abroad). Both are cache-only reads, so
    // the numbers never wait on a reverse-geocode.
    const country = planInfo ? await planCountry(planInfo.planLat, planInfo.planLng)
      : (lat != null && lng != null ? await cachedCountry(lat, lng) : null);
    const emergencyNumbers = getEmergencyNumbers(country);

    const dispatches = contacts.map(c => {
      const cleanPhone = c.phone.replace(/[^0-9+]/g, '');
      const locText = mapUrl ? `\n📍 Current GPS Map: ${mapUrl}` : '';
      const planText = planInfo ? `\n🗺️ Meetup: "${planInfo.title}" at ${planInfo.placeName}, ${planInfo.city}` : '';
      const noteText = note ? `\n💬 Note: ${note}` : '';
      const msg = `🚨 EMERGENCY ALERT from ${userName} on Tablamigo:${locText}${planText}${noteText}\n\nPlease check in or contact local authorities if unavailable.`;
      
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
      alertId,
      dispatches,
      emergencyNumbers,
      mapUrl
    };
  });

  // Share links to a plan for someone who isn't on Tablamigo, and turning them off.
  await app.register(shares);
}

