import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['rec_host', 'rec_member', 'rec_other'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@recurrence.tablamigo`).join(',');
process.env.REVIEW_CODE = '555555';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 900;
async function login(name: string): Promise<Api> {
  const email = `${name}@recurrence.tablamigo`;
  const remoteAddress = `10.99.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '555555' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1995-05-05', gender: 'woman', homeCountry: 'ES' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@recurrence.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@recurrence.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
  // Give admin role and Plus to rec_host for testing admin and activity creation
  await sql`update users set role = 'admin', plus_until = now() + interval '30 days' where email = ${'rec_host@recurrence.tablamigo'}`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@recurrence.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Recurring Plans Generation & Series Tracking', () => {
  let initialActivityId: string;
  let nextActivityId: string;
  const initialStarts = new Date(Date.now() + 86400_000); // 1 day from now

  it('creates a weekly recurring activity with initial series tracking', async () => {
    const res = await u.rec_host('POST', '/activities', {
      title: 'Weekly Sunset Run Club',
      emoji: '🏃',
      category: 'sports',
      description: 'Weekly 5k run along the beach followed by drinks.',
      placeName: 'Barceloneta Beach Boardwalk',
      placeAddress: 'Passeig Marítim de la Barceloneta',
      lat: 41.3809,
      lng: 2.1909,
      startsAt: initialStarts.toISOString(),
      maxPeople: 12,
      womenOnly: false,
      recurrence: 'weekly'
    });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    initialActivityId = json.id;
    expect(initialActivityId).toBeDefined();

    // Verify detail endpoint returns recurrence metadata
    const detail = await u.rec_host('GET', `/activities/${initialActivityId}`);
    expect(detail.statusCode).toBe(200);
    const d = detail.json();
    expect(d.recurrence).toBe('weekly');
    expect(d.occurrenceNumber).toBe(1);
    expect(d.seriesId).toBe(initialActivityId);
    expect(d.nextActivityId).toBeNull();
  });

  it('allows another user to join the weekly recurring plan', async () => {
    const joinRes = await u.rec_member('POST', `/activities/${initialActivityId}/join`, { rsvp: 'going' });
    expect(joinRes.statusCode).toBe(200);
  });

  it('enforces that only host or admin can advance recurrence', async () => {
    const failRes = await u.rec_other('POST', `/activities/${initialActivityId}/advance-recurrence`);
    expect(failRes.statusCode).toBe(403);
  });

  it('generates next weekly occurrence when host advances series', async () => {
    const advanceRes = await u.rec_host('POST', `/activities/${initialActivityId}/advance-recurrence`);
    expect(advanceRes.statusCode).toBe(200);
    const adv = advanceRes.json();

    expect(adv.ok).toBe(true);
    expect(adv.nextActivityId).toBeDefined();
    nextActivityId = adv.nextActivityId;
    expect(adv.occurrenceNumber).toBe(2);

    // Verify nextStartsAt is ~7 days after initialStarts
    const nextDate = new Date(adv.startsAt);
    const diffDays = Math.round((nextDate.getTime() - initialStarts.getTime()) / (1000 * 60 * 60 * 24));
    expect(diffDays).toBe(7);

    // Verify old activity now points to next activity
    const oldDetail = await u.rec_host('GET', `/activities/${initialActivityId}`);
    expect(oldDetail.json().nextActivityId).toBe(nextActivityId);

    // Verify new activity has seriesId and parentActivityId
    const newDetail = await u.rec_host('GET', `/activities/${nextActivityId}`);
    expect(newDetail.statusCode).toBe(200);
    const nd = newDetail.json();
    expect(nd.seriesId).toBe(initialActivityId);
    expect(nd.parentActivityId).toBe(initialActivityId);
    expect(nd.occurrenceNumber).toBe(2);
    expect(nd.title).toBe('Weekly Sunset Run Club');

    // Calling advance again on the same activity returns alreadyGenerated
    const secondAdv = await u.rec_host('POST', `/activities/${initialActivityId}/advance-recurrence`);
    expect(secondAdv.statusCode).toBe(200);
    expect(secondAdv.json().alreadyGenerated).toBe(true);
  });

  it('delivers inbox notification to past attendees when next session is scheduled', async () => {
    const memberId = await idOf('rec_member');
    const [notice] = await sql`
      select id, kind, body, activity_id
      from notifications
      where user_id = ${memberId} and kind = 'recurring_next'
    `;
    expect(notice).toBeDefined();
    expect(notice.activityId).toBe(nextActivityId);
    expect(notice.body).toContain('session #2');
  });

  it('lists all sessions in the recurring series via /activities/:id/series', async () => {
    const seriesRes = await u.rec_member('GET', `/activities/${nextActivityId}/series`);
    expect(seriesRes.statusCode).toBe(200);
    const s = seriesRes.json();

    expect(s.seriesId).toBe(initialActivityId);
    expect(s.recurrence).toBe('weekly');
    expect(s.totalSessions).toBe(2);
    expect(s.sessions).toHaveLength(2);
    expect(s.sessions[0].occurrenceNumber).toBe(1);
    expect(s.sessions[1].occurrenceNumber).toBe(2);
  });

  it('processes due recurring activities via admin endpoint', async () => {
    // Create an active recurring activity whose starts_at is in the past
    const pastDate = new Date(Date.now() - 3600_000);
    const hostId = await idOf('rec_host');
    const [act] = await sql`
      insert into activities (
        host_id, title, emoji, category, description, place_name, location, city, starts_at,
        max_people, women_only, recurrence, occurrence_number, auto_advance
      )
      values (
        ${hostId}, 'Past Coworking Tuesdays', '💻', 'work', 'Coffee & code', 'Betahaus Barcelona',
        ST_SetSRID(ST_MakePoint(2.15, 41.40), 4326)::geography, 'Barcelona', ${pastDate},
        10, false, 'weekly', 1, true
      )
      returning id
    `;
    await sql`update activities set series_id = ${act.id} where id = ${act.id}`;
    await sql`insert into chats (kind, activity_id, title) values ('activity', ${act.id}, 'Past Coworking Tuesdays')`;

    const adminRes = await u.rec_host('POST', '/admin/activities/process-recurring');
    expect(adminRes.statusCode).toBe(200);
    const res = adminRes.json();
    expect(res.ok).toBe(true);

    const generated = res.items.find((item: any) => item.id === act.id);
    expect(generated).toBeDefined();
    expect(generated.nextActivityId).toBeDefined();
    expect(generated.occurrenceNumber).toBe(2);
  });

  it('updates series recurrence and autoAdvance via PATCH /activities/:id/recurrence', async () => {
    // Non-host rec_member cannot modify recurrence settings (403)
    const failRes = await u.rec_member('PATCH', `/activities/${initialActivityId}/recurrence`, {
      autoAdvance: false,
    });
    expect(failRes.statusCode).toBe(403);

    // Host pauses auto_advance
    const pauseRes = await u.rec_host('PATCH', `/activities/${initialActivityId}/recurrence`, {
      autoAdvance: false,
    });
    expect(pauseRes.statusCode).toBe(200);
    expect(pauseRes.json().activity.autoAdvance).toBe(false);

    // Host changes recurrence frequency to biweekly
    const updateRes = await u.rec_host('PATCH', `/activities/${initialActivityId}/recurrence`, {
      recurrence: 'biweekly',
    });
    expect(updateRes.statusCode).toBe(200);
    expect(updateRes.json().activity.recurrence).toBe('biweekly');

    // Series overview returns updated autoAdvance and host flag
    const seriesRes = await u.rec_host('GET', `/activities/${initialActivityId}/series`);
    expect(seriesRes.statusCode).toBe(200);
    expect(seriesRes.json().isHost).toBe(true);
    expect(seriesRes.json().autoAdvance).toBe(false);
  });

  it('filters recurring plans via GET /activities?recurring_only=true', async () => {
    // Create a one-off activity
    const oneOffStarts = new Date(Date.now() + 48 * 3600_000).toISOString();
    const oneOff = await u.rec_host('POST', '/activities', {
      title: 'One-off Brunch at Boqueria',
      emoji: '🥐',
      category: 'food',
      placeName: 'La Boqueria',
      lat: 41.3817,
      lng: 2.1716,
      startsAt: oneOffStarts,
      womenOnly: false,
    });
    expect(oneOff.statusCode).toBe(200);

    // Filter with recurring_only=true -> only recurring plans returned
    const recurringRes = await u.rec_host('GET', '/activities?lat=41.3817&lng=2.1716&recurring_only=true');
    expect(recurringRes.statusCode).toBe(200);
    const recurringList = recurringRes.json().activities;
    expect(recurringList.length).toBeGreaterThan(0);
    expect(recurringList.every((act: any) => act.recurrence !== null)).toBe(true);
    expect(recurringList.some((act: any) => act.id === oneOff.json().id)).toBe(false);

    // Query without recurring_only=true -> includes one-off plan
    const allRes = await u.rec_host('GET', '/activities?lat=41.3817&lng=2.1716');
    expect(allRes.statusCode).toBe(200);
    expect(allRes.json().activities.some((act: any) => act.id === oneOff.json().id)).toBe(true);
  });
});
