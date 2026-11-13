import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['pa_host', 'pa_user1', 'pa_user2', 'pa_user3'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@advanced.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 800;
async function login(name: string): Promise<Api> {
  const email = `${name}@advanced.tablamigo`;
  const remoteAddress = `10.98.0.${++ip}`;
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
  await call('PATCH', '/me', { name, birthdate: '1994-04-04', gender: 'woman', homeCountry: 'PT' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@advanced.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@advanced.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});

afterAll(async () => {
  await sql`delete from users where email like '%@advanced.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Plan RSVP States & Waitlist Auto-Promotion', () => {
  let activityId: string;

  it('creates a capped plan and fills spots with waitlist overflow', async () => {
    // Host creates a plan with max_people = 2 (Host + 1 guest)
    const createRes = await u.pa_host('POST', '/activities', {
      title: 'Miradouro Sunset Meetup',
      emoji: '🌅',
      category: 'drinks',
      placeName: 'Miradouro de Santa Catarina',
      lat: 38.7100,
      lng: -9.1475,
      startsAt: new Date(Date.now() + 3600_000).toISOString(),
      maxPeople: 2,
      recurrence: 'weekly'
    });
    expect(createRes.statusCode).toBe(200);
    activityId = createRes.json().id;

    // First guest joins -> confirmed 'going'
    const join1 = await u.pa_user1('POST', `/activities/${activityId}/join`);
    expect(join1.statusCode).toBe(200);
    expect(join1.json().waitlisted).toBe(false);

    // Plan is now full (host + user1 = 2). User2 tries to join normally -> refused as full
    const join2Refused = await u.pa_user2('POST', `/activities/${activityId}/join`, { rsvp: 'going' });
    expect(join2Refused.statusCode).toBe(400);
    expect(join2Refused.json().error).toBe('full');

    // User2 joins the waitlist
    const join2Waitlist = await u.pa_user2('POST', `/activities/${activityId}/join`, { rsvp: 'waitlist' });
    expect(join2Waitlist.statusCode).toBe(200);
    expect(join2Waitlist.json().waitlisted).toBe(true);

    // User3 also joins the waitlist
    const join3Waitlist = await u.pa_user3('POST', `/activities/${activityId}/join`, { rsvp: 'waitlist' });
    expect(join3Waitlist.statusCode).toBe(200);
    expect(join3Waitlist.json().waitlisted).toBe(true);

    // Check activity detail counts
    const detail = await u.pa_host('GET', `/activities/${activityId}`);
    expect(detail.json().going).toBe(2);
    expect(detail.json().waitlistCount).toBe(2);
  });

  it('promotes earliest waitlisted traveler when a confirmed attendee leaves', async () => {
    // User1 leaves the plan
    const leaveRes = await u.pa_user1('POST', `/activities/${activityId}/leave`);
    expect(leaveRes.statusCode).toBe(200);

    // User2 (who joined waitlist before user3) should be auto-promoted to 'going'
    const user2Id = await idOf('pa_user2');
    const user3Id = await idOf('pa_user3');

    const [u2Member] = await sql`select rsvp_status from activity_members where activity_id = ${activityId} and user_id = ${user2Id}`;
    const [u3Member] = await sql`select rsvp_status from activity_members where activity_id = ${activityId} and user_id = ${user3Id}`;

    expect(u2Member.rsvpStatus).toBe('going');
    expect(u3Member.rsvpStatus).toBe('waitlist');

    const detailAfter = await u.pa_host('GET', `/activities/${activityId}`);
    expect(detailAfter.json().going).toBe(2);
    expect(detailAfter.json().waitlistCount).toBe(1);
  });
});

describe('Check-in and Host Ratings', () => {
  let pastActId: string;

  it('allows attendees to check in when near meeting spot', async () => {
    const hostId = await idOf('pa_host');
    const user2Id = await idOf('pa_user2');

    // Create an ongoing meetup (started 10 minutes ago)
    const [act] = await sql`
      insert into activities (host_id, title, emoji, category, place_name, city, starts_at, max_people, location)
      values (${hostId}, 'Pastis & Boules', '🥖', 'food', 'Jardim do Principe Real', 'Lisbon',
        now() - interval '10 minutes', 5, ST_SetSRID(ST_MakePoint(-9.1485, 38.7160), 4326)::geography)
      returning id`;
    pastActId = act.id;

    const [c] = await sql`insert into chats (kind, activity_id, title) values ('activity', ${pastActId}, 'Boules') returning id`;
    await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${pastActId}, ${hostId}, 'going'), (${pastActId}, ${user2Id}, 'going')`;
    await sql`insert into chat_members (chat_id, user_id) values (${c.id}, ${hostId}), (${c.id}, ${user2Id})`;

    // Check in with coordinates 1 km away -> too far
    const farCheckin = await u.pa_user2('POST', `/activities/${pastActId}/checkin`, {
      lat: 38.7300, lng: -9.1485
    });
    expect(farCheckin.statusCode).toBe(400);
    expect(farCheckin.json().error).toBe('too_far');

    // Check in within 50m of meeting place
    const nearCheckin = await u.pa_user2('POST', `/activities/${pastActId}/checkin`, {
      lat: 38.7161, lng: -9.1485
    });
    expect(nearCheckin.statusCode).toBe(200);
    expect(nearCheckin.json().checkedIn).toBe(true);

    const detail = await u.pa_user2('GET', `/activities/${pastActId}`);
    expect(detail.json().myCheckedIn).toBe(true);
    expect(detail.json().checkedInCount).toBe(1);
  });

  it('allows attendees to rate the host after the plan starts', async () => {
    const hostId = await idOf('pa_host');

    // Attendee rates the host 5 stars
    const rateRes = await u.pa_user2('POST', `/activities/${pastActId}/rate`, {
      rating: 5,
      tags: ['friendly', 'welcoming', 'on-time'],
      feedback: 'Wonderful host, made everyone feel at home!'
    });
    expect(rateRes.statusCode).toBe(200);
    expect(rateRes.json().rated.rating).toBe(5);

    // Host can view private ratings
    const hostRatings = await u.pa_host('GET', `/activities/${pastActId}/ratings`);
    expect(hostRatings.statusCode).toBe(200);
    expect(hostRatings.json().ratings.length).toBe(1);
    expect(hostRatings.json().ratings[0].feedback).toBe('Wonderful host, made everyone feel at home!');

    // Host cannot rate their own meetup
    const selfRate = await u.pa_host('POST', `/activities/${pastActId}/rate`, { rating: 5 });
    expect(selfRate.statusCode).toBe(400);

    // Stranger cannot view host ratings
    const strangerRatings = await u.pa_user3('GET', `/activities/${pastActId}/ratings`);
    expect(strangerRatings.statusCode).toBe(403);
  });
});
