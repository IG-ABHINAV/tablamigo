import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['late_host', 'late_att', 'adv_plus', 'adv_free'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@late.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1700;
async function login(name: string): Promise<Api> {
  const email = `${name}@late.tablamigo`;
  const remoteAddress = `10.99.4.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress,
  });
  return call;
}

/** A new avatar upload of the caller's own: a profile photo has to be one (routes/me.ts newPhoto). */
const avatar = async (call: Api) => (await call('POST', '/uploads/image', { kind: 'avatar', contentType: 'image/jpeg' })).json().publicUrl as string;

describe('Feature Backlog 11 & 30: Plan Running Late Status & Advanced Traveler Filters', () => {
  let hostCall: Api;
  let attCall: Api;
  let plusCall: Api;
  let freeCall: Api;
  let hostId: string;
  let attendeeId: string;
  let plusId: string;
  let freeId: string;

  beforeAll(async () => {
    app = await build();
    await sql`delete from users where email like '%@late.tablamigo'`;

    hostCall = await login('late_host');
    attCall = await login('late_att');
    plusCall = await login('adv_plus');
    freeCall = await login('adv_free');

    // Onboard host
    await hostCall('PATCH', '/me', {
      name: 'Late Host',
      birthdate: '1995-05-15',
      gender: 'man',
      homeCountry: 'IN',
      travelStyle: ['foodie', 'night owl'],
      interests: ['food', 'drinks'],
      photoUrl: await avatar(hostCall),
    });
    await hostCall('POST', '/me/location', { lat: 19.076, lng: 72.877 });
    const hostMe = await hostCall('GET', '/me');
    hostId = hostMe.json().id;

    // Onboard attendee
    await attCall('PATCH', '/me', {
      name: 'Late Attendee',
      birthdate: '1996-06-20',
      gender: 'woman',
      homeCountry: 'GB',
      travelStyle: ['foodie', 'hiker'],
      interests: ['food', 'hiking'],
      photoUrl: await avatar(attCall),
    });
    await attCall('POST', '/me/location', { lat: 19.076, lng: 72.877 });
    const attMe = await attCall('GET', '/me');
    attendeeId = attMe.json().id;

    // Onboard Plus user
    await plusCall('PATCH', '/me', {
      name: 'Plus Traveler',
      birthdate: '1994-04-10',
      gender: 'man',
      homeCountry: 'ES',
      travelStyle: ['foodie', 'night owl'],
      interests: ['food', 'nightlife'],
      languages: ['en', 'es'],
      photoUrl: await avatar(plusCall),
    });
    await plusCall('POST', '/me/location', { lat: 19.076, lng: 72.877 });
    const plusMe = await plusCall('GET', '/me');
    plusId = plusMe.json().id;
    await sql`update users set plus_until = now() + interval '30 days', verified = true where id = ${plusId}`;

    // Onboard Free user
    await freeCall('PATCH', '/me', {
      name: 'Free Traveler',
      birthdate: '1998-08-12',
      gender: 'woman',
      homeCountry: 'FR',
      travelStyle: ['budget'],
      interests: ['museums', 'art'],
      languages: ['en', 'fr'],
      photoUrl: await avatar(freeCall),
    });
    await freeCall('POST', '/me/location', { lat: 19.076, lng: 72.877 });
    const freeMe = await freeCall('GET', '/me');
    freeId = freeMe.json().id;
    await sql`update users set verified = false where id = ${freeId}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('allows confirmed attendees to report running late and notify the group', async () => {
    // 1. Host creates a plan (starts in 6h so it does not interfere with 2h reminder cron test)
    const startsAt = new Date(Date.now() + 6 * 3600 * 1000).toISOString();
    const createRes = await hostCall('POST', '/activities', {
      title: 'Sunset Coffee Meetup',
      category: 'drinks',
      startsAt,
      lat: 19.076,
      lng: 72.877,
      placeName: 'Marine Drive Promenade',
    });
    expect(createRes.statusCode).toBe(200);
    const planId = createRes.json().id;

    // 2. Attendee joins plan as going
    const joinRes = await attCall('POST', `/activities/${planId}/join`, { rsvp: 'going' });
    expect(joinRes.statusCode).toBe(200);

    // 3. Attendee reports running late: refused hours before the start, fine once the plan is half an hour away.
    const early = await attCall('POST', `/activities/${planId}/running-late`, { mins: 15 });
    expect([early.statusCode, early.json().error]).toEqual([400, 'running_late_too_early']);
    await sql`update activities set starts_at = now() + interval '30 minutes' where id = ${planId}`;
    const lateRes = await attCall('POST', `/activities/${planId}/running-late`, {
      mins: 15,
      note: 'Stuck in traffic near Bandra',
    });
    expect(lateRes.statusCode).toBe(200);
    expect(lateRes.json()).toMatchObject({
      ok: true,
      runningLateMins: 15,
      runningLateNote: 'Stuck in traffic near Bandra',
    });

    // 4. Host views plan details -> verify running late status appears in attendee list
    const planDetail = await hostCall('GET', `/activities/${planId}`);
    expect(planDetail.statusCode).toBe(200);
    const attendees = planDetail.json().attendees;
    const attUser = attendees.find((a: any) => a.id === attendeeId);
    expect(attUser).toBeDefined();
    expect(attUser.runningLateMins).toBe(15);
    expect(attUser.runningLateNote).toBe('Stuck in traffic near Bandra');

    // 5. Check chat has system message
    const chatId = planDetail.json().chatId;
    const chatMsgs = await hostCall('GET', `/chats/${chatId}/messages`);
    expect(chatMsgs.statusCode).toBe(200);
    const hasLateMsg = chatMsgs.json().messages.some((m: any) =>
      m.kind === 'system' && m.body.includes('running about 15 minutes late') && m.body.includes('Bandra')
    );
    expect(hasLateMsg).toBe(true);

    // 6. Check host inbox has running_late notification
    const hostInbox = await hostCall('GET', '/inbox');
    expect(hostInbox.statusCode).toBe(200);
    const lateNotice = hostInbox.json().notifications.find((n: any) => n.kind === 'running_late');
    expect(lateNotice).toBeDefined();
    expect(lateNotice.body).toContain('15m late');

    // 7. Attendee clears running late status (arrived)
    const clearRes = await attCall('DELETE', `/activities/${planId}/running-late`);
    expect(clearRes.statusCode).toBe(200);

    // 8. Plan detail now reflects null for runningLateMins
    const updatedPlan = await attCall('GET', `/activities/${planId}`);
    expect(updatedPlan.json().myRunningLateMins).toBeNull();
  });

  it('rejects non-attendees or maybe-attendees from reporting running late', async () => {
    // Plan with freeUser not joined
    const startsAt = new Date(Date.now() + 7 * 3600 * 1000).toISOString();
    const createRes = await hostCall('POST', '/activities', {
      title: 'Walk in Colaba',
      category: 'explore',
      startsAt,
      lat: 18.922,
      lng: 72.834,
      placeName: 'Gateway of India',
    });
    const planId = createRes.json().id;

    // Free user not joined
    const nonMemberRes = await freeCall('POST', `/activities/${planId}/running-late`, { mins: 10 });
    expect(nonMemberRes.statusCode).toBe(403);

    // Join as 'maybe'
    await freeCall('POST', `/activities/${planId}/join`, { rsvp: 'maybe' });

    const maybeLateRes = await freeCall('POST', `/activities/${planId}/running-late`, { mins: 10 });
    expect(maybeLateRes.statusCode).toBe(400);
    expect(maybeLateRes.json().error).toBe('not_going');
  });

  it('enforces Plus paywall for advanced filters and filters travelers correctly', async () => {
    // 1. Free user attempting verified_only filter -> 403 plus_required
    const freeFilterRes = await freeCall('GET', '/travelers?lat=19.076&lng=72.877&verified_only=true');
    expect(freeFilterRes.statusCode).toBe(403);
    expect(freeFilterRes.json().error).toBe('plus_required');

    // 2. Free user attempting travel_style filter -> 403 plus_required
    const freeStyleRes = await freeCall('GET', '/travelers?lat=19.076&lng=72.877&travel_style=foodie');
    expect(freeStyleRes.statusCode).toBe(403);
    expect(freeStyleRes.json().error).toBe('plus_required');

    // 3. Plus user filtering by verified_only
    const plusVerifiedRes = await plusCall('GET', '/travelers?lat=19.076&lng=72.877&verified_only=true');
    expect(plusVerifiedRes.statusCode).toBe(200);
    const verifiedTravelers = plusVerifiedRes.json().travelers;
    expect(verifiedTravelers.every((t: any) => t.verified === true)).toBe(true);

    // 4. Plus user filtering by travel_style=foodie
    const plusStyleRes = await plusCall('GET', '/travelers?lat=19.076&lng=72.877&travel_style=foodie');
    expect(plusStyleRes.statusCode).toBe(200);
    const foodieTravelers = plusStyleRes.json().travelers;
    expect(foodieTravelers.every((t: any) => (t.travelStyle || []).includes('foodie'))).toBe(true);
  });
});
