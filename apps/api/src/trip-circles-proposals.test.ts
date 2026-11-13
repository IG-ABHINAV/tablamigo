import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['circle_liam', 'circle_maya', 'circle_stranger', 'circle_noor', 'circle_omar', 'circle_pia'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@circle.tablamigo`).join(',');
process.env.REVIEW_CODE = '888888';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown, headers?: Record<string, string>) => Promise<import('light-my-request').Response>;

let ip = 4200;
async function login(name: string): Promise<Api> {
  const email = `${name}@circle.tablamigo`;
  const remoteAddress = `10.99.14.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '888888' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload, headers) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}`, ...(headers ?? {}) },
    remoteAddress
  });
  await call('PATCH', '/me', {
    name,
    birthdate: '1995-05-15',
    gender: name.includes('maya') ? 'woman' : 'man',
    homeCountry: name.includes('maya') ? 'IN' : 'GB',
    travelStyle: ['foodie', 'culture']
  });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@circle.tablamigo'`;
  for (const p of PEOPLE) {
    u[p] = await login(p);
  }
});

afterAll(async () => {
  await sql`delete from users where email like '%@circle.tablamigo'`;
  await app.close();
});

// Sapporo in November 2026 is this file's alone. Test files run in parallel against one database, and when three of
// them shared the Tokyo circle the free 3-person directory preview hid Maya (Tokyo is trip-group-chats.test.ts's).
describe('Feature 18: Trip Circles Topics, Proposals & Member Directory', () => {
  let liamTripId: string;
  let mayaTripId: string;
  let strangerTripId: string;

  beforeAll(async () => {
    // Liam and Maya travel to Sapporo in Nov 2026
    const t1 = await u.circle_liam('POST', '/trips', {
      city: 'Sapporo',
      countryCode: 'JP',
      startDate: '2026-11-10',
      endDate: '2026-11-20',
      lat: 43.0618,
      lng: 141.3545
    });
    liamTripId = t1.json().id;

    const t2 = await u.circle_maya('POST', '/trips', {
      city: 'Sapporo',
      countryCode: 'JP',
      startDate: '2026-11-12',
      endDate: '2026-11-22',
      lat: 43.0618,
      lng: 141.3545
    });
    mayaTripId = t2.json().id;

    // Stranger travels to Paris
    const t3 = await u.circle_stranger('POST', '/trips', {
      city: 'Paris',
      countryCode: 'FR',
      startDate: '2026-11-10',
      endDate: '2026-11-20',
      lat: 48.8566,
      lng: 2.3522
    });
    strangerTripId = t3.json().id;
  });

  it('joins a trip circle, sets discussion topic, and reads updated metadata', async () => {
    // 1. Liam joins the circle
    const joinRes = await u.circle_liam('POST', `/trips/${liamTripId}/group-chat`);
    expect(joinRes.statusCode).toBe(200);
    expect(joinRes.json().chatId).toBeDefined();

    // 2. Liam sets the circle topic
    const topicRes = await u.circle_liam('PUT', `/trips/${liamTripId}/circle-topic`, {
      topic: 'Exploring ramen spots in Shinjuku & sunset at Shibuya Sky 🍜🌅'
    });
    expect(topicRes.statusCode).toBe(200);
    expect(topicRes.json().ok).toBe(true);
    expect(topicRes.json().topic).toContain('Shibuya Sky');

    // 3. GET /trips/:id/group-chat returns topic and author
    const chatMeta = await u.circle_liam('GET', `/trips/${liamTripId}/group-chat`);
    expect(chatMeta.statusCode).toBe(200);
    expect(chatMeta.json().topic).toBe('Exploring ramen spots in Shinjuku & sunset at Shibuya Sky 🍜🌅');
    expect(chatMeta.json().topicAuthor).toBe('circle_liam');
  });

  it('refuses topic update from non-member traveler', async () => {
    // Stranger tries to update Sapporo circle topic
    const res = await u.circle_stranger('PUT', `/trips/${strangerTripId}/circle-topic`, {
      topic: 'Unauthorized topic'
    });
    // Paris circle chat does not exist yet or stranger is not member
    expect([403, 404]).toContain(res.statusCode);
  });

  it('fetches circle member directory with overlapping travel dates', async () => {
    // Maya joins Sapporo circle
    await u.circle_maya('POST', `/trips/${mayaTripId}/group-chat`);

    const dirRes = await u.circle_liam('GET', `/trips/${liamTripId}/circle-directory`);
    expect(dirRes.statusCode).toBe(200);
    const dir = dirRes.json();
    expect(dir.totalMembers).toBe(2);
    // Liam is a free account, and the 2 members are within the free preview of 3: nothing locked.
    expect(dir).toMatchObject({ locked: false, hiddenCount: 0 });
    expect(dir.members).toHaveLength(2);
    expect(dir.topic).toContain('Shibuya Sky');

    const mayaMember = dir.members.find((m: any) => m.name === 'circle_maya');
    expect(mayaMember).toBeDefined();
    expect(mayaMember.homeCountry).toBe('IN');
    expect(mayaMember.startDate).toBe('2026-11-12');
  });

  it('pitches a meetup idea, lists proposals, and allows voting/unvoting', async () => {
    // Liam pitches a meetup idea
    const propRes = await u.circle_liam('POST', `/trips/${liamTripId}/circle-proposals`, {
      title: 'Golden Gai Bar Crawl',
      category: 'drinks',
      proposedDate: '2026-11-14'
    });
    expect(propRes.statusCode).toBe(200);
    expect(propRes.json().ok).toBe(true);
    const proposalId = propRes.json().proposal.id;
    expect(propRes.json().proposal.voteCount).toBe(1);

    // List proposals
    const listRes = await u.circle_maya('GET', `/trips/${mayaTripId}/circle-proposals`);
    expect(listRes.statusCode).toBe(200);
    const proposal = listRes.json().proposals.find((p: any) => p.id === proposalId);
    expect(proposal).toBeDefined();
    expect(proposal.title).toBe('Golden Gai Bar Crawl');
    expect(proposal.hasVoted).toBe(false);

    // Maya upvotes the proposal
    const voteRes = await u.circle_maya('POST', `/trips/${mayaTripId}/circle-proposals/${proposalId}/vote`);
    expect(voteRes.statusCode).toBe(200);
    expect(voteRes.json().hasVoted).toBe(true);
    expect(voteRes.json().voteCount).toBe(2);

    // Maya unvotes (toggles vote)
    const unvoteRes = await u.circle_maya('POST', `/trips/${mayaTripId}/circle-proposals/${proposalId}/vote`);
    expect(unvoteRes.statusCode).toBe(200);
    expect(unvoteRes.json().hasVoted).toBe(false);
    expect(unvoteRes.json().voteCount).toBe(1);
  });

  it('a free account sees 3 directory members and how many are hidden; Plus sees everyone', async () => {
    // Three more people join, so the circle has 5 members: Liam and the 4 others.
    for (const p of ['circle_noor', 'circle_omar', 'circle_pia']) {
      const t = (await u[p]('POST', '/trips', { city: 'Sapporo', countryCode: 'JP', startDate: '2026-11-11', endDate: '2026-11-15' })).json();
      expect((await u[p]('POST', `/trips/${t.id}/group-chat`)).statusCode).toBe(200);
    }
    const free = (await u.circle_liam('GET', `/trips/${liamTripId}/circle-directory`)).json();
    expect(free.totalMembers).toBe(5);
    expect(free).toMatchObject({ locked: true, hiddenCount: 2 });
    // The preview is the viewer first, then the earliest to join.
    expect(free.members.map((m: any) => m.name)).toEqual(['circle_liam', 'circle_maya', 'circle_noor']);

    await sql`update users set plus_until = now() + interval '1 day' where email = 'circle_liam@circle.tablamigo'`;
    try {
      const plus = (await u.circle_liam('GET', `/trips/${liamTripId}/circle-directory`)).json();
      expect(plus).toMatchObject({ totalMembers: 5, locked: false, hiddenCount: 0 });
      expect(plus.members.map((m: any) => m.name).sort()).toEqual(['circle_liam', 'circle_maya', 'circle_noor', 'circle_omar', 'circle_pia']);
    } finally {
      await sql`update users set plus_until = null where email = 'circle_liam@circle.tablamigo'`;
    }
  });
});
