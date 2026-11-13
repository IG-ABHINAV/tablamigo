import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['feed_alice', 'feed_bob'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@feed.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1300;
const tokens: Record<string, string> = {};
// A chat photo uploaded by `name` through the API, as the app does before posting a moment.
async function upload(name: string) {
  const r = await app.inject({ method: 'POST', url: '/uploads/image/direct?kind=chat', payload: Buffer.from('fake-jpeg'),
    headers: { 'content-type': 'image/jpeg', authorization: tokens[name] } });
  expect(r.statusCode).toBe(200);
  return r.json().publicUrl as string;
}
async function login(name: string): Promise<Api> {
  const email = `${name}@feed.tablamigo`;
  const remoteAddress = `10.99.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  tokens[name] = `Bearer ${tok}`;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', {
    name,
    birthdate: '1997-07-07',
    gender: 'woman',
    homeCountry: 'FR',
    city: 'Bangkok'
  });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@feed.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@feed.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});

afterAll(async () => {
  await sql`delete from users where email like '%@feed.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Travel Moments Feed (UGC, Viral Sharing, Likes, Comments)', () => {
  let momentId: string;

  it('exploit: a moment only takes a photo its poster uploaded here', async () => {
    const bobPhoto = await upload('feed_bob');
    for (const imageUrl of ['https://images.unsplash.com/photo-1507525428034-b723cf961d3e', 'https://evil.example/pixel.gif', bobPhoto]) {
      const r = await u['feed_alice']('POST', '/moments', { caption: 'Look at this', imageUrl, city: 'Bangkok' });
      expect(r.statusCode, imageUrl).toBe(400);
      expect(r.json().error).toBe('bad_photo');
    }
  });

  it('exploit: a moment can only be tagged with a plan the poster is part of (any plan id put its title in the public feed)', async () => {
    // Bob's women-only plan, made directly (creating one over HTTP looks the place up on Nominatim).
    const [plan] = await sql`insert into activities (host_id, title, emoji, category, place_name, location, city, starts_at, women_only)
      values (${await idOf('feed_bob')}, 'Bob women-only rooftop', '🍸', 'drinks', 'Rooftop', ST_SetSRID(ST_MakePoint(100.52, 13.75), 4326)::geography, 'Bangkok', now() + interval '5 hours', true) returning id`;
    const planId = plan.id as string;
    const post = async (activityId: string) => u['feed_alice']('POST', '/moments', { caption: 'Tagged', imageUrl: await upload('feed_alice'), city: 'Bangkok', activityId });

    for (const bogus of [planId, '11111111-1111-4111-8111-111111111111']) {   // someone else's plan, a plan that doesn't exist
      const r = await post(bogus);
      expect(r.statusCode, bogus).toBe(403);
      expect(r.json().error).toBe('not_in_plan');
    }
    expect((await sql`select count(*)::int as n from moments where caption = 'Tagged'`)[0].n).toBe(0);

    // As a member of the plan (waitlisted doesn't count), she can tag it.
    await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${planId}, ${await idOf('feed_alice')}, 'waitlist')`;
    expect((await post(planId)).statusCode).toBe(403);
    await sql`update activity_members set rsvp_status = 'going' where activity_id = ${planId} and user_id = ${await idOf('feed_alice')}`;
    const ok = await post(planId);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().activityId).toBe(planId);
    await sql`delete from moments where caption = 'Tagged'`;
  });

  it('exploit: moments store a coarse point and the nearby search never looks closer than 5 km', async () => {
    const aliceId = await idOf('feed_alice');
    const r = await u['feed_alice']('POST', '/moments', { caption: 'Exact spot test', imageUrl: await upload('feed_alice'), city: 'Bangkok', lat: 13.746612, lng: 100.534612 });
    expect(r.statusCode).toBe(200);
    const [row] = await sql`select ST_Y(location::geometry) as lat, ST_X(location::geometry) as lng from moments where id = ${r.json().id}`;
    expect(row.lat).toBeCloseTo(13.75, 6);
    expect(row.lng).toBeCloseTo(100.53, 6);
    // A 100 m search 3 km away still finds it: the radius is at least 5 km, so small searches can't triangulate.
    const near = (await u['feed_bob']('GET', '/moments?scope=nearby&lat=13.773&lng=100.53&radiusKm=0.1')).json().moments;
    expect(near.map((m: any) => m.id)).toContain(r.json().id);
    await sql`delete from moments where user_id = ${aliceId} and caption = 'Exact spot test'`;
  });

  it('creates a moment with caption, city, and image', async () => {
    const res = await u['feed_alice']('POST', '/moments', {
      caption: 'Sunset drinks at rooftop bar with fellow travelers!',
      imageUrl: await upload('feed_alice'),
      city: 'Bangkok',
      category: 'meetup'
    });

    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.id).toBeTruthy();
    expect(data.caption).toBe('Sunset drinks at rooftop bar with fellow travelers!');
    expect(data.city).toBe('Bangkok');
    expect(data.userName).toBe('feed_alice');
    momentId = data.id;
  });

  it('lists moments in feed and shows author and counts', async () => {
    const res = await u['feed_bob']('GET', '/moments?city=Bangkok');
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(Array.isArray(data.moments)).toBe(true);
    const m = data.moments.find((x: any) => x.id === momentId);
    expect(m).toBeTruthy();
    expect(m.likesCount).toBe(0);
    expect(m.likedByMe).toBe(false);
    expect(m.commentsCount).toBe(0);
  });

  it('likes and unlikes a moment, triggers inbox notification to author', async () => {
    const aliceId = await idOf('feed_alice');

    // Bob likes Alice's moment
    const likeRes = await u['feed_bob']('POST', `/moments/${momentId}/like`);
    expect(likeRes.statusCode).toBe(200);
    expect(likeRes.json().liked).toBe(true);
    expect(likeRes.json().likesCount).toBe(1);

    // Check Alice's inbox has moment_like notice
    const inbox = await sql`select kind, body from notifications where user_id = ${aliceId} and moment_id = ${momentId}`;
    expect(inbox.length).toBeGreaterThanOrEqual(1);
    expect(inbox[0].kind).toBe('moment_like');

    // Bob unlikes
    const unlikeRes = await u['feed_bob']('DELETE', `/moments/${momentId}/like`);
    expect(unlikeRes.statusCode).toBe(200);
    expect(unlikeRes.json().liked).toBe(false);
    expect(unlikeRes.json().likesCount).toBe(0);
  });

  it('comments on a moment, triggers inbox notification to author', async () => {
    const aliceId = await idOf('feed_alice');

    // Bob comments
    const commentRes = await u['feed_bob']('POST', `/moments/${momentId}/comments`, {
      body: 'Which rooftop bar was this? Looks amazing!'
    });
    expect(commentRes.statusCode).toBe(200);
    expect(commentRes.json().body).toBe('Which rooftop bar was this? Looks amazing!');
    expect(commentRes.json().userName).toBe('feed_bob');

    // Check comments list
    const listRes = await u['feed_alice']('GET', `/moments/${momentId}/comments`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().comments.length).toBe(1);

    // Check Alice's inbox has moment_comment notice
    const inbox = await sql`select kind, body from notifications where user_id = ${aliceId} and kind = 'moment_comment'`;
    expect(inbox.length).toBeGreaterThanOrEqual(1);
  });

  it('fetches single moment view with comments for public sharing', async () => {
    const res = await app.inject({ method: 'GET', url: `/moments/${momentId}` });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.moment.id).toBe(momentId);
    expect(data.moment.userName).toBe('feed_alice');
    expect(data.comments.length).toBe(1);
  });

  it('allows author to delete their moment', async () => {
    const delRes = await u['feed_alice']('DELETE', `/moments/${momentId}`);
    expect(delRes.statusCode).toBe(200);

    // Now GET /moments/:id returns 404
    const getRes = await u['feed_alice']('GET', `/moments/${momentId}`);
    expect(getRes.statusCode).toBe(404);
  });
});
