import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

const PEOPLE = ['rsvp_host', 'rsvp_maybe_user', 'rsvp_going_user', 'rsvp_wait_user'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@rsvp.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { clock } = await import('./lib/clock.js');
const { getWeekendTimestamps } = await import('./routes/activities.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1600;
async function login(name: string): Promise<Api> {
  const email = `${name}@rsvp.tablamigo`;
  const remoteAddress = `10.99.3.${++ip}`;
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
  await call('PATCH', '/me', {
    name,
    birthdate: '1998-05-15',
    gender: 'woman',
    homeCountry: 'IN',
    travelStyle: ['spontaneous', 'culture'],
    interests: ['coffee']
  });
  return call;
}

let hostCall: Api;
let maybeUserCall: Api;
let goingUserCall: Api;
let waitUserCall: Api;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@rsvp.tablamigo'`;
  hostCall = await login('rsvp_host');
  maybeUserCall = await login('rsvp_maybe_user');
  goingUserCall = await login('rsvp_going_user');
  waitUserCall = await login('rsvp_wait_user');
});

afterAll(async () => {
  await sql`delete from users where email like '%@rsvp.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Feature Backlog 10 & 14: Plan RSVP States & Weekend/Category Filtering', () => {
  it('manages Going, Maybe, and Waitlist states with auto-promotion and notifications', async () => {
    // 1. Host creates a plan with max_people = 2 (Host + 1 attendee)
    const startsAt = new Date(Date.now() + 3600_000 * 4).toISOString();
    const createRes = await hostCall('POST', '/activities', {
      title: 'Coffee and Co-work Meet',
      description: 'Quiet coffee session with limited seats',
      category: 'work',
      startsAt,
      lat: 18.932,
      lng: 72.825,
      placeName: 'Colaba Social',
      maxPeople: 2
    });
    expect(createRes.statusCode).toBe(200);
    const planId = createRes.json().id;

    // 2. maybeUser RSVPs "maybe"
    const maybeRes = await maybeUserCall('POST', `/activities/${planId}/join`, { rsvp: 'maybe' });
    expect(maybeRes.statusCode).toBe(200);
    expect(maybeRes.json().rsvpStatus).toBe('maybe');
    expect(maybeRes.json().waitlisted).toBe(false);

    // Host checks inbox for rsvp_update notice
    const hostInbox = await hostCall('GET', '/inbox');
    expect(hostInbox.statusCode).toBe(200);
    const rsvpNotice = hostInbox.json().notifications.find((n: any) => n.kind === 'rsvp_update');
    expect(rsvpNotice).toBeDefined();
    expect(rsvpNotice.body).toContain('is interested (maybe)');

    // 3. goingUser RSVPs "going" (takes the second spot -> now full)
    const goingRes = await goingUserCall('POST', `/activities/${planId}/join`, { rsvp: 'going' });
    expect(goingRes.statusCode).toBe(200);
    expect(goingRes.json().rsvpStatus).toBe('going');
    expect(goingRes.json().waitlisted).toBe(false);

    // Verify activity details: going = 2, maybeCount = 1, waitlistCount = 0
    const detailRes1 = await hostCall('GET', `/activities/${planId}`);
    expect(detailRes1.statusCode).toBe(200);
    expect(detailRes1.json().going).toBe(2);
    expect(detailRes1.json().maybeCount).toBe(1);
    expect(detailRes1.json().waitlistCount).toBe(0);

    // 4. waitUser joins -> since full, gets placed on waitlist
    const waitRes = await waitUserCall('POST', `/activities/${planId}/join`, { rsvp: 'waitlist' });
    expect(waitRes.statusCode).toBe(200);
    expect(waitRes.json().waitlisted).toBe(true);
    expect(waitRes.json().rsvpStatus).toBe('waitlist');

    // 5. goingUser switches to "maybe" via POST /activities/:id/rsvp
    const switchRes = await goingUserCall('POST', `/activities/${planId}/rsvp`, { rsvp: 'maybe' });
    expect(switchRes.statusCode).toBe(200);
    expect(switchRes.json().rsvpStatus).toBe('maybe');

    // Check that waitUser was automatically promoted to going!
    const detailRes2 = await waitUserCall('GET', `/activities/${planId}`);
    expect(detailRes2.statusCode).toBe(200);
    expect(detailRes2.json().myRsvp).toBe('going');
    expect(detailRes2.json().going).toBe(2); // Host + waitUser
    expect(detailRes2.json().maybeCount).toBe(2); // maybeUser + goingUser
    expect(detailRes2.json().waitlistCount).toBe(0);

    // waitUser checks inbox for promotion notification
    const waitInbox = await waitUserCall('GET', '/inbox');
    expect(waitInbox.statusCode).toBe(200);
    const promoNotice = waitInbox.json().notifications.find((n: any) => n.kind === 'join' && n.body.includes('promoted'));
    expect(promoNotice).toBeDefined();
  });

  it('supports the category filter in GET /activities', async () => {
    // A plan a few hours from now sits inside the default window whatever day the test runs on.
    const outdoors = await hostCall('POST', '/activities', {
      title: 'Weekend Trekking Club',
      category: 'outdoors',
      startsAt: new Date(Date.now() + 3 * 3600_000).toISOString(),
      lat: 18.935,
      lng: 72.825,
      placeName: 'Sanjay Gandhi National Park'
    });
    expect(outdoors.statusCode).toBe(200);
    const planId = outdoors.json().id;

    const outdoorsRes = await hostCall('GET', '/activities?lat=18.93&lng=72.82&category=outdoors');
    expect(outdoorsRes.statusCode).toBe(200);
    expect(outdoorsRes.json().activities.some((a: any) => a.id === planId)).toBe(true);

    // category=nightlife must not contain the outdoors plan
    const nightlifeRes = await hostCall('GET', '/activities?lat=18.93&lng=72.82&category=nightlife');
    expect(nightlifeRes.statusCode).toBe(200);
    expect(nightlifeRes.json().activities.some((a: any) => a.id === planId)).toBe(false);
  });
});

// The weekend window is worked out in JavaScript from the server's clock. These tests pin that clock (lib/clock.ts), so
// they give the same answer on a Sunday afternoon, a Monday at a month end or in a different time zone. (The test used to
// create "this Saturday 14:00" from the real date, which failed on weekends after 14:15: that is in the past.)
describe('weekend filter, with the clock pinned', () => {
  // Local time, like the window itself.
  const at = (y: number, m: number, d: number, h = 0, mi = 0) => new Date(y, m - 1, d, h, mi, 0, 0);
  const end = (y: number, m: number, d: number) => new Date(y, m - 1, d, 23, 59, 59, 999);
  const pin = (d: Date) => vi.spyOn(clock, 'now').mockReturnValue(d);
  afterEach(() => vi.restoreAllMocks());

  const insertPlan = async (title: string, startsAt: Date) => (await sql`
    insert into activities (host_id, title, emoji, category, place_name, location, city, starts_at, status)
    select u.id, ${title}, '🥾', 'outdoors', 'Sanjay Gandhi National Park', ST_SetSRID(ST_MakePoint(72.825, 18.935), 4326)::geography, 'Mumbai', ${startsAt}, 'active'
    from users u where u.email = 'rsvp_host@rsvp.tablamigo' returning id`)[0].id as string;
  const weekendIds = async () => ((await hostCall('GET', '/activities?lat=18.93&lng=72.82&when=weekend')).json().activities as any[]).map(a => a.id);

  it('the window, for every kind of "now" (mid-week, Friday before and after 17:00, Saturday, Sunday)', () => {
    const cases: [string, Date, Date, Date][] = [
      ['Wednesday', at(2026, 10, 7, 10), at(2026, 10, 9, 17), end(2026, 10, 11)],
      ['Thursday night', at(2026, 10, 8, 23, 30), at(2026, 10, 9, 17), end(2026, 10, 11)],
      ['Friday morning', at(2026, 10, 9, 10), at(2026, 10, 9, 17), end(2026, 10, 11)],
      ['Friday evening (already started)', at(2026, 10, 9, 19, 30), at(2026, 10, 9, 19, 30), end(2026, 10, 11)],
      ['Saturday afternoon', at(2026, 10, 10, 15), at(2026, 10, 10, 0), end(2026, 10, 11)],
      ['Sunday afternoon', at(2026, 10, 11, 15), at(2026, 10, 11, 0), end(2026, 10, 11)],
      // The coming Friday is in the next month or year: the end used to be computed from today's day-of-month and landed in the past.
      ['Monday 28 Sep', at(2026, 9, 28, 10), at(2026, 10, 2, 17), end(2026, 10, 4)],
      ['Tuesday 29 Dec', at(2026, 12, 29, 10), at(2027, 1, 1, 17), end(2027, 1, 3)],
    ];
    for (const [label, now, start, until] of cases) {
      const w = getWeekendTimestamps(now);
      expect(w.start.getTime(), `${label} start`).toBe(start.getTime());
      expect(w.end.getTime(), `${label} end`).toBe(until.getTime());
    }
  });

  it('a Saturday plan is in the weekend list on a Wednesday; a weekday plan and next Monday are not', async () => {
    pin(at(2026, 10, 7, 10));
    const sat = await insertPlan('Pinned Saturday hike', at(2026, 10, 10, 14));
    const wed = await insertPlan('Pinned Wednesday hike', at(2026, 10, 7, 18));
    const mon = await insertPlan('Pinned next-Monday hike', at(2026, 10, 12, 10));
    const ids = await weekendIds();
    expect(ids).toContain(sat);
    expect(ids).not.toContain(wed);
    expect(ids).not.toContain(mon);
  });

  it('exploit: on a Monday at a month end the coming weekend is still listed (its end fell in the past)', async () => {
    pin(at(2026, 9, 28, 10));
    const sat = await insertPlan('Pinned 3 Oct hike', at(2026, 10, 3, 14));
    expect(await weekendIds()).toContain(sat);
  });
});
