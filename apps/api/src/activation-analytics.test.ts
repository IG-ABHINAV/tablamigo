import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['funnel_anna', 'funnel_ben', 'funnel_cara', 'funnel_admin'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@funnel.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'funnel_admin@funnel.tablamigo';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 3300;
async function login(name: string, shouldOnboard = true): Promise<Api> {
  const email = `${name}@funnel.tablamigo`;
  const remoteAddress = `10.99.33.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  if (shouldOnboard) {
    await call('PATCH', '/me', {
      name,
      birthdate: '1996-06-20',
      gender: 'woman',
      homeCountry: 'IN',
      interests: ['food', 'hiking']
    });
  }
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@funnel.tablamigo'}`)[0]?.id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@funnel.tablamigo'`;
  for (const p of PEOPLE) {
    // Anna and Admin onboard; Ben onboards later in test to test onboarding_complete event; Cara stays non-onboarded
    const onboard = p === 'funnel_anna' || p === 'funnel_admin';
    u[p] = await login(p, onboard);
  }

  // Set location for Anna in Lisbon
  const annaId = await idOf('funnel_anna');
  await sql`update users set location = ST_SetSRID(ST_MakePoint(-9.14, 38.72), 4326)::geography, location_at = now() where id = ${annaId}`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@funnel.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Product Activation Funnel Analytics & Cohort Retention (Feature 33)', () => {
  it('telemetry ingestion: accepts single event via POST /analytics/event and batch via POST /analytics/events', async () => {
    // Single event via singular route /analytics/event
    const single = await u['funnel_anna']('POST', '/analytics/event', {
      event: 'screen_view',
      properties: { screen: 'discovery_map' }
    });
    expect(single.statusCode).toBe(200);
    expect(single.json().ok).toBe(true);
    expect(single.json().recorded).toBe(1);

    // Batch events via /analytics/events
    const batch = await u['funnel_anna']('POST', '/analytics/events', {
      events: [
        { event: 'filter_applied', properties: { category: 'food' } },
        { event: 'plan_shared', properties: { channel: 'copy_link' } }
      ]
    });
    expect(batch.statusCode).toBe(200);
    expect(batch.json().recorded).toBe(2);

    // Verify stored events in db
    const annaId = await idOf('funnel_anna');
    const [row] = await sql`select count(*)::int as c from analytics_events where user_id = ${annaId} and event_name in ('screen_view', 'filter_applied', 'plan_shared')`;
    expect(row.c).toBe(3);
  });

  it('lifecycle events: auto-records signup, onboarding_complete, plan_created, plan_joined, trip_created', async () => {
    const benId = await idOf('funnel_ben');

    // Ben had a signup event logged upon account creation
    const [signupEvt] = await sql`select count(*)::int as c from analytics_events where user_id = ${benId} and event_name = 'signup'`;
    expect(signupEvt.c).toBeGreaterThanOrEqual(1);

    // Ben now completes onboarding
    const patchRes = await u['funnel_ben']('PATCH', '/me', {
      name: 'Ben',
      birthdate: '1994-08-12',
      gender: 'man',
      homeCountry: 'FR',
      interests: ['culture']
    });
    expect(patchRes.statusCode).toBe(200);
    expect(patchRes.json().onboarded).toBe(true);

    // Verify onboarding_complete event logged
    const [onboardEvt] = await sql`select count(*)::int as c from analytics_events where user_id = ${benId} and event_name = 'onboarding_complete'`;
    expect(onboardEvt.c).toBe(1);

    // Anna creates a trip
    const tripRes = await u['funnel_anna']('POST', '/trips', {
      city: 'Lisbon',
      countryCode: 'PT',
      startDate: '2026-11-01',
      endDate: '2026-11-08'
    });
    expect(tripRes.statusCode).toBe(200);

    const annaId = await idOf('funnel_anna');
    const [tripEvt] = await sql`select count(*)::int as c from analytics_events where user_id = ${annaId} and event_name = 'trip_created'`;
    expect(tripEvt.c).toBe(1);

    // Anna hosts an activity (starts 5 minutes ago so checkin window is valid)
    const planStarts = new Date(Date.now() - 5 * 60_000).toISOString();
    const createRes = await u['funnel_anna']('POST', '/activities', {
      title: 'Tapas & Port Wine Tasting',
      emoji: '🍷',
      category: 'food',
      placeName: 'Time Out Market',
      lat: 38.7071,
      lng: -9.1458,
      startsAt: planStarts,
      womenOnly: false
    });
    expect(createRes.statusCode).toBe(200);
    const planId = createRes.json().id;

    // Verify plan_created event logged for Anna
    const [planCreatedEvt] = await sql`select count(*)::int as c from analytics_events where user_id = ${annaId} and event_name = 'plan_created'`;
    expect(planCreatedEvt.c).toBe(1);

    // Ben joins Anna's activity
    const joinRes = await u['funnel_ben']('POST', `/activities/${planId}/join`, { rsvp: 'going' });
    expect(joinRes.statusCode).toBe(200);

    // Verify plan_joined event logged for Ben
    const [planJoinedEvt] = await sql`select count(*)::int as c from analytics_events where user_id = ${benId} and event_name = 'plan_joined'`;
    expect(planJoinedEvt.c).toBe(1);

    // Ben says hi in the plan chat: his first action. Joining alone is the funnel's next stage, not a first action, so without
    // this the first_action count below only reached 2 when other files' people were still in the database (red on a fresh CI one).
    const hi = await u['funnel_ben']('POST', `/chats/${joinRes.json().chatId}/messages`, { body: 'Hi Anna, see you there!' });
    expect(hi.statusCode).toBe(200);

    // Ben checks in at the activity (within 300m of 38.7071, -9.1458)
    const checkinRes = await u['funnel_ben']('POST', `/activities/${planId}/checkin`, {
      lat: 38.7071,
      lng: -9.1458
    });
    expect(checkinRes.statusCode).toBe(200);
    expect(checkinRes.json().checkedIn).toBe(true);

    // Verify plan_checked_in event logged for Ben
    const [checkinEvt] = await sql`select count(*)::int as c from analytics_events where user_id = ${benId} and event_name = 'plan_checked_in'`;
    expect(checkinEvt.c).toBe(1);
  });

  it('GET /admin/analytics/funnel: enforces admin authorization and returns activation stages, drop-offs and cohorts', async () => {
    // Non-admin Anna rejected
    const nonAdmin = await u['funnel_anna']('GET', '/admin/analytics/funnel');
    expect(nonAdmin.statusCode).toBe(403);

    // Admin access succeeds
    const res = await u['funnel_admin']('GET', '/admin/analytics/funnel?days=30');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.timeWindowDays).toBe(30);

    // Check summary KPIs
    expect(body.summary).toBeDefined();
    expect(body.summary.totalSignups).toBeGreaterThanOrEqual(4);
    expect(typeof body.summary.activationRate).toBe('number');
    expect(typeof body.summary.onboardingRate).toBe('number');
    expect(typeof body.summary.avgHoursToJoin).toBe('number');
    expect(typeof body.summary.avgHoursToMeet).toBe('number');

    // Check funnel stages: 5 distinct milestones
    expect(Array.isArray(body.stages)).toBe(true);
    expect(body.stages.length).toBe(5);

    const [s1, s2, s3, s4, s5] = body.stages;
    expect(s1.stage).toBe('signups');
    expect(s1.count).toBeGreaterThanOrEqual(4);
    expect(s1.conversionFromSignup).toBe(100);

    expect(s2.stage).toBe('onboarding_complete');
    expect(s2.count).toBeGreaterThanOrEqual(2); // Anna, Admin, Ben
    expect(s2.conversionFromSignup).toBeGreaterThan(0);
    expect(typeof s2.dropoffRate).toBe('number');

    expect(s3.stage).toBe('first_action');
    expect(s3.count).toBeGreaterThanOrEqual(2); // Anna created a plan and a trip, Ben wrote in the plan chat

    expect(s4.stage).toBe('plan_joined');
    expect(s4.count).toBeGreaterThanOrEqual(2); // Anna (host is member) and Ben

    expect(s5.stage).toBe('first_meetup');
    expect(s5.count).toBeGreaterThanOrEqual(1); // Ben checked in

    // Check weekly cohort breakdown
    expect(Array.isArray(body.cohorts)).toBe(true);
    expect(body.cohorts.length).toBeGreaterThanOrEqual(1);
    // This week's cohort, which holds this file's sign-ups. Not simply the newest one: test files that run at the same time
    // create people on fixed future dates (host-welcome.test.ts signs people up in 2034), and those form newer cohorts.
    const [{ week }] = await sql`select to_char(date_trunc('week', now()), 'YYYY-MM-DD') as week`;
    const latestCohort = body.cohorts.find((c: any) => c.cohortWeek === week);
    expect(latestCohort).toBeDefined();
    expect(latestCohort.cohortWeek).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(latestCohort.signups).toBeGreaterThanOrEqual(4);
    expect(latestCohort.onboarded).toBeGreaterThanOrEqual(2);
    expect(latestCohort.joinedPlan).toBeGreaterThanOrEqual(2);
    expect(latestCohort.metUp).toBeGreaterThanOrEqual(1);
    expect(typeof latestCohort.onboardingPct).toBe('number');
    expect(typeof latestCohort.metUpPct).toBe('number');
  });

  it('GET /admin/analytics/funnel supports all-time (days=0) and custom intervals', async () => {
    const resAll = await u['funnel_admin']('GET', '/admin/analytics/funnel?days=0');
    expect(resAll.statusCode).toBe(200);
    expect(resAll.json().timeWindowDays).toBe(0);
    expect(resAll.json().stages[0].count).toBeGreaterThanOrEqual(4);
  });
});
