import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { forbidden, notFound, needsPlus } from '../lib/errors.js';
import { joinUserToChat, dropNonListeners } from '../lib/realtime.js';
import { assertClean } from '../lib/moderation.js';
import { isPlus, LIMITS, plusOf } from '../lib/plus.js';
import { cityChatId } from '../lib/city-chats.js';

// A city page or chat is one of the curated city guides. Slugs are lower-case letters, digits and dashes: never ':',
// so nobody can name a chat key such as "delhi:women" themselves (the women-only key is built here, from the guide).
const slugParam = z.object({ slug: z.string().min(2).max(60).regex(/^[a-zA-Z0-9-]+$/) });
// The page id can be the guide slug ('bangkok') or the city's cityKey ('bangkok-th'): both reach the same guide, and the
// chat key of a guide is always its cityKey (chat_key, migration 055).
async function guideFor(slug: string) {
  const clean = slug.toLowerCase();
  const [guide] = await sql`select slug, city, country_code as "countryCode", chat_key as "chatKey" from city_guides
    where slug = ${clean} or chat_key = ${clean} or slug = split_part(${clean}, '-', 1)
    order by (slug = ${clean}) desc, (chat_key = ${clean}) desc limit 1`;
  return guide as { slug: string; city: string; countryCode: string; chatKey: string } | undefined;
}

// A place without a curated guide ('mapusa-in' or 'mapusa', from a moment's or a plan's place link): the name as people
// wrote it on a trip, a moment or a plan there, so its page lists that place's upcoming plans. Undefined when nothing real
// was ever posted under that name. Its page lists no people (a small place would all but pin someone down): no visiting
// travellers, no here-now, no city chat. Those stay with the curated guides.
const slugify = (col: any) => sql`trim(both '-' from regexp_replace(lower(${col}), '[^a-z0-9]+', '-', 'g'))`;
async function placeFor(slug: string) {
  const key = slug.toLowerCase();
  // 'hoi-an-vn' is Hoi An in VN, but a bare 'hoi-an' is Hoi An too, not "Hoi" in country AN: the whole key is always tried as
  // a name, and the name before a 2-letter ending only together with that country.
  const m = /^(.{2,})-([a-z]{2})$/.exec(key);
  const name = m?.[1] ?? null, cc = m?.[2] ?? null;
  const [row] = await sql`
    select city, "countryCode" from (
      select t.city, upper(t.country_code) as "countryCode", 1 as pri from trips t join users u on u.id = t.user_id
        where t.city_key = ${key} and u.deleted_at is null and u.banned_at is null
      union all
      select m.city, upper(m.country_code), 2 from moments m
        where m.deleted_at is null and (${slugify(sql`m.city`)} = ${key} or (${name}::text is not null and ${slugify(sql`m.city`)} = ${name} and lower(m.country_code) = ${cc}))
      union all
      select a.city, null, 3 from activities a
        where a.city is not null and a.status = 'active' and not a.women_only and ${slugify(sql`a.city`)} = ${key}
    ) x where city is not null and lower(city) <> 'worldwide' order by pri limit 1`;
  if (!row) return undefined;
  return { slug: key, city: row.city as string, countryCode: (row.countryCode as string | null) ?? null };
}

// Never someone deleted, banned, snoozed or incognito, or on either side of a block with the viewer.
const visiblePerson = (uid: string) => sql`u.deleted_at is null and u.banned_at is null
  and (u.snoozed_until is null or u.snoozed_until <= now()) and not coalesce(u.is_incognito, false)
  and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))`;

const cities: FastifyPluginAsync = async app => {
  // Public or auth: list of all curated cities with activity count & chat
  app.get('/cities', async () => {
    const rows = await sql`
      select 
        cg.slug, cg.city, cg.country, cg.country_code as "countryCode",
        cg.emoji, cg.intro, cg.best_season as "bestSeason",
        (
          select count(*)::int from activities a 
          where (lower(a.city) = lower(cg.city) or (cg.location is not null and ST_DWithin(a.location, cg.location, 45000)))
            and a.status = 'active' 
            and a.starts_at between now() - interval '2 hours' and now() + interval '30 days'
        ) as "plansCount",
        (
          select count(distinct t.user_id)::int from trips t 
          where lower(t.city) = lower(cg.city) and t.end_date >= current_date
        ) as "travelersCount",
        c.id as "chatId",
        cw.id as "womenChatId"
      from city_guides cg
      left join chats c on c.city_key = cg.chat_key and c.kind = 'city'
      left join chats cw on cw.city_key = cg.chat_key || ':women' and cw.kind = 'city' and cw.women_only = true
      order by "plansCount" desc, cg.city asc
    `;
    return { cities: rows };
  });

  // City detail: guide, upcoming plans, visiting travelers, and chat ID
  // Signed-in only: it lists people visiting the city.
  app.get('/cities/:slug', async req => {
    const uid = await requireUser(req);
    const { slug } = slugParam.parse(req.params);
    const cleanSlug = slug.toLowerCase();
    const [guide] = await sql`
      select 
        cg.slug, cg.city, cg.country, cg.country_code as "countryCode",
        cg.emoji, cg.intro, cg.areas, cg.plans, cg.safety, cg.women_safety as "womenSafety",
        cg.best_season as "bestSeason",
        c.id as "chatId",
        cw.id as "womenChatId"
      from city_guides cg
      left join chats c on c.city_key = cg.chat_key and c.kind = 'city'
      left join chats cw on cw.city_key = cg.chat_key || ':women' and cw.kind = 'city' and cw.women_only = true
      where cg.slug = ${cleanSlug} or cg.chat_key = ${cleanSlug} or cg.slug = split_part(${cleanSlug}, '-', 1)
      order by (cg.slug = ${cleanSlug}) desc, (cg.chat_key = ${cleanSlug}) desc
      limit 1
    `;
    let place: Awaited<ReturnType<typeof placeFor>> | undefined;
    if (!guide) place = await placeFor(cleanSlug);
    if (!guide && !place) throw notFound('city_not_found');
    const g: any = guide ?? { ...place, country: null, emoji: '📍', intro: null, areas: null, plans: null, safety: null, womenSafety: null, bestSeason: null, chatId: null, womenChatId: null };

    // Fetch active upcoming plans for this city
    const activities = await sql`
      select 
        a.id, a.title, a.emoji, a.category, a.description, a.place_name as "placeName",
        a.starts_at as "startsAt", a.max_people as "maxPeople",
        ST_Y(a.location::geometry) as lat, ST_X(a.location::geometry) as lng,
        json_build_object(
          'id', h.id, 'name', h.name, 'photoUrl', h.photo_url, 'homeCountry', h.home_country, 'verified', h.verified,
          'isTeam', h.account_kind = 'team'
        ) as host,
        (select count(*)::int from activity_members m where m.activity_id = a.id and m.rsvp_status = 'going') as going
      from activities a
      join users h on h.id = a.host_id
      where (
        lower(a.city) = lower(${g.city})
        or (select ST_DWithin(a.location, cg.location, 45000) from city_guides cg where cg.slug = ${g.slug})
      )
        and a.status = 'active'
        and not a.closed
        and a.starts_at between now() - interval '2 hours' and now() + interval '30 days'
        and h.deleted_at is null and h.banned_at is null
        and (not a.women_only or exists(select 1 from users v where v.id = ${uid} and v.gender = 'woman'))
        and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = a.host_id) or (b.blocker_id = a.host_id and b.blocked_id = ${uid}))
      order by a.starts_at asc
      limit 25
    `;

    // Fetch travelers visiting this city soon
    const visitingTravelers = await sql`
      select distinct on (u.id)
        u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        u.verified, date_part('year', age(u.birthdate))::int as age,
        t.start_date as "tripStartDate", t.end_date as "tripEndDate"
      from trips t
      join users u on u.id = t.user_id
      where ${!!guide} and (lower(t.city) = lower(${g.city}) or t.city_key = ${g.slug})
        and t.end_date >= current_date
        and ${visiblePerson(uid)}
      order by u.id, t.start_date asc
      limit 20
    `;

    return {
      ...g,
      guide: !!guide,
      activities,
      visitingTravelers,
      plansCount: activities.length,
      travelersCount: visitingTravelers.length
    };
  });

  // Feature 22: "Who's Here Now": signed-in only, people in the city who opted in (off by default, migration 053),
  // and never anyone snoozed, incognito or on either side of a block with the viewer.
  app.get('/cities/:slug/here-now', async req => {
    const uid = await requireUser(req);
    const { slug } = slugParam.parse(req.params);
    const guide = await guideFor(slug);
    if (!guide) throw notFound('city_not_found');

    const rows = await sql`
      select distinct on (u.id)
        u.id, u.name, u.photo_url as "photoUrl", u.home_country as "homeCountry",
        u.verified, date_part('year', age(u.birthdate))::int as age,
        ${plusOf('u')} as plus,
        u.here_now_status as status,
        u.travel_style as "travelStyle"
      from users u
      left join trips t on t.user_id = u.id and current_date between t.start_date and t.end_date
      where (
        lower(u.city) = lower(${guide.city})
        or lower(t.city) = lower(${guide.city})
        or t.city_key = ${guide.slug}
      )
        and u.onboarded
        and u.id <> ${uid}
        and u.here_now_opt_in = true
        and (u.here_now_snooze_until is null or u.here_now_snooze_until < now())
        and ${visiblePerson(uid)}
      order by u.id, u.plus_until desc nulls last
      limit 30
    `;
    return {
      city: guide.city,
      count: rows.length,
      travelers: rows
    };
  });

  // Feature 28: Join general or women-only city chat. Known city guides only; the chat key comes from the guide.
  app.post('/cities/:slug/join-chat', async req => {
    const uid = await requireUser(req);
    const { slug } = slugParam.parse(req.params);
    const { womenOnly } = z.object({ womenOnly: z.boolean().optional() }).parse(req.body ?? {});
    const guide = await guideFor(slug);
    if (!guide) throw notFound('city_not_found');

    const [me] = await sql`select gender, city from users where id = ${uid}`;
    if (womenOnly && me?.gender !== 'woman') {
      throw forbidden('women_only', 'Only women travelers can join women-only city chats.');
    }
    // Free accounts: the same window as /trips/:id/city-chat. In the city now, or a trip there starting within
    // LIMITS.free.cityChatDaysAhead days; joining earlier (or without a trip) is a Plus feature.
    if (!(await isPlus(uid))) {
      const here = !!me?.city && me.city.toLowerCase() === guide.city.toLowerCase();
      const [soon] = here ? [true] : await sql`select 1 from trips t where t.user_id = ${uid} and t.end_date >= current_date
        and t.start_date <= current_date + ${LIMITS.free.cityChatDaysAhead}::int
        and (lower(t.city) = lower(${guide.city}) or t.city_key = ${guide.slug} or split_part(t.city_key, '-', 1) = ${guide.slug})`;
      if (!soon) throw needsPlus('city_chat_early');
    }

    const chatTitle = womenOnly ? `${guide.city} Women Nomads 🌸` : `${guide.city} travelers`;

    // The chat key is the guide's cityKey, the same chat a trip or "where you are" opens (lib/city-chats.ts). A women's
    // chat is always women_only, even if a row with that key already existed.
    const chatId = await cityChatId(guide.chatKey, chatTitle, !!womenOnly);
    await sql`insert into chat_members (chat_id, user_id) values (${chatId}, ${uid}) on conflict do nothing`;
    joinUserToChat(uid, chatId);
    // A pre-existing mixed chat on this key just became women-only: anyone else's sockets leave its room.
    if (womenOnly) await dropNonListeners(chatId);

    return {
      chatId,
      title: chatTitle,
      womenOnly: !!womenOnly
    };
  });

  const TIP_CATEGORIES = ['food', 'sunset', 'coworking', 'nightlife', 'safety', 'transit', 'general'] as const;

  // Feature 25: Get community local tips for a city
  app.get('/cities/:slug/tips', async req => {
    const { slug } = z.object({ slug: z.string().min(2).max(60) }).parse(req.params);
    const { category } = z.object({ category: z.enum(TIP_CATEGORIES).optional() }).parse(req.query);
    const cleanSlug = slug.toLowerCase();

    let uid: string | null = null;
    try {
      uid = await requireUser(req);
    } catch {
      uid = null;
    }

    const rows = await sql`
      select 
        t.id, t.city_slug as "citySlug", t.category, t.title, t.body, t.place_name as "placeName",
        t.helpful_count as "helpfulCount", t.created_at as "createdAt",
        json_build_object(
          'id', u.id, 'name', u.name, 'photoUrl', u.photo_url, 'homeCountry', u.home_country, 'verified', u.verified
        ) as author,
        ${uid ? sql`exists(select 1 from city_tip_upvotes v where v.tip_id = t.id and v.user_id = ${uid})` : sql`false`} as "hasUpvoted"
      from city_tips t
      join users u on u.id = t.user_id
      where (t.city_slug = ${cleanSlug} or t.city_slug = split_part(${cleanSlug}, '-', 1))
        and (${category ?? null}::text is null or t.category = ${category ?? null})
        and u.deleted_at is null and u.banned_at is null
        ${uid ? sql`and not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = u.id) or (b.blocker_id = u.id and b.blocked_id = ${uid}))` : sql``}
      order by t.helpful_count desc, t.created_at desc
      limit 50
    `;
    return { tips: rows };
  });

  // Feature 25: Post a community local tip / hidden gem
  app.post('/cities/:slug/tips', async req => {
    const uid = await requireUser(req);
    const { slug } = z.object({ slug: z.string().min(2).max(60) }).parse(req.params);
    const body = z.object({
      category: z.enum(TIP_CATEGORIES).default('general'),
      title: z.string().trim().min(3).max(120),
      body: z.string().trim().min(10).max(600),
      placeName: z.string().trim().max(160).optional().nullable()
    }).parse(req.body);

    const [me] = await sql`select onboarded from users where id = ${uid}`;
    if (!me?.onboarded) throw forbidden('profile_incomplete', 'Complete onboarding to post tips.');

    await assertClean(`${body.title}\n${body.body}`);

    const cleanSlug = slug.toLowerCase();
    const [tip] = await sql`
      insert into city_tips (city_slug, user_id, category, title, body, place_name)
      values (${cleanSlug}, ${uid}, ${body.category}, ${body.title}, ${body.body}, ${body.placeName ?? null})
      returning id, city_slug as "citySlug", category, title, body, place_name as "placeName", helpful_count as "helpfulCount", created_at as "createdAt"
    `;

    const [u] = await sql`select id, name, photo_url as "photoUrl", home_country as "homeCountry", verified from users where id = ${uid}`;

    return {
      ...tip,
      author: u,
      hasUpvoted: false
    };
  });

  // Feature 25: Helpful upvote on a community tip
  app.post('/cities/tips/:id/upvote', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);

    const [tip] = await sql`select id, user_id from city_tips where id = ${id}`;
    if (!tip) throw notFound('tip_not_found');

    const [existing] = await sql`select 1 from city_tip_upvotes where tip_id = ${id} and user_id = ${uid}`;
    if (existing) {
      await sql`delete from city_tip_upvotes where tip_id = ${id} and user_id = ${uid}`;
      await sql`update city_tips set helpful_count = greatest(0, helpful_count - 1) where id = ${id}`;
    } else {
      await sql`insert into city_tip_upvotes (tip_id, user_id) values (${id}, ${uid}) on conflict do nothing`;
      await sql`update city_tips set helpful_count = helpful_count + 1 where id = ${id}`;
    }

    const [updated] = await sql`select helpful_count as "helpfulCount" from city_tips where id = ${id}`;
    return {
      ok: true,
      upvoted: !existing,
      helpfulCount: updated.helpfulCount
    };
  });
};

export default cities;
