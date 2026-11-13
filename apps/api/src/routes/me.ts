import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HEARD_FROM_ANSWERS } from '../lib/heard-from.js';
import crypto from 'node:crypto';
import { sql } from '../lib/db.js';
import { requireUser, impersonatorOf } from '../lib/auth.js';
import { markOpened } from '../lib/ladder.js';
import { cityFor } from '../lib/geo.js';
import { allFree, isPlus, limitsFor, plusOf, PLUS_RANK, REFERRAL, sharePlan } from '../lib/plus.js';
import { presignImage, putImage, putAudio, deleteUserFiles, isOwnUpload } from '../lib/storage.js';
import { bad, forbidden, notFound, HttpError, voiceNotesOff } from '../lib/errors.js';
import { addNotice } from '../lib/inbox.js';
import { notify } from '../lib/push.js';
import { assertClean } from '../lib/moderation.js';
import { assertNoContactsTo } from '../lib/chat-gate.js';
import { inviteLink, redeemReferral, ensureInviteCode } from '../lib/referral.js';
import { attributeReferral, SIGNUP_CODE_DAYS } from '../lib/affiliate-ledger.js';
import { hostRewardSummary } from '../lib/host-rewards.js';
import { dropFromWomenOnlyChats, leaveUsersFromChat, disconnectUser } from '../lib/realtime.js';
import { config } from '../lib/config.js';
import { emailWelcome, emailAccountDeleted } from '../lib/emails/events.js';
import { cancelRazorpaySubscription } from '../lib/razorpay.js';
import { announceCancelled } from '../lib/plans.js';
import { recomputePlus, PASS_SKU, PASS_DAYS } from '../lib/play.js';
import { cancelPlaySubscription } from '../lib/play-client.js';
import { travellersThisWeek, TRAVELLERS_RADIUS_KM, WEEK_DAYS } from '../lib/travellers-week.js';
import { looksLikeTeamName, isTeamPhoto, TEAM_NAME_MSG, TEAM_PHOTO_MSG } from '../lib/team-identity.js';
import { tripDateRange } from '../lib/date-range.js';
import { withPaywallReason } from '../lib/paywall-reasons.js';

export const INTERESTS = ['food','drinks','nightlife','coffee','hiking','beach','museums','art','music','live music','sports','gym','yoga','photography','coworking','startups','language exchange','dancing','markets','street food','surfing','diving','cycling','gaming','books','film','wine','vegan'];

export const TRAVEL_STYLES = ['budget', 'luxury', 'early bird', 'night owl', 'planner', 'spontaneous', 'foodie', 'hiker', 'party', 'culture'];

export const PROMPTS = [
  "Next trip I'm dreaming of…",
  "My ideal day on a trip…",
  "Best street food I've had…",
  "A travel rule I live by…",
  "I'm the friend who always…",
  "My craziest travel story…",
  "My favorite hidden gem…",
  "Ask me about…"
];

// Same codes as the app's lib/countries.ts (ISO 3166-1 alpha-2 plus XK); a test keeps them in sync.
export const COUNTRY_CODES = new Set('AF AX AL DZ AS AD AO AI AG AR AM AW AU AT AZ BS BH BD BB BY BE BZ BJ BM BT BO BA BW BR VG BN BG BF BI KH CM CA CV BQ KY CF TD CL CN CX CC CO KM CG CD CK CR CI HR CU CW CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FK FO FJ FI FR GF PF GA GM GE DE GH GI GR GL GD GP GU GT GG GN GW GY HT HN HK HU IS IN ID IR IQ IE IM IL IT JM JP JE JO KZ KE KI XK KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MQ MR MU YT MX FM MD MC MN ME MS MA MZ MM NA NR NP NL NC NZ NI NE NG NU NF KP MK MP NO OM PK PW PS PA PG PY PE PH PN PL PT PR QA RE RO RU RW WS SM ST SA SN RS SC SL SG SX SK SI SB SO ZA KR SS ES LK BL SH KN LC MF PM VC SD SR SJ SE CH SY TW TJ TZ TH TL TG TK TO TT TN TR TM TC TV VI UG UA AE GB US UY UZ VU VA VE VN WF EH YE ZM ZW'.split(' '));
// Browser push services only: the server POSTs to this URL, so it must not point anywhere else.
const PUSH_HOSTS = /^(fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9-]+\.notify\.windows\.com)$/;
const webSub = z.object({ endpoint: z.string().url().max(1000).refine(u => { const x = new URL(u); return x.protocol === 'https:' && PUSH_HOSTS.test(x.hostname); }), keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }) });
const SNOOZE = { '24h': '24 hours', '3d': '3 days', '1w': '7 days' } as const;
/** The reasons the app offers when someone deletes their account (app/(tabs)/profile.tsx); 'none' when they skip it. */
export const DELETION_REASONS = ['no_one_near', 'wrong_city', 'paywall', 'not_what_i_wanted', 'privacy', 'other'] as const;

/** The radii GET /travelers tries, in order, when nobody is within the asked radius and no filter is set. */
export const WIDER_TRAVELERS_KM = [100, 500];

const profile = z.object({
  name: z.string().trim().min(1).max(40),
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  gender: z.enum(['woman','man','nonbinary','unspecified']),
  homeCountry: z.string().length(2).toUpperCase(),
  bio: z.string().max(300).optional().nullable(),
  photoUrl: z.string().url().optional().nullable(),
  instagram: z.string().trim().nullable().optional()
    .transform(s => {
      if (!s) return null;
      const clean = s.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/^@/, '').replace(/\/$/, '');
      return clean || null;
    })
    .refine(s => s === null || s === undefined || /^[a-zA-Z0-9._]{1,30}$/.test(s), 'Invalid Instagram handle'),
  hidePlanHistory: z.boolean().optional(),
  tripMatchAlerts: z.boolean().optional(),
  planAlerts: z.boolean().optional(),
  nearbyPlanAlerts: z.boolean().optional(),
  languages: z.array(z.string().max(30)).max(8),
  interests: z.array(z.string().max(30)).max(12),
  travelStyle: z.array(z.string().max(30).refine(s => TRAVEL_STYLES.includes(s))).max(5),
  countriesVisited: z.array(z.string().length(2).toUpperCase().refine(c => COUNTRY_CODES.has(c), 'Unknown country')).max(260).transform(a => [...new Set(a)]),
  emergencyContactName: z.string().trim().max(60).optional().nullable(),
  emergencyContactPhone: z.string().trim().max(30).optional().nullable(),
  isIncognito: z.boolean().optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  oledDark: z.boolean().optional(),
  mapTheme: z.enum(['auto', 'light', 'dark']).optional(),
  highContrast: z.boolean().optional(),
  locale: z.enum(['en', 'hi', 'es']).optional(),
  timeFormat: z.enum(['12h', '24h']).optional(),
  currency: z.enum(['INR', 'USD', 'EUR']).optional(),
}).partial();

const age = (d: string) => { const b = new Date(d); const n = new Date(); let a = n.getFullYear() - b.getFullYear(); if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) a--; return a; };
/** True only for a date that exists. The schema regex lets "1977-24-03" (a month-first entry from the US) through; without this
 *  check it reached Postgres, whose ::date cast failed and came back as a 500 the app could only show as "something went wrong". */
const isCalendarDate = (s: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s); if (!m) return false;
  const [y, mo, d] = [+m[1], +m[2], +m[3]]; const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
};
const BIRTHDATE_MSG = "That date doesn't exist. Enter the day first, then the month (01-12), then the year.";

/**
 * A photo a person puts on their profile (PATCH /me, POST /me/photos): never the team account's picture (lib/team-identity.ts),
 * and only one they uploaded themselves as an avatar (lib/storage.ts isOwnUpload, as moments.ts checks), so a profile can't make
 * everyone's app load a link its owner chose. The app always uploads first (pickAndUpload('avatar'), on phones and the web).
 */
async function newPhoto(url: string, uid: string) {
  if (await isTeamPhoto(url)) throw bad('team_photo', TEAM_PHOTO_MSG);
  if (!isOwnUpload(url, uid, ['avatar'])) throw bad('bad_photo', 'Upload the photo from the app.');
}

async function areConnected(a: string, b: string) {
  const [row] = await sql`select 1 from connections where (user_id = ${a} and friend_id = ${b}) or (user_id = ${b} and friend_id = ${a}) limit 1`;
  return !!row;
}

/** `recipient` accepts request `requestId` from `sender`: both directions in `connections`, a notice and a push to the sender. */
async function acceptConnection(requestId: string, recipient: string, sender: string) {
  const done = await sql.begin(async tx => {
    const [r] = await tx`update connection_requests set status = 'accepted', responded_at = now()
      where id = ${requestId} and status = 'pending' returning id`;
    if (!r) return false;
    await tx`insert into connections (user_id, friend_id) values (${recipient}, ${sender}), (${sender}, ${recipient}) on conflict do nothing`;
    return true;
  });
  if (!done) return;
  await addNotice([sender], { kind: 'connection_accepted', actorId: recipient, body: n => `${n} accepted your request. You're connected.` });
  const [me] = await sql`select name from users where id = ${recipient}`;
  void notify([sender], {
    title: `${me?.name ?? 'Someone'} accepted your request`,
    body: "You're connected on Tablamigo. Say hi!",
    data: { userId: recipient, nkind: 'connection_accepted', nref: requestId },
    tag: `connect-${recipient}`,
  });
}

export default async function me(app: FastifyInstance) {
  app.get('/meta', async () => ({ interests: INTERESTS, travelStyles: TRAVEL_STYLES, prompts: PROMPTS, allFree: allFree() }));

  app.get('/me', async req => {
    const uid = await requireUser(req);
    const [u] = await sql`select id, email, name, birthdate, gender, home_country, bio, photo_url, instagram, hide_plan_history, languages, interests, travel_style, city, plus_until, verified, onboarded, role, created_at,
      theme, oled_dark as "oledDark", map_theme as "mapTheme", high_contrast as "highContrast", locale,
      time_format as "timeFormat", currency,
      emergency_contact_name as "emergencyContactName", emergency_contact_phone as "emergencyContactPhone",
      is_incognito as "isIncognito", trip_passes_available as "tripPassesAvailable",
      trip_match_alerts as "tripMatchAlerts", plan_alerts as "planAlerts", nearby_plan_alerts as "nearbyPlanAlerts",
      id_verified as "idVerified", id_verification_status as "idVerificationStatus",
      coalesce(boosted_until > now(), false) as "isBoosted",
      case when boosted_until > now() then boosted_until end as "boostedUntil",
      countries_visited, coalesce(snoozed_until > now(), false) as snoozed,
      case when snoozed_until > now() and snoozed_until < 'infinity' then snoozed_until end as snoozed_until,
      (select count(*)::int from vouches v where v.vouched_id = users.id) as vouches,
      (select r.status from verification_requests r where r.user_id = users.id order by r.created_at desc limit 1) as verification,
      ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng from users where id = ${uid}`;
    const photos = await sql`select id, url, position, created_at from user_photos where user_id = ${uid} order by position asc, created_at asc`;
    const prompts = await sql`select id, prompt, answer, position, created_at from profile_prompts where user_id = ${uid} order by position asc, created_at asc`;
    return { ...u, photos, prompts, plus: await isPlus(uid), allFree: allFree() };
  });

  app.get('/me/display-preferences', async req => {
    const uid = await requireUser(req);
    const [row] = await sql`
      select theme, oled_dark as "oledDark", map_theme as "mapTheme", high_contrast as "highContrast", locale
      from users where id = ${uid}`;
    return row ?? { theme: 'system', oledDark: false, mapTheme: 'auto', highContrast: false, locale: 'en' };
  });

  app.patch('/me/display-preferences', async req => {
    const uid = await requireUser(req);
    const body = z.object({
      theme: z.enum(['system', 'light', 'dark']).optional(),
      oledDark: z.boolean().optional(),
      mapTheme: z.enum(['auto', 'light', 'dark']).optional(),
      highContrast: z.boolean().optional(),
      locale: z.enum(['en', 'hi', 'es']).optional(),
    }).parse(req.body);

    const [updated] = await sql`
      update users set
        theme = coalesce(${body.theme ?? null}, theme),
        oled_dark = coalesce(${body.oledDark ?? null}, oled_dark),
        map_theme = coalesce(${body.mapTheme ?? null}, map_theme),
        high_contrast = coalesce(${body.highContrast ?? null}, high_contrast),
        locale = coalesce(${body.locale ?? null}, locale)
      where id = ${uid}
      returning theme, oled_dark as "oledDark", map_theme as "mapTheme", high_contrast as "highContrast", locale`;
    return { ok: true, preferences: updated };
  });

  app.get('/me/locale-preferences', async req => {
    const uid = await requireUser(req);
    const [row] = await sql`
      select locale, time_format as "timeFormat", currency
      from users where id = ${uid}`;
    return row ?? { locale: 'en', timeFormat: '12h', currency: 'INR' };
  });

  app.patch('/me/locale-preferences', async req => {
    const uid = await requireUser(req);
    const body = z.object({
      locale: z.enum(['en', 'hi', 'es']).optional(),
      timeFormat: z.enum(['12h', '24h']).optional(),
      currency: z.enum(['INR', 'USD', 'EUR']).optional(),
    }).parse(req.body);

    const [updated] = await sql`
      update users set
        locale = coalesce(${body.locale ?? null}, locale),
        time_format = coalesce(${body.timeFormat ?? null}, time_format),
        currency = coalesce(${body.currency ?? null}, currency)
      where id = ${uid}
      returning locale, time_format as "timeFormat", currency`;
    return { ok: true, preferences: updated };
  });

  // Onboarding's "How did you hear about us?" (lib/heard-from.ts). One tap, or Skip. The latest answer wins, so a person who
  // goes back a step and picks again is recorded as they meant it; heard_from_at says when.
  app.post('/me/heard-from', async req => {
    const uid = await requireUser(req);
    const { source } = z.object({ source: z.enum(HEARD_FROM_ANSWERS) }).parse(req.body);
    await sql`update users set heard_from = ${source}, heard_from_at = now() where id = ${uid}`;
    await sql`insert into analytics_events (user_id, event_name, properties) values (${uid}, 'heard_from', ${sql.json({ source })})`.catch(() => {});
    return { ok: true, heardFrom: source };
  });

  app.patch('/me', async req => {
    const uid = await requireUser(req);
    const p = profile.parse(req.body);
    if (p.birthdate && !isCalendarDate(p.birthdate)) throw bad('invalid_birthdate', BIRTHDATE_MSG);
    if (p.birthdate && age(p.birthdate) < 18) throw bad('under_18', 'You must be 18 or older to use Tablamigo.');
    if (p.isIncognito && !(await isPlus(uid))) throw forbidden('plus_required', 'Incognito browsing requires Tablamigo Plus.');
    const [cur] = await sql`select name, birthdate, gender, home_country, photo_url, onboarded as was_onboarded from users where id = ${uid}`;
    // Nobody can take on the look of the Tablamigo Host team account (lib/team-identity.ts): its name and avatar are all the
    // app shows. Checked on a change only, so the app re-sending a profile unchanged still saves the other fields, and a photo
    // set before newPhoto() existed (some are links elsewhere) keeps saving too.
    if (p.name && p.name !== cur.name && looksLikeTeamName(p.name)) throw bad('team_name', TEAM_NAME_MSG);
    if (p.photoUrl && p.photoUrl !== cur.photoUrl) await newPhoto(p.photoUrl, uid);
    const merged = { ...cur, ...p };
    const onboarded = !!(merged.name && merged.birthdate && merged.gender && merged.homeCountry);
    await sql`update users set
      name = coalesce(${p.name ?? null}, name), birthdate = coalesce(${p.birthdate ?? null}::date, birthdate),
      gender = coalesce(${p.gender ?? null}, gender), home_country = coalesce(${p.homeCountry ?? null}, home_country),
      bio = case when ${p.bio !== undefined} then ${p.bio ?? null} else bio end,
      photo_url = case when ${p.photoUrl !== undefined} then ${p.photoUrl ?? null} else photo_url end,
      instagram = case when ${p.instagram !== undefined} then ${p.instagram ?? null} else instagram end,
      hide_plan_history = coalesce(${p.hidePlanHistory ?? null}, hide_plan_history),
      trip_match_alerts = coalesce(${p.tripMatchAlerts ?? null}, trip_match_alerts),
      plan_alerts = coalesce(${p.planAlerts ?? null}, plan_alerts),
      nearby_plan_alerts = coalesce(${p.nearbyPlanAlerts ?? null}, nearby_plan_alerts),
      languages = coalesce(${p.languages ?? null}, languages), interests = coalesce(${p.interests ?? null}, interests),
      travel_style = coalesce(${p.travelStyle ?? null}, travel_style),
      countries_visited = coalesce(${p.countriesVisited ?? null}, countries_visited),
      emergency_contact_name = case when ${p.emergencyContactName !== undefined} then ${p.emergencyContactName ?? null} else emergency_contact_name end,
      emergency_contact_phone = case when ${p.emergencyContactPhone !== undefined} then ${p.emergencyContactPhone ?? null} else emergency_contact_phone end,
      is_incognito = coalesce(${p.isIncognito ?? null}, is_incognito),
      theme = coalesce(${p.theme ?? null}, theme),
      oled_dark = coalesce(${p.oledDark ?? null}, oled_dark),
      map_theme = coalesce(${p.mapTheme ?? null}, map_theme),
      high_contrast = coalesce(${p.highContrast ?? null}, high_contrast),
      locale = coalesce(${p.locale ?? null}, locale),
      time_format = coalesce(${p.timeFormat ?? null}, time_format),
      currency = coalesce(${p.currency ?? null}, currency),
      onboarded = ${onboarded} where id = ${uid}`;
    // No longer a woman on the profile: their open sockets leave the women-only chats (as on connect and in post()).
    if (p.gender && p.gender !== 'woman') await dropFromWomenOnlyChats(uid);
    if (p.photoUrl) {
      const [existing] = await sql`select id from user_photos where user_id = ${uid} and url = ${p.photoUrl}`;
      if (!existing) {
        await sql`update user_photos set position = position + 1 where user_id = ${uid}`;
        await sql`insert into user_photos (user_id, url, position) values (${uid}, ${p.photoUrl}, 0)`;
      }
    }
    // First time the profile is complete: welcome email (once per account, enforced by email_log) + activation event.
    if (onboarded && !cur.wasOnboarded) {
      void emailWelcome(uid);
      await sql`insert into analytics_events (user_id, event_name, properties) values (${uid}, 'onboarding_complete', '{}'::jsonb)`.catch(() => {});
    }
    return { ok: true, onboarded };
  });

  // A tap on a push or an in-app notice: the delivery ladder (lib/ladder.ts) reads it before it falls back to email.
  app.post('/me/notifications/opened', async req => {
    const uid = await requireUser(req);
    const { kind, ref } = z.object({ kind: z.string().min(1).max(40), ref: z.string().min(1).max(120) }).parse(req.body);
    return { ok: await markOpened(uid, kind, ref) };
  });

  // Snoozed people drop out of Travelers and the map; chats and plans keep working.
  app.post('/me/snooze', async req => {
    const uid = await requireUser(req);
    const { duration } = z.object({ duration: z.enum(['24h','3d','1w','indefinite']) }).parse(req.body);
    await sql`update users set snoozed_until = ${duration === 'indefinite' ? sql`'infinity'::timestamptz` : sql`now() + ${SNOOZE[duration]}::interval`} where id = ${uid}`;
    return { ok: true };
  });

  app.delete('/me/snooze', async req => {
    const uid = await requireUser(req);
    await sql`update users set snoozed_until = null where id = ${uid}`;
    return { ok: true };
  });

  // Who opened my profile in the last 30 days. Free accounts get the count, never the people.
  app.get('/me/viewers', async req => {
    const uid = await requireUser(req);
    const rows = await sql`select u.id, u.name, u.photo_url, u.home_country, u.verified, v.viewed_at
      from profile_views v join users u on u.id = v.viewer_id
      where v.viewed_id = ${uid} and v.viewed_at > now() - interval '30 days' and u.deleted_at is null and u.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
      order by v.viewed_at desc limit 200`;
    const { seeViewers } = await limitsFor(uid);
    return { count: rows.length, locked: !seeViewers, viewers: seeViewers ? rows : [] };
  });

  // Same as /travelers/nearby, plus snooze and an age range. The Travelers screen uses this one.
  // "Travellers this week" (lib/travellers-week.ts): real people in or heading to a place in the next 7 days, as counts only.
  // `cityKey` (optional) also matches trips typed for that city without a point ('mumbai-in').
  app.get('/travelers/this-week', async req => {
    const uid = await requireUser(req);
    const q = z.object({
      lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180),
      cityKey: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{2,80}$/).optional(),
    }).parse(req.query);
    const r = await travellersThisWeek({ lat: q.lat, lng: q.lng, cityKey: q.cityKey ?? null, excludeUserId: uid });
    return { ...r, radiusKm: TRAVELLERS_RADIUS_KM, days: WEEK_DAYS };
  });

  app.get('/travelers', async req => {
    const uid = await requireUser(req);
    const q = z.object({
      lat: z.coerce.number(), lng: z.coerce.number(), radiusKm: z.coerce.number().max(100).default(30),
      min_age: z.coerce.number().int().min(18).max(99).optional(), max_age: z.coerce.number().int().min(18).max(99).optional(),
      women_only: z.coerce.boolean().optional(),
      verified_only: z.coerce.boolean().optional(),
      travel_style: z.string().optional(),
      language: z.string().optional(),
    }).parse(req.query);
    if (q.min_age && q.max_age && q.min_age > q.max_age) throw bad('bad_ages');

    const hasAdvanced = !!(q.verified_only || q.travel_style || q.language);
    const userLimits = await limitsFor(uid);
    if (hasAdvanced && !userLimits.advancedFilters) {
      throw forbidden('plus_required', 'Advanced filters (verified travelers, travel style, and languages) are a Plus feature.');
    }

    const [me] = await sql`select interests, gender from users where id = ${uid}`;
    if (q.women_only && me?.gender !== 'woman') {
      throw forbidden('women_only', 'Women-only traveler discovery is reserved for women travelers.');
    }
    const within = (radiusKm: number) => sql`select * from (
      select u.id, u.name, u.photo_url, u.home_country, u.verified, u.id_verified as "idVerified", u.interests,
        u.travel_style as "travelStyle",
        date_part('year', age(u.birthdate))::int as age,
        ST_Distance(u.location, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography)::int as distance_m,
        cardinality(array(select unnest(u.interests) intersect select unnest(${me?.interests ?? []}::text[]))) as shared,
        u.location_at > now() - interval '30 minutes' as online,
        ${plusOf('u')} as plus,
        coalesce(u.boosted_until > now(), false) as boosted
      from users u
      where u.id <> ${uid} and u.onboarded and u.deleted_at is null and u.banned_at is null
        and u.location_at > now() - interval '3 days' and (u.snoozed_until is null or u.snoozed_until <= now())
        and (${q.min_age ?? null}::int is null or u.birthdate <= current_date - make_interval(years => ${q.min_age ?? null}::int))
        and (${q.max_age ?? null}::int is null or u.birthdate > current_date - make_interval(years => ${q.max_age ?? null}::int + 1))
        and (not ${!!q.women_only} or u.gender = 'woman')
        and (not ${!!q.verified_only} or u.verified = true)
        and (${q.travel_style ?? null}::text is null or ${q.travel_style ?? ''} = any(u.travel_style))
        and (${q.language ?? null}::text is null or ${q.language ?? ''} = any(u.languages))
        and ST_DWithin(u.location, ST_SetSRID(ST_MakePoint(${q.lng}, ${q.lat}), 4326)::geography, ${radiusKm * 1000})
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
      ) x
      -- Boosted travelers get seen first (24h spotlight), followed by online, shared, and Plus distance bands.
      order by boosted desc, online desc, shared desc, floor(distance_m / ${PLUS_RANK.distanceBandM}), plus desc, distance_m asc
      limit 200`;
    // Distance is rounded so nobody can be triangulated: to 500 m nearby, to 5 km beyond 50 km.
    const rounded = (rows: any[]) => rows.map(r => ({ ...r, distanceM: r.distanceM > 50_000 ? Math.round(r.distanceM / 5000) * 5000 : Math.max(500, Math.round(r.distanceM / 500) * 500) }));
    const rows = await within(q.radiusKm);
    // Nobody around and no filter narrowing it: the nearest travelers further out, so the screen isn't just "Quiet around
    // here" (only 1 of 25 located sign-ups had anyone within 30 km). `wider` is extra; older apps read `travelers` only.
    const filtered = q.min_age || q.max_age || q.women_only || hasAdvanced;
    if (rows.length || filtered) return { count: rows.length, travelers: rounded(rows) };
    for (const radiusKm of WIDER_TRAVELERS_KM.filter(km => km > q.radiusKm)) {
      const far = await within(radiusKm);
      if (far.length) return { count: 0, travelers: [], wider: { radiusKm, travelers: rounded([...far].sort((x, y) => x.distanceM - y.distanceM).slice(0, 30)) } };
    }
    return { count: 0, travelers: [], wider: null };
  });

  // Thumbs-up after a meetup: both were in the plan, it has started, once per pair per plan.
  app.post('/vouches', async req => {
    const uid = await requireUser(req);
    const b = z.object({ activityId: z.string().uuid(), userId: z.string().uuid() }).parse(req.body);
    if (b.userId === uid) throw forbidden();
    const [a] = await sql`select a.status, a.starts_at, a.title,
        (select count(*)::int from activity_members m where m.activity_id = a.id and m.user_id = any(${[uid, b.userId]}::uuid[])) as members
      from activities a where a.id = ${b.activityId}`;
    if (!a || a.status !== 'active') throw notFound();
    if (a.members < 2) throw forbidden('not_in_plan');
    if (new Date(a.startsAt).getTime() > Date.now()) throw bad('plan_not_started');
    const [blocked] = await sql`select 1 from blocks where (blocker_id = ${uid} and blocked_id = ${b.userId}) or (blocker_id = ${b.userId} and blocked_id = ${uid})`;
    if (blocked) throw forbidden('blocked');
    const [v] = await sql`insert into vouches (activity_id, voucher_id, vouched_id) values (${b.activityId}, ${uid}, ${b.userId}) on conflict do nothing returning 1`;
    if (v) await addNotice([b.userId], { kind: 'vouch', actorId: uid, activityId: b.activityId, body: n => `${n} gave you a thumbs-up for ${a.title}` });
    return { ok: true };
  });

  app.get('/vouches/:activityId', async req => {
    const uid = await requireUser(req);
    const { activityId } = z.object({ activityId: z.string().uuid() }).parse(req.params);
    const rows = await sql`select vouched_id from vouches where activity_id = ${activityId} and voucher_id = ${uid}`;
    return { given: rows.map(r => r.vouchedId) };
  });

  app.post('/me/location', async req => {
    const uid = await requireUser(req);
    const { lat, lng } = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).parse(req.body);
    const { city } = await cityFor(lat, lng);
    await sql`update users set location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, location_at = now(), city = coalesce(${city}, city) where id = ${uid}`;
    return { ok: true, city };
  });

  app.get('/push/vapid-public-key', async () => ({ key: config.webPush.publicKey || null }));

  // Web tokens are the browser's PushSubscription JSON, stored in one canonical shape.
  app.post('/me/push-token', async req => {
    const uid = await requireUser(req);
    let { token, platform } = z.object({ token: z.string().min(10).max(4000), platform: z.enum(['android','ios','web']) }).parse(req.body);
    if (platform === 'web') {
      const s = webSub.safeParse((() => { try { return JSON.parse(token); } catch { return null; } })());
      if (!s.success) throw bad('bad_subscription');
      token = JSON.stringify({ endpoint: s.data.endpoint, keys: { p256dh: s.data.keys.p256dh, auth: s.data.keys.auth } });
    }
    await sql`insert into push_tokens (token, user_id, platform) values (${token}, ${uid}, ${platform}) on conflict (token) do update set user_id = excluded.user_id`;
    return { ok: true };
  });

  // Government-ID uploads (kind id_doc) are off with Tier 2 verification: they would land on the public media CDN.
  const idDocsOff = (kind: string) => {
    if (kind === 'id_doc' && !config.features.idVerification) throw new HttpError(404, 'id_verification_unavailable', 'Government ID verification is not available.');
  };

  app.post('/uploads/image', async req => {
    const uid = await requireUser(req);
    const { kind, contentType } = z.object({ kind: z.enum(['avatar','chat','id_doc']), contentType: z.enum(['image/jpeg','image/png','image/webp']) }).parse(req.body);
    idDocsOff(kind);
    return presignImage(uid, kind, contentType);
  });

  // Web app uploads: the raw image or audio in the body, stored by us (browsers can't PUT to the shared bucket).
  await app.register(async web => {
    web.addContentTypeParser(/^image\/(jpeg|png|webp)$/, { parseAs: 'buffer', bodyLimit: 5 * 1024 * 1024 }, (_r, body, done) => done(null, body));
    web.addContentTypeParser(/^audio\/(m4a|mp4|mpeg|aac|webm|ogg|wav|x-m4a)$/, { parseAs: 'buffer', bodyLimit: 10 * 1024 * 1024 }, (_r, body, done) => done(null, body));
    web.post('/uploads/image/direct', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
      const uid = await requireUser(req);
      const { kind } = z.object({ kind: z.enum(['avatar', 'chat', 'id_doc']) }).parse(req.query);
      idDocsOff(kind);
      const contentType = z.enum(['image/jpeg', 'image/png', 'image/webp']).parse(req.headers['content-type']);
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('bad_photo');
      return putImage(uid, kind, contentType, req.body);
    });
    web.post('/uploads/audio/direct', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async req => {
      const uid = await requireUser(req);
      if (!config.features.voiceNotes) throw voiceNotesOff();
      const rawHeader = req.headers['content-type'] ?? '';
      const contentType = rawHeader.split(';')[0].trim().toLowerCase();
      if (!['audio/m4a', 'audio/mp4', 'audio/mpeg', 'audio/aac', 'audio/webm', 'audio/ogg', 'audio/wav', 'audio/x-m4a'].includes(contentType)) {
        throw bad('unsupported_audio_type', 'Audio must be an M4A, MP3, AAC, WebM, WAV, or OGG file.');
      }
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad('empty_audio');
      return putAudio(uid, contentType, req.body);
    });
  });

  // Google Play requires in-app account deletion. Personal data is wiped now;
  // the row is kept as a tombstone so foreign keys and reports stay consistent.
  const bestEffort = async (f: () => Promise<void>) => { try { await f(); } catch (e) { app.log.error(e, 'file cleanup failed'); } };
  app.delete('/me', async req => {
    const uid = await requireUser(req);
    // The optional one-tap reason from the app's confirm (migration 063): a fixed code, kept without anything that names the person.
    // A value this API doesn't know (a newer app's code, free text) never stops the deletion: it is stored as 'other', never as sent.
    const sent = (req.body as { reason?: unknown } | null)?.reason;
    const reason = sent == null ? 'none' : (DELETION_REASONS as readonly unknown[]).includes(sent) ? sent as string : 'other';
    await sql`insert into account_deletion_reasons (reason, days_since_signup)
      select ${reason}, (current_date - created_at::date) from users where id = ${uid}`.catch(e => app.log.error(e, 'deletion reason not stored'));
    // Captured before the row is anonymised, for the confirmation email. Web (Razorpay) and Google Play subscriptions are both
    // cancelled here (Play through purchases.subscriptionsv2.cancel since 12 Nov 2026); if a cancel fails, the email says how
    // to stop it and the deletion goes on.
    const [before] = await sql`select email, name,
        exists(select 1 from subscriptions s where s.user_id = users.id and s.platform = 'google' and s.status in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') and s.expires_at > now()) as google_sub,
        exists(select 1 from subscriptions s where s.user_id = users.id and s.platform = 'razorpay' and s.status in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') and s.cancel_requested_at is null and s.expires_at > now()) as web_sub
      from users where id = ${uid}`;
    let googleCancelled = false;
    if (before.googleSub) {
      const tokens = await sql`select purchase_token from subscriptions where user_id = ${uid} and platform = 'google'
        and status in ('SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD') and expires_at > now()`;
      // Bounded: a hung Play call must never hold up the deletion (Play policy); a timeout counts as not cancelled.
      const within = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<never>((_, no) => setTimeout(() => no(new Error('play_cancel_timeout')), ms))]);
      try { for (const t of tokens) await within(cancelPlaySubscription(t.purchaseToken), 8000); googleCancelled = true; }
      catch (e) { app.log.error(e, 'play cancel on account deletion failed'); }
    }
    let webCancelled = false;
    if (before.webSub) {
      try { await cancelRazorpaySubscription(uid, { email: false }); webCancelled = true; }
      catch (e) { app.log.error(e, 'razorpay cancel on account deletion failed'); }
    }
    // Upcoming plans they host end with the account; the people in them are told after the wipe.
    const hosted = await sql`select id from activities where host_id = ${uid} and status = 'active' and starts_at > now() - interval '2 hours'`;
    const chatIds = (await sql`select chat_id from chat_members where user_id = ${uid}`).map(r => r.chatId as string);
    await sql.begin(async tx => {
      await tx`delete from activity_members where user_id = ${uid}`;
      // Hosted plans stay on record as cancelled, but not the host's payout UPI ID (a payment identifier, often a phone number).
      await tx`update activities set status = 'cancelled', payout_upi_id = null where host_id = ${uid}`;
      // A DM request that was never accepted, or was declined, goes entirely (the other side's copy included).
      await tx`delete from chats where kind = 'dm' and id in (select chat_id from chat_members where user_id = ${uid})
        and exists (select 1 from chat_members m where m.chat_id = chats.id and m.request_status <> 'accepted')`;
      await tx`delete from dm_starts where user_id = ${uid}`;
      await tx`delete from chat_members where user_id = ${uid}`;
      // What they posted in chats beyond the message text: voice notes, polls (and their votes), live locations, reactions.
      await tx`delete from chat_poll_votes where user_id = ${uid} or message_id in (select id from messages where sender_id = ${uid})`;
      await tx`delete from chat_polls where message_id in (select id from messages where sender_id = ${uid})`;
      await tx`delete from chat_voice_notes where message_id in (select id from messages where sender_id = ${uid})`;
      await tx`delete from chat_locations where user_id = ${uid} or message_id in (select id from messages where sender_id = ${uid})`;
      await tx`delete from message_reactions where user_id = ${uid}`;
      // Trip circles: proposals they made, their votes on others', the topic credit.
      await tx`delete from trip_circle_proposals where proposer_id = ${uid}`;
      await tx`update trip_circle_proposals set votes = array_remove(votes, ${uid}::uuid) where ${uid}::uuid = any(votes)`;
      await tx`update chats set topic_updated_by = null where topic_updated_by = ${uid}`;
      // Feed, tips, plan discussion, photos.
      await tx`delete from moments where user_id = ${uid}`;   // their likes and comments go with them (ON DELETE CASCADE)
      await tx`delete from moment_likes where user_id = ${uid}`;
      await tx`delete from moment_comments where user_id = ${uid}`;
      await tx`update city_tips set helpful_count = greatest(0, helpful_count - 1) where id in (select tip_id from city_tip_upvotes where user_id = ${uid})`;
      await tx`delete from city_tip_upvotes where user_id = ${uid}`;
      await tx`delete from city_tips where user_id = ${uid}`;
      await tx`delete from activity_comments where user_id = ${uid}`;
      await tx`delete from activity_photo_reactions where user_id = ${uid}`;
      await tx`delete from activity_photos where user_id = ${uid}`;
      await tx`delete from activity_ratings where rater_id = ${uid} or host_id = ${uid}`;
      // Saved plans (with their private notes), share links, SOS records, safety contacts.
      await tx`delete from saved_activities where user_id = ${uid}`;
      await tx`delete from plan_shares where user_id = ${uid}`;
      await tx`delete from safety_alerts where user_id = ${uid}`;
      await tx`delete from user_trusted_contacts where user_id = ${uid}`;
      // People graph and inbox.
      await tx`delete from connections where user_id = ${uid} or friend_id = ${uid}`;
      await tx`delete from connection_requests where sender_id = ${uid} or recipient_id = ${uid}`;
      await tx`delete from blocks where blocker_id = ${uid} or blocked_id = ${uid}`;
      await tx`delete from notifications where user_id = ${uid} or actor_id = ${uid}`;
      await tx`delete from travel_buddy_requests where sender_id = ${uid} or recipient_id = ${uid}`;
      // Automatic team messages and their delivery log (migration 069).
      await tx`delete from trip_matches where user_lo = ${uid} or user_hi = ${uid}`;
      await tx`delete from trip_match_notices where user_id = ${uid} or other_id = ${uid}`;
      await tx`delete from notification_log where user_id = ${uid}`;
      await tx`delete from city_nudges where user_id = ${uid}`;
      await tx`delete from plan_views where viewer_id = ${uid}`;
      // Trip Pass wallet, ID verification, sign-in codes. The ID photos are files: deleteUserFiles below removes them.
      // Purchase records (paid orders) stay for tax law, like subscriptions and passes: they hang off the anonymised
      // account row and no longer say whose it is. Free grants (referral, admin comp) and the redemption history go.
      await tx`delete from trip_pass_redemptions where user_id = ${uid}`;
      await tx`delete from trip_pass_wallet where user_id = ${uid} and source not in ('purchase_single', 'purchase_bundle')`;
      await tx`update trip_pass_wallet set passes_remaining = 0 where user_id = ${uid}`;
      await tx`delete from id_verification_requests where user_id = ${uid}`;
      await tx`delete from otp_codes where email = ${before.email}`;
      // Analytics (activation funnel and the rest) keep their counts but no longer point at a person.
      await tx`update analytics_events set user_id = null, properties = '{}'::jsonb where user_id = ${uid}`;
      // The owner's sale alerts keep which event was alerted (so none is sent twice), not an unsent copy naming the person.
      await tx`update owner_sale_alerts set subject = null, body_text = null, body_html = null where user_id = ${uid}`;
      await tx`delete from trips where user_id = ${uid}`;
      await tx`delete from push_tokens where user_id = ${uid}`;
      await tx`update refresh_tokens set revoked_at = now() where user_id = ${uid}`;
      await tx`update messages set body = '[deleted]', kind = 'text', deleted_at = now() where sender_id = ${uid}`;
      await tx`delete from profile_views where viewer_id = ${uid} or viewed_id = ${uid}`;
      await tx`delete from vouches where voucher_id = ${uid} or vouched_id = ${uid}`;
      await tx`delete from verification_requests where user_id = ${uid}`;
      await tx`delete from user_photos where user_id = ${uid}`;
      await tx`delete from profile_prompts where user_id = ${uid}`;
      await tx`update users set email = ${'deleted-' + uid + '@deleted.tablamigo'}, name = 'Deleted user', bio = null, photo_url = null,
        birthdate = null, location = null, location_at = null, city = null, home_country = null, gender = 'unspecified', verified = false,
        languages = '{}', interests = '{}', countries_visited = '{}', travel_style = '{}', instagram = null, snoozed_until = null,
        emergency_contact_name = null, emergency_contact_phone = null, id_verified = false, id_verification_status = 'none',
        trip_passes_available = 0, boosted_until = null, here_now_opt_in = false, here_now_snooze_until = null, here_now_status = null,
        attribution = case jsonb_typeof(attribution) when 'object' then attribution - 'ip' - 'referrer' - 'city' end,
        phone_e164 = null, phone_verified_at = null, whatsapp_opt_in = false, sms_opt_in = false, telegram_chat_id = null, telegram_linked_at = null,
        deleted_at = now() where id = ${uid}`;
    });
    // Sockets still open for this account stop receiving chats (they can't reconnect: the sign-in check refuses deleted accounts).
    for (const c of chatIds) leaveUsersFromChat([uid], c);
    disconnectUser(uid);
    // Chat photos they sent become unavailable too; the message rows already say [deleted].
    // Verification selfies live under avatar/<uid>/ (routes/verify.ts), so this removes them as well.
    await bestEffort(() => deleteUserFiles(uid));
    await announceCancelled(hosted.map(a => a.id), 'This plan was cancelled because the host deleted their account.', t => `${t} was cancelled: the host left Tablamigo`);
    void emailAccountDeleted(uid, { email: before.email, name: before.name, googleSub: before.googleSub && !googleCancelled, googleCancelled, webSub: before.webSub && !webCancelled, webCancelled });
    return { ok: true };
  });

  // Photo gallery: up to 3 for free users, up to 6 for Plus members
  app.get('/me/photos', async req => {
    const uid = await requireUser(req);
    const photos = await sql`select id, url, position, created_at from user_photos where user_id = ${uid} order by position asc, created_at asc`;
    return { photos };
  });

  app.post('/me/photos', async req => {
    const uid = await requireUser(req);
    const { url } = z.object({ url: z.string().url() }).parse(req.body);
    await newPhoto(url, uid);   // it can become the main photo
    const limits = await limitsFor(uid);
    const existing = await sql`select id from user_photos where user_id = ${uid}`;
    if (existing.length >= limits.maxPhotos) {
      throw forbidden('photo_limit_reached', `You can upload up to ${limits.maxPhotos} photos.`);
    }
    const nextPos = existing.length;
    const [photo] = await sql`insert into user_photos (user_id, url, position)
      values (${uid}, ${url}, ${nextPos}) returning id, url, position, created_at`;
    if (nextPos === 0) {
      await sql`update users set photo_url = ${url} where id = ${uid} and (photo_url is null or photo_url = '')`;
    }
    return { ok: true, photo };
  });

  app.delete('/me/photos/:id', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [deleted] = await sql`delete from user_photos where id = ${id} and user_id = ${uid} returning id, url, position`;
    if (!deleted) throw notFound('photo_not_found');

    const remaining = await sql`select id, url from user_photos where user_id = ${uid} order by position asc, created_at asc`;
    for (let i = 0; i < remaining.length; i++) {
      await sql`update user_photos set position = ${i} where id = ${remaining[i].id}`;
    }

    const [u] = await sql`select photo_url from users where id = ${uid}`;
    if (u?.photo_url === deleted.url || deleted.position === 0) {
      const nextMainUrl = remaining[0]?.url ?? null;
      await sql`update users set photo_url = ${nextMainUrl} where id = ${uid}`;
    }
    return { ok: true };
  });

  app.put('/me/photos/reorder', async req => {
    const uid = await requireUser(req);
    const { photoIds } = z.object({ photoIds: z.array(z.string().uuid()).min(1).max(6) }).parse(req.body);
    const existing = await sql`select id, url from user_photos where user_id = ${uid}`;
    const existingMap = new Map(existing.map(p => [p.id, p.url]));
    if (photoIds.length !== existing.length || !photoIds.every(id => existingMap.has(id))) {
      throw bad('invalid_photo_ids');
    }
    for (let i = 0; i < photoIds.length; i++) {
      await sql`update user_photos set position = ${i} where id = ${photoIds[i]} and user_id = ${uid}`;
    }
    const mainUrl = existingMap.get(photoIds[0]);
    if (mainUrl) {
      await sql`update users set photo_url = ${mainUrl} where id = ${uid}`;
    }
    return { ok: true };
  });

  app.post('/me/photos/:id/main', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [target] = await sql`select id, url from user_photos where id = ${id} and user_id = ${uid}`;
    if (!target) throw notFound('photo_not_found');

    const others = await sql`select id from user_photos where user_id = ${uid} and id <> ${id} order by position asc, created_at asc`;
    await sql`update user_photos set position = 0 where id = ${id}`;
    for (let i = 0; i < others.length; i++) {
      await sql`update user_photos set position = ${i + 1} where id = ${others[i].id}`;
    }
    await sql`update users set photo_url = ${target.url} where id = ${uid}`;
    return { ok: true };
  });

  // Profile prompts: up to 3 prompts per traveler
  app.get('/me/prompts', async req => {
    const uid = await requireUser(req);
    const prompts = await sql`select id, prompt, answer, position, created_at from profile_prompts where user_id = ${uid} order by position asc, created_at asc`;
    return { prompts };
  });

  app.post('/me/prompts', async req => {
    const uid = await requireUser(req);
    const { prompt, answer } = z.object({
      prompt: z.string().refine(p => PROMPTS.includes(p), 'Invalid prompt question'),
      answer: z.string().trim().min(1).max(250)
    }).parse(req.body);

    const existing = await sql`select id, prompt from profile_prompts where user_id = ${uid}`;
    const match = existing.find(p => p.prompt === prompt);
    if (!match && existing.length >= 3) {
      throw bad('max_prompts_reached', 'You can answer up to 3 prompts.');
    }

    if (match) {
      const [updated] = await sql`update profile_prompts set answer = ${answer} where id = ${match.id} returning id, prompt, answer, position, created_at`;
      return { ok: true, prompt: updated };
    }

    const nextPos = existing.length;
    const [created] = await sql`insert into profile_prompts (user_id, prompt, answer, position)
      values (${uid}, ${prompt}, ${answer}, ${nextPos}) returning id, prompt, answer, position, created_at`;
    return { ok: true, prompt: created };
  });

  app.delete('/me/prompts/:id', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [deleted] = await sql`delete from profile_prompts where id = ${id} and user_id = ${uid} returning id`;
    if (!deleted) throw notFound('prompt_not_found');

    const remaining = await sql`select id from profile_prompts where user_id = ${uid} order by position asc, created_at asc`;
    for (let i = 0; i < remaining.length; i++) {
      await sql`update profile_prompts set position = ${i} where id = ${remaining[i].id}`;
    }
    return { ok: true };
  });

  app.put('/me/prompts/reorder', async req => {
    const uid = await requireUser(req);
    const { promptIds } = z.object({ promptIds: z.array(z.string().uuid()).min(1).max(3) }).parse(req.body);
    const existing = await sql`select id from profile_prompts where user_id = ${uid}`;
    const idSet = new Set(existing.map(p => p.id));
    if (promptIds.length !== existing.length || !promptIds.every(id => idSet.has(id))) {
      throw bad('invalid_prompt_ids');
    }
    for (let i = 0; i < promptIds.length; i++) {
      await sql`update profile_prompts set position = ${i} where id = ${promptIds[i]} and user_id = ${uid}`;
    }
    return { ok: true };
  });

  app.get('/users/:id', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [u] = await sql`select u.id, u.name, u.home_country, u.bio, u.photo_url, u.instagram, u.hide_plan_history, u.languages, u.interests, u.travel_style, u.city, u.verified, u.id_verified as "idVerified", u.id_verification_status as "idVerificationStatus", u.countries_visited, u.created_at,
        u.account_kind = 'team' as "isTeam",
        coalesce(u.boosted_until > now(), false) as is_boosted,
        date_part('year', age(u.birthdate))::int as age,
        (select count(*)::int from activity_members m where m.user_id = u.id) as activities_joined,
        (select count(*)::int from vouches v where v.vouched_id = u.id) as vouches,
        exists(select 1 from blocks b where b.blocker_id = ${uid} and b.blocked_id = u.id) as blocked_by_me
      from users u where u.id = ${id} and u.deleted_at is null and u.banned_at is null
        and not exists(select 1 from blocks b where b.blocker_id = u.id and b.blocked_id = ${uid})`;
    if (!u) throw bad('not_found');
    // One row per pair, refreshed at most daily. Snoozed or incognito viewers stay invisible here.
    // A new or bumped row (at most daily) is also the inbox notice; GET /inbox hides the name from free accounts.
    // An admin looking through someone's account (impersonation) is not that person viewing a profile: no view, no notice.
    const viewed = id !== uid && !u.blockedByMe && !impersonatorOf(req) ? await sql`insert into profile_views (viewer_id, viewed_id)
      select ${uid}, ${id} where not exists(select 1 from users where id = ${uid} and (snoozed_until > now() or is_incognito = true))
      on conflict (viewer_id, viewed_id) do update set viewed_at = now() where profile_views.viewed_at < now() - interval '24 hours' returning 1` : [];
    if (viewed.length) await addNotice([id], { kind: 'profile_view', actorId: uid, body: n => `${n} viewed your profile` });
    const photos = await sql`select id, url, position, created_at from user_photos where user_id = ${id} order by position asc, created_at asc`;
    const prompts = await sql`select id, prompt, answer, position, created_at from profile_prompts where user_id = ${id} order by position asc, created_at asc`;
    const [viewer] = await sql`select travel_style, interests from users where id = ${uid}`;
    const sharedInterests = (u.interests ?? []).filter((i: string) => (viewer?.interests ?? []).includes(i));
    const sharedTravelStyle = (u.travelStyle ?? []).filter((s: string) => (viewer?.travelStyle ?? []).includes(s));

    // Social & Contact shielding: Instagram visible if viewer is user, has Plus, or both share a plan
    const canViewInstagram = id === uid || (await isPlus(uid)) || (await sharePlan(uid, id));
    const instagram = canViewInstagram ? u.instagram : null;
    const instagramLocked = !canViewInstagram && !!u.instagram;

    // Response rate on 1:1 DMs (percentage of incoming DMs replied to)
    const [dmStats] = await sql`
      with incoming_dms as (
        select c.id as chat_id,
          (select m.sender_id from messages m where m.chat_id = c.id order by m.id asc limit 1) as first_sender,
          exists(select 1 from messages m where m.chat_id = c.id and m.sender_id = ${id}) as replied
        from chats c
        join chat_members cm on cm.chat_id = c.id and cm.user_id = ${id}
        where c.kind = 'dm'
      )
      select
        count(*) filter (where first_sender is not null and first_sender <> ${id})::int as incoming_count,
        count(*) filter (where first_sender is not null and first_sender <> ${id} and replied)::int as replied_count
      from incoming_dms`;
    const responseRate = dmStats && dmStats.incomingCount >= 2
      ? Math.round((dmStats.repliedCount / dmStats.incomingCount) * 100)
      : null;

    const [conn] = await sql`
      select
        exists(select 1 from connections where (user_id = ${uid} and friend_id = ${id}) or (user_id = ${id} and friend_id = ${uid})) as is_connected,
        exists(select 1 from connection_requests where sender_id = ${uid} and recipient_id = ${id} and status in ('pending', 'declined')) as requested,
        (select r.id from connection_requests r where r.sender_id = ${id} and r.recipient_id = ${uid} and r.status = 'pending') as incoming_request_id,
        (select count(*)::int from connections where friend_id = ${id}) as connections_count`;

    return {
      ...u,
      photos,
      prompts,
      sharedInterests,
      sharedTravelStyle,
      instagram,
      instagramLocked,
      isBoosted: !!u.isBoosted,
      memberSince: u.createdAt,
      responseRate,
      idVerified: !!u.idVerified,
      verificationTier: u.idVerified ? 'id_verified' : u.verified ? 'selfie' : 'unverified',
      // Since migration 077 a connection is always both ways, so "mutual" is the same as connected (kept for older apps).
      isConnected: !!conn?.isConnected,
      isMutual: !!conn?.isConnected,
      connectionStatus: conn?.isConnected ? 'connected' : conn?.requested ? 'requested' : conn?.incomingRequestId ? 'incoming' : 'none',
      incomingRequestId: conn?.isConnected ? null : conn?.incomingRequestId ?? null,
      connectionsCount: conn?.connectionsCount ?? 0,
    };
  });

  app.get('/users/:id/timeline', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const [u] = await sql`select id, name, created_at, verified, hide_plan_history, countries_visited from users where id = ${id} and deleted_at is null and banned_at is null`;
    if (!u) throw notFound('user_not_found');

    const isSelf = uid === id;
    const hidePlans = u.hidePlanHistory && !isSelf;

    // 1. Trips
    const trips = await sql`select id, city, country_code, start_date, end_date, created_at from trips where user_id = ${id} order by start_date desc`;

    // 2. Plans (hosted & joined) with photo album preview
    const plans = hidePlans ? [] : await sql`
      select a.id, a.title, a.emoji, a.category, a.city, a.place_name, a.starts_at,
        (a.host_id = ${id}) as is_host,
        (select count(*)::int from activity_members m where m.activity_id = a.id) as members_count,
        (select coalesce(json_agg(p), '[]') from (
          select ap.id, ap.url, ap.caption, ap.created_at from activity_photos ap where ap.activity_id = a.id order by ap.created_at asc limit 4
        ) p) as photos
      from activities a
      join activity_members m on m.activity_id = a.id
      where m.user_id = ${id} and a.starts_at < now() and a.status <> 'cancelled'
        -- Women-only plans stay invisible to everyone else here too (only women, or people who were in them).
        and (not a.women_only or exists(select 1 from users v where v.id = ${uid} and v.gender = 'woman')
          or exists(select 1 from activity_members vm where vm.activity_id = a.id and vm.user_id = ${uid}))
      order by a.starts_at desc limit 50`;

    // 3. Stats
    const [stats] = await sql`
      select
        (select count(*)::int from trips where user_id = ${id}) as trips_count,
        (select count(*)::int from activities where host_id = ${id} and status <> 'cancelled') as plans_hosted_count,
        (select count(*)::int from activity_members m join activities a on a.id = m.activity_id where m.user_id = ${id} and a.host_id <> ${id} and a.status <> 'cancelled') as plans_joined_count,
        (select count(*)::int from vouches where vouched_id = ${id}) as vouches_count,
        coalesce(cardinality(${u.countriesVisited ?? []}::text[]), 0) as countries_count`;

    const timelineItems: Array<{
      id: string;
      kind: 'trip' | 'plan' | 'verified' | 'joined';
      date: string;
      title: string;
      subtitle?: string;
      emoji?: string;
      photos?: Array<{ id: string; url: string; caption?: string }>;
      isHost?: boolean;
      membersCount?: number;
    }> = [];

    for (const t of trips) {
      timelineItems.push({
        id: `trip-${t.id}`,
        kind: 'trip',
        date: t.startDate,
        title: `Trip to ${t.city}`,
        subtitle: tripDateRange(t.startDate, t.endDate),
        emoji: '✈️',
      });
    }

    for (const p of plans) {
      timelineItems.push({
        id: `plan-${p.id}`,
        kind: 'plan',
        date: p.startsAt,
        title: p.title,
        subtitle: `${p.isHost ? 'Hosted' : 'Joined'} · ${p.city || p.placeName || ''}`,
        emoji: p.emoji || '📍',
        photos: p.photos ?? [],
        isHost: p.isHost,
        membersCount: p.membersCount,
      });
    }

    if (u.verified) {
      timelineItems.push({
        id: `verified-${u.id}`,
        kind: 'verified',
        date: u.createdAt,
        title: 'Verified Traveler',
        subtitle: 'Selfie face-match verified',
        emoji: '🛡️',
      });
    }

    timelineItems.push({
      id: `joined-${u.id}`,
      kind: 'joined',
      date: u.createdAt,
      title: 'Joined Tablamigo',
      subtitle: 'Started the journey',
      emoji: '🎒',
    });

    timelineItems.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    return {
      timeline: timelineItems,
      planHistoryHidden: hidePlans,
      stats: {
        tripsCount: stats?.tripsCount ?? 0,
        plansHostedCount: stats?.plansHostedCount ?? 0,
        plansJoinedCount: stats?.plansJoinedCount ?? 0,
        vouchesCount: stats?.vouchesCount ?? 0,
        countriesCount: stats?.countriesCount ?? 0,
      }
    };
  });

  // Connect: a request the other person accepts or declines (migration 077). Only an accepted request writes `connections`
  // (both directions), so chat, moments and friends' trips unlock on acceptance, never on the tap. If they had already asked
  // you, your Connect accepts theirs.
  app.post('/users/:id/connect', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { message } = z.object({ message: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    if (id === uid) throw bad('cannot_connect_self');
    const [target] = await sql`
      select u.id from users u where u.id = ${id} and u.deleted_at is null and u.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))`;
    if (!target) throw notFound('user_not_found');
    if (await areConnected(uid, id)) return { status: 'connected' as const, connected: true };

    const [theirs] = await sql`select id from connection_requests where sender_id = ${id} and recipient_id = ${uid} and status = 'pending'`;
    if (theirs) {
      await acceptConnection(theirs.id, uid, id);
      return { status: 'connected' as const, connected: true };
    }

    // A note to someone you aren't connected with: moderated and held to the DM contact rule, as a travel buddy note is.
    const note = message || null;
    if (note) {
      await assertClean(note);
      await assertNoContactsTo(uid, id, [note]);
    }
    const [prev] = await sql`select status, (declined_at > now() - interval '30 days') as recently_declined
      from connection_requests where sender_id = ${uid} and recipient_id = ${id}`;
    if (prev?.recentlyDeclined) {
      // Declined in the last 30 days: filed quietly, no notice or push, and the sender sees "Requested" as for any request.
      const [r] = await sql`update connection_requests set status = 'declined', message = ${note}
        where sender_id = ${uid} and recipient_id = ${id} returning id`;
      return { status: 'requested' as const, connected: false, requestId: r.id };
    }
    const [r] = await sql`
      insert into connection_requests (sender_id, recipient_id, message)
      values (${uid}, ${id}, ${note})
      on conflict (sender_id, recipient_id) do update
        set message = excluded.message, status = 'pending', responded_at = null,
            -- Re-sending after a cancel is a new request; re-tapping a pending one keeps its place.
            created_at = case when connection_requests.status = 'pending' then connection_requests.created_at else now() end
      returning id`;
    // One notice and push per request: re-tapping a pending one sends nothing again.
    if (prev?.status !== 'pending') {
      await addNotice([id], { kind: 'connection_request', actorId: uid, body: n => `${n} wants to connect with you.` });
      const [me] = await sql`select name from users where id = ${uid}`;
      void notify([id], {
        title: `${me?.name ?? 'Someone'} wants to connect`,
        body: note ? note.slice(0, 120) : 'Tap to accept or decline.',
        data: { userId: uid, nkind: 'connection_request', nref: r.id },
        tag: `connect-${uid}`,
      });
    }
    return { status: 'requested' as const, connected: false, requestId: r.id };
  });

  // Cancel your pending request, or remove an accepted connection (both directions).
  app.delete('/users/:id/connect', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    // A declined request cancels the same way (the sender never learns it was declined).
    await sql`update connection_requests set status = 'cancelled', responded_at = now()
      where sender_id = ${uid} and recipient_id = ${id} and status in ('pending', 'declined')`;
    await sql`delete from connections where (user_id = ${uid} and friend_id = ${id}) or (user_id = ${id} and friend_id = ${uid})`;
    return { status: 'none' as const, connected: false };
  });

  // Requests waiting for you (with Accept / Decline) and the ones you sent that are still pending (with Cancel).
  app.get('/connections/requests', async req => {
    const uid = await requireUser(req);
    const received = await sql`
      select r.id, r.message, r.created_at as "createdAt", u.id as "userId", u.name, u.photo_url as "photoUrl",
        u.home_country as "homeCountry", date_part('year', age(u.birthdate))::int as age, u.verified
      from connection_requests r join users u on u.id = r.sender_id
      where r.recipient_id = ${uid} and r.status = 'pending' and u.deleted_at is null and u.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
        -- Connected another way since (a travel buddy request): nothing left to answer.
        and not exists (select 1 from connections x where x.user_id = r.sender_id and x.friend_id = r.recipient_id)
      order by r.created_at desc limit 100`;
    const sent = await sql`
      select r.id, r.message, r.created_at as "createdAt", u.id as "userId", u.name, u.photo_url as "photoUrl",
        u.home_country as "homeCountry", date_part('year', age(u.birthdate))::int as age, u.verified
      from connection_requests r join users u on u.id = r.recipient_id
      where r.sender_id = ${uid} and r.status in ('pending', 'declined') and u.deleted_at is null and u.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))
        -- Connected another way since (a travel buddy request): nothing left to answer.
        and not exists (select 1 from connections x where x.user_id = r.sender_id and x.friend_id = r.recipient_id)
      order by r.created_at desc limit 100`;
    return { received, sent };
  });

  app.post('/connections/requests/:id/respond', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { action } = z.object({ action: z.enum(['accept', 'decline']) }).parse(req.body);
    const [r] = await sql`
      select r.id, r.sender_id from connection_requests r join users u on u.id = r.sender_id
      where r.id = ${id} and r.recipient_id = ${uid} and r.status = 'pending' and u.deleted_at is null and u.banned_at is null
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = r.sender_id) or (b.blocker_id = r.sender_id and b.blocked_id = ${uid}))`;
    if (!r) throw notFound('request_not_found');
    if (action === 'decline') {
      // The sender is not told; their button keeps saying Requested, as on other networks.
      await sql`update connection_requests set status = 'declined', responded_at = now(), declined_at = now() where id = ${id}`;
      return { status: 'declined' as const, connected: false };
    }
    await acceptConnection(id, uid, r.senderId);
    return { status: 'connected' as const, connected: true };
  });

  // List connected friends with their upcoming trips
  app.get('/connections', async req => {
    const uid = await requireUser(req);
    const rows = await sql`
      select u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        date_part('year', age(u.birthdate))::int as age, u.verified,
        ${plusOf('u')} as plus,
        u.travel_style as "travelStyle",
        exists(select 1 from connections c2 where c2.user_id = u.id and c2.friend_id = ${uid}) as is_mutual,
        (
          select coalesce(json_agg(json_build_object('id', t.id, 'city', t.city, 'countryCode', t.country_code, 'startDate', t.start_date, 'endDate', t.end_date) order by t.start_date asc), '[]')
          from trips t where t.user_id = u.id and t.end_date >= current_date
        ) as upcoming_trips
      from connections c
      join users u on u.id = c.friend_id
      where c.user_id = ${uid} and u.deleted_at is null and u.banned_at is null
      order by c.created_at desc`;
    return { connections: rows };
  });

  // Feature 21: Friends & Follow Feed — Chronological upcoming trips of connected friends
  app.get('/connections/trips', async req => {
    const uid = await requireUser(req);
    const rows = await sql`
      select
        t.id as "tripId",
        t.city,
        t.country_code as "countryCode",
        t.start_date as "startDate",
        t.end_date as "endDate",
        u.id as "friendId",
        u.name as "friendName",
        u.photo_url as "friendPhotoUrl",
        u.home_country as "friendHomeCountry",
        u.verified as "friendVerified",
        ${plusOf('u')} as "friendPlus",
        u.travel_style as "friendTravelStyle",
        exists(select 1 from connections c2 where c2.user_id = u.id and c2.friend_id = ${uid}) as "isMutual",
        exists(
          select 1 from trips myt
          where myt.user_id = ${uid}
            and lower(myt.city) = lower(t.city)
            and myt.start_date <= t.end_date
            and myt.end_date >= t.start_date
        ) as "isOverlapping"
      from connections c
      join users u on u.id = c.friend_id
      join trips t on t.user_id = u.id
      where c.user_id = ${uid}
        and t.end_date >= current_date
        and u.deleted_at is null
        and u.banned_at is null
        and not exists (
          select 1 from blocks b
          where (b.blocker_id = ${uid} and b.blocked_id = u.id)
             or (b.blocker_id = u.id and b.blocked_id = ${uid})
        )
      order by t.start_date asc
      limit 50`;
    return { trips: rows };
  });

  // Feature 22: "Who's here now" settings for caller
  app.get('/me/here-now', async req => {
    const uid = await requireUser(req);
    const [u] = await sql`
      select here_now_opt_in as "hereNowOptIn",
             here_now_snooze_until as "hereNowSnoozeUntil",
             here_now_status as "hereNowStatus",
             city
      from users where id = ${uid}`;
    const isSnoozed = !!(u?.hereNowSnoozeUntil && new Date(u.hereNowSnoozeUntil) > new Date());
    return {
      optIn: u?.hereNowOptIn ?? false,
      isSnoozed,
      snoozeUntil: u?.hereNowSnoozeUntil ?? null,
      status: u?.hereNowStatus ?? null,
      city: u?.city ?? null
    };
  });

  const HereNowBody = z.object({
    optIn: z.boolean().optional(),
    snoozeHours: z.number().int().min(0).max(720).optional(),
    status: z.string().max(80).nullable().optional()
  });

  app.put('/me/here-now', async req => {
    const uid = await requireUser(req);
    const b = HereNowBody.parse(req.body);

    if (b.snoozeHours !== undefined) {
      if (b.snoozeHours === 0) {
        await sql`update users set here_now_snooze_until = null where id = ${uid}`;
      } else {
        await sql`update users set here_now_snooze_until = now() + (${b.snoozeHours} || ' hours')::interval where id = ${uid}`;
      }
    }
    if (b.optIn !== undefined) {
      await sql`update users set here_now_opt_in = ${b.optIn} where id = ${uid}`;
    }
    if (b.status !== undefined) {
      await sql`update users set here_now_status = ${b.status} where id = ${uid}`;
    }

    const [u] = await sql`
      select here_now_opt_in as "hereNowOptIn",
             here_now_snooze_until as "hereNowSnoozeUntil",
             here_now_status as "hereNowStatus",
             city
      from users where id = ${uid}`;
    const isSnoozed = !!(u?.hereNowSnoozeUntil && new Date(u.hereNowSnoozeUntil) > new Date());
    return {
      optIn: u?.hereNowOptIn ?? false,
      isSnoozed,
      snoozeUntil: u?.hereNowSnoozeUntil ?? null,
      status: u?.hereNowStatus ?? null,
      city: u?.city ?? null
    };
  });

  // Host rewards (lib/host-rewards.ts): the rule's numbers and what this person has earned, for the app's "Host and earn Plus" card.
  app.get('/me/host-rewards', async req => hostRewardSummary(await requireUser(req)));

  // Referral details and unique invite link
  app.get('/me/referral', async req => {
    const uid = await requireUser(req);
    const [u] = await sql`select referral_code from users where id = ${uid}`;
    let code: string | null = u?.referralCode ?? null;
    // The first look makes the person's code. An admin looking at the account (lib/auth.ts) writes nothing: no code yet, none shown.
    if (!code && !impersonatorOf(req)) code = await ensureInviteCode(uid);
    const [{ count }] = await sql`select count(*)::int as count from users where referred_by = ${uid}`;
    return {
      referralCode: code,
      referralLink: code ? inviteLink(code) : null,
      rewardDays: REFERRAL.rewardDays,
      maxRewards: REFERRAL.maxRewards,
      totalReferred: count,
      // Only the first maxRewards sign-ups earn days (see /me/referral/redeem), so the total stops there too.
      daysEarned: Math.min(count, REFERRAL.maxRewards) * REFERRAL.rewardDays
    };
  });

  // Redeem a referral code by hand (Profile > Invite friends). Sign-ups that arrive through an invite link redeem it automatically
  // (routes/auth.ts, lib/referral.ts autoRedeemAtSignup).
  app.post('/me/referral/redeem', async req => {
    const uid = await requireUser(req);
    const { code } = z.object({ code: z.string().trim().toUpperCase().min(3).max(20) }).parse(req.body);
    // A creator partner's code (lib/affiliate-ledger.ts): the account becomes their referral, within SIGNUP_CODE_DAYS of signing
    // up. It gives no Plus days (partner: true tells the app to say so). Anything else is a friend's invite code.
    const partner = await attributeReferral(uid, code, 'signup_code', SIGNUP_CODE_DAYS);
    if (partner === 'attributed') {
      const [u] = await sql`select plus_until from users where id = ${uid}`;
      return { ok: true, partner: true, rewardDays: 0, plusUntil: u?.plusUntil ?? null, referrerRewarded: false };
    }
    if (partner === 'already_referred') throw bad('already_referred', 'A partner code is already applied to your account.');
    if (partner === 'self_referral') throw bad('cannot_refer_self', 'You cannot use your own partner code.');
    if (partner === 'referral_loop') throw bad('referral_loop', 'That partner joined through your code, so their code can\'t be used on your account.');
    if (partner === 'too_late') throw bad('referral_new_accounts_only', `Partner codes work in your first ${SIGNUP_CODE_DAYS} days on Tablamigo.`);
    if (partner === 'inactive') throw bad('invalid_code', 'That code is no longer active.');
    return redeemReferral(uid, code);
  });

  // Profile Boost: 24h spotlight ranking at the top of travelers and city lists
  app.post('/me/boost', async req => {
    const uid = await requireUser(req);
    const plus = await isPlus(uid);
    if (!plus) throw forbidden('plus_required', 'Profile Boost requires Tablamigo Plus.');
    await sql`update users set boosted_until = now() + interval '24 hours' where id = ${uid}`;
    const [u] = await sql`select boosted_until as "boostedUntil" from users where id = ${uid}`;
    await sql`insert into analytics_events (user_id, event_name, properties) values (${uid}, 'profile_boosted', ${sql.json({ boostedUntil: u.boostedUntil } as any)})`;
    return { ok: true, isBoosted: true, boostedUntil: u.boostedUntil };
  });

  // Incognito mode toggle: browse other profiles without triggering profile views
  app.post('/me/incognito', async req => {
    const uid = await requireUser(req);
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const plus = await isPlus(uid);
    if (enabled && !plus) throw forbidden('plus_required', 'Incognito browsing requires Tablamigo Plus.');
    await sql`update users set is_incognito = ${enabled} where id = ${uid}`;
    return { ok: true, isIncognito: enabled };
  });

  // Trip Pass Wallet & Bundle Catalogue (Backlog 30)
  app.get('/me/trip-passes', async req => {
    const uid = await requireUser(req);
    const [u] = await sql`select trip_passes_available as "tripPassesAvailable", plus_until as "plusUntil" from users where id = ${uid}`;
    const wallet = await sql`
      select id, source, passes_added as "passesAdded", passes_remaining as "passesRemaining", price_cents as "priceCents", currency, created_at as "createdAt"
      from trip_pass_wallet
      where user_id = ${uid}
      order by created_at desc`;
    const redemptions = await sql`
      select r.id, r.trip_id as "tripId", r.days_granted as "daysGranted", r.redeemed_at as "redeemedAt", r.plus_until_after as "plusUntilAfter",
        t.city, t.country_code as "countryCode"
      from trip_pass_redemptions r
      left join trips t on t.id = r.trip_id
      where r.user_id = ${uid}
      order by r.redeemed_at desc`;
    // Bundles are not on sale (POST /me/trip-pass/bundle is off), so there is no catalogue to show.
    const bundles: never[] = [];
    return {
      available: u?.tripPassesAvailable ?? 0,
      plusUntil: u?.plusUntil ?? null,
      wallet,
      redemptions,
      bundles,
      bundlesAvailable: false
    };
  });

  // Redeem a held Trip Pass from the wallet (14 days of Plus). The days are a row in `passes`, like a bought pass, and
  // plus_until is recomputed from it: writing plus_until by hand let the next billing event wipe the redeemed days.
  app.post('/me/trip-pass/redeem', async req => {
    const uid = await requireUser(req);
    const { tripId } = z.object({ tripId: z.string().uuid().optional().nullable() }).parse(req.body ?? {});
    if (tripId) {
      const [t] = await sql`select id from trips where id = ${tripId} and user_id = ${uid}`;
      if (!t) throw notFound('trip_not_found');
    }

    const redeemed = await sql.begin(async tx => {
      // Taken atomically, so two taps at once can't spend one pass twice.
      const [u] = await tx`update users set trip_passes_available = trip_passes_available - 1
        where id = ${uid} and trip_passes_available > 0 returning trip_passes_available as "tripPassesAvailable"`;
      if (!u) throw bad('no_trip_passes_available', 'You do not have any available Trip Passes.');
      const [w] = await tx`select id from trip_pass_wallet where user_id = ${uid} and passes_remaining > 0
        order by created_at asc limit 1 for update`;
      if (w) await tx`update trip_pass_wallet set passes_remaining = passes_remaining - 1 where id = ${w.id}`;
      const redemptionId = crypto.randomUUID();
      const [p] = await tx`insert into passes (purchase_token, user_id, product_id, order_id, expires_at, raw)
        select ${'wallet:' + redemptionId}, ${uid}, ${PASS_SKU}, ${w?.id ?? null},
          greatest(now(), coalesce(x.plus_until, now())) + ${PASS_DAYS + ' days'}::interval, ${sql.json({ source: 'trip_pass_wallet', walletId: w?.id ?? null })}
        from users x where x.id = ${uid} returning expires_at`;
      await tx`insert into trip_pass_redemptions (id, user_id, wallet_id, trip_id, days_granted, plus_until_after)
        values (${redemptionId}, ${uid}, ${w?.id ?? null}, ${tripId ?? null}, ${PASS_DAYS}, ${p.expiresAt})`;
      return u.tripPassesAvailable as number;
    });
    await recomputePlus(uid);
    const [updated] = await sql`select plus_until as "plusUntil" from users where id = ${uid}`;

    await sql`insert into analytics_events (user_id, event_name, properties) values (${uid}, 'trip_pass_redeemed', ${sql.json({ tripId: tripId ?? null, plusUntil: updated.plusUntil } as any)})`;
    return { ok: true, tripPassesAvailable: redeemed, plusUntil: updated.plusUntil };
  });

  // Off: this added 1-10 passes for any signed-in user with no payment at all, and took the source, price and order
  // id from the client (free Plus, audit 3 Oct 2026). To sell bundles, add Play products (e.g. tablamigo_trip_pass_3,
  // _5) and a verified Razorpay order, and credit trip_pass_wallet only after the server has verified that payment,
  // with the count, source and price decided by the server.
  app.post('/me/trip-pass/bundle', async () => {
    throw new HttpError(410, 'trip_pass_bundles_unavailable', 'Trip Pass bundles are not on sale.');
  });

  // Analytics event ingestion (both /analytics/event and /analytics/events). Anonymous calls are allowed, so everything is
  // bounded: at most 50 events a request, each with a short name and at most 20 properties of 1 KB in all, a 64 KB body,
  // 60 requests a minute per client, and one insert for the whole batch. A paywall_viewed reason is kept only if it is a known one
  // (lib/paywall-reasons.ts), else stored as 'other'.
  const EVENT_PROPS = { maxKeys: 20, maxBytes: 1024 };
  const smallProps = (p: Record<string, unknown>) => {
    try { return Object.keys(p).length <= EVENT_PROPS.maxKeys && Buffer.byteLength(JSON.stringify(p)) <= EVENT_PROPS.maxBytes; }
    catch { return false; }   // nested too deep to serialise
  };
  const event = z.object({
    event: z.string().min(1).max(64),
    properties: z.record(z.string().max(40), z.any()).refine(smallProps, `at most ${EVENT_PROPS.maxKeys} properties and ${EVENT_PROPS.maxBytes} bytes`).optional(),
    timestamp: z.string().max(40).optional(),
  });
  const eventBatch = z.union([event, z.object({ events: z.array(event).min(1).max(50) })]);
  const ingestEvents = async (req: any) => {
    let uid: string | null = null;
    try { uid = await requireUser(req); } catch { /* anonymous allowed */ }
    const body = eventBatch.parse(req.body);
    const items = 'events' in body ? body.events : [body];
    const rows = items.map(i => ({ user_id: uid, event_name: i.event, properties: sql.json(withPaywallReason(i.event, i.properties ?? {}) as any) }));
    await sql`insert into analytics_events ${sql(rows, 'user_id', 'event_name', 'properties')}`;
    return { ok: true, recorded: items.length };
  };
  const ingestOpts = { bodyLimit: 64 * 1024, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
  app.post('/analytics/events', ingestOpts, ingestEvents);
  app.post('/analytics/event', ingestOpts, ingestEvents);
}
