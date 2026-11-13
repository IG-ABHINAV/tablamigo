import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['tb_alice', 'tb_bob', 'tb_charlie', 'tb_dana', 'tb_eli'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@buddy.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1200;
async function login(name: string, styles: string[], interests: string[]): Promise<Api> {
  const email = `${name}@buddy.tablamigo`;
  const remoteAddress = `10.97.1.${++ip}`;
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
    birthdate: '1997-04-12',
    gender: 'nonbinary',
    homeCountry: 'JP',
    languages: ['Japanese', 'English'],
    travelStyle: styles,
    interests: interests
  });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@buddy.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@buddy.tablamigo'`;
  u['tb_alice'] = await login('tb_alice', ['foodie', 'hiker'], ['food', 'coffee']);
  u['tb_bob'] = await login('tb_bob', ['foodie', 'hiker'], ['food', 'markets']);
  u['tb_charlie'] = await login('tb_charlie', ['luxury', 'night owl'], ['nightlife']);
  u['tb_dana'] = await login('tb_dana', ['luxury'], ['nightlife']);
  u['tb_eli'] = await login('tb_eli', ['luxury'], ['nightlife']);
});

afterAll(async () => {
  await sql`delete from users where email like '%@buddy.tablamigo'`;
  await app.close();
  await sql.end();
});

// Fukuoka in November 2026 is this file's alone. Test files run in parallel against one database, and when three of
// them shared Tokyo the free 3-person preview hid whoever this file expected (Tokyo is trip-group-chats.test.ts's).
describe('Feature 23: Travel Buddy Matching & Suggested Companions', () => {
  let aliceTripId: string;

  it('computes suggested companions compatibility and handles buddy connection workflow', async () => {
    const bobId = await idOf('tb_bob');
    const charlieId = await idOf('tb_charlie');

    // Alice creates trip to Fukuoka
    const aliceTripRes = await u.tb_alice('POST', '/trips', {
      city: 'Fukuoka',
      countryCode: 'JP',
      startDate: '2026-11-10',
      endDate: '2026-11-18'
    });
    expect(aliceTripRes.statusCode).toBe(200);
    aliceTripId = aliceTripRes.json().id;

    // Bob creates overlapping trip to Fukuoka
    const bobTripRes = await u.tb_bob('POST', '/trips', {
      city: 'Fukuoka',
      countryCode: 'JP',
      startDate: '2026-11-12',
      endDate: '2026-11-16'
    });
    expect(bobTripRes.statusCode).toBe(200);

    // Charlie creates overlapping trip to Fukuoka
    const charlieTripRes = await u.tb_charlie('POST', '/trips', {
      city: 'Fukuoka',
      countryCode: 'JP',
      startDate: '2026-11-14',
      endDate: '2026-11-15'
    });
    expect(charlieTripRes.statusCode).toBe(200);

    // Alice fetches suggested buddies for her trip
    const buddiesRes = await u.tb_alice('GET', `/trips/${aliceTripId}/buddies`);
    expect(buddiesRes.statusCode).toBe(200);
    const { companions } = buddiesRes.json();
    expect(companions.length).toBe(2);
    // Alice is a free account, and 2 people are within the free preview of 3: nothing locked.
    expect(buddiesRes.json()).toMatchObject({ total: 2, locked: false, hiddenCount: 0 });

    // Bob should be ranked first due to matching styles (foodie, hiker) & shared interest (food)
    const bobMatch = companions.find((c: any) => c.id === bobId);
    const charlieMatch = companions.find((c: any) => c.id === charlieId);
    expect(bobMatch).toBeDefined();
    expect(charlieMatch).toBeDefined();
    expect(bobMatch.matchScore).toBeGreaterThan(charlieMatch.matchScore);
    expect(bobMatch.matchingStyles).toEqual(expect.arrayContaining(['foodie', 'hiker']));
    expect(bobMatch.matchingInterests).toContain('food');
    expect(bobMatch.overlapDays).toBe(5);
    expect(bobMatch.requestStatus).toBe('none');

    // Alice sends travel buddy invite to Bob
    const sendReqRes = await u.tb_alice('POST', `/trips/${aliceTripId}/buddy-requests`, {
      recipientId: bobId,
      introNote: 'Hey Bob, saw we both love ramen and hiking! Let us explore Fukuoka together.'
    });
    expect(sendReqRes.statusCode).toBe(200);
    expect(sendReqRes.json().ok).toBe(true);

    // Alice checks trip buddies again: Bob should now show status 'sent'
    const buddiesAfterSend = await u.tb_alice('GET', `/trips/${aliceTripId}/buddies`);
    const bobAfterSend = buddiesAfterSend.json().companions.find((c: any) => c.id === bobId);
    expect(bobAfterSend.requestStatus).toBe('sent');

    // Bob checks incoming requests
    const bobRequestsRes = await u.tb_bob('GET', '/travel-buddies/requests');
    expect(bobRequestsRes.statusCode).toBe(200);
    const { received } = bobRequestsRes.json();
    const aliceReq = received.find((r: any) => r.senderName === 'tb_alice');
    expect(aliceReq).toBeDefined();
    expect(aliceReq.introNote).toContain('ramen and hiking');
    expect(aliceReq.city).toBe('Fukuoka');

    // Bob accepts Alice's request
    const respondRes = await u.tb_bob('POST', `/travel-buddies/requests/${aliceReq.id}/respond`, {
      action: 'accept'
    });
    expect(respondRes.statusCode).toBe(200);
    expect(respondRes.json().status).toBe('accepted');
    expect(respondRes.json().chatId).toBeDefined();

    // Verify mutual connection exists
    const [conn] = await sql`select 1 from connections where user_id = ${bobId} and friend_id = (select id from users where email = 'tb_alice@buddy.tablamigo')`;
    expect(conn).toBeDefined();

    // Alice checks trip buddies again: Bob is now 'connected'
    const buddiesFinal = await u.tb_alice('GET', `/trips/${aliceTripId}/buddies`);
    const bobFinal = buddiesFinal.json().companions.find((c: any) => c.id === bobId);
    expect(bobFinal.requestStatus).toBe('connected');
  });

  it('a free account sees the 3 best-matched companions and how many are hidden; Plus sees everyone', async () => {
    const bobId = await idOf('tb_bob');
    const charlieId = await idOf('tb_charlie');
    // Two more people overlap Alice's trip, so 4 overlap her: one more than the free preview shows.
    for (const p of ['tb_dana', 'tb_eli']) {
      expect((await u[p]('POST', '/trips', { city: 'Fukuoka', countryCode: 'JP', startDate: '2026-11-11', endDate: '2026-11-13' })).statusCode).toBe(200);
    }
    const free = (await u.tb_alice('GET', `/trips/${aliceTripId}/buddies`)).json();
    expect(free.companions).toHaveLength(3);
    expect(free).toMatchObject({ total: 4, locked: true, hiddenCount: 1 });
    // Best match first: Bob is shown, Charlie (2 days, nothing in common) is the one held back.
    expect(free.companions[0].id).toBe(bobId);
    expect(free.companions.map((c: any) => c.id)).not.toContain(charlieId);

    await sql`update users set plus_until = now() + interval '1 day' where email = 'tb_alice@buddy.tablamigo'`;
    try {
      const plus = (await u.tb_alice('GET', `/trips/${aliceTripId}/buddies`)).json();
      expect(plus.companions).toHaveLength(4);
      expect(plus).toMatchObject({ total: 4, locked: false, hiddenCount: 0 });
      expect(plus.companions.map((c: any) => c.id)).toContain(charlieId);
    } finally {
      await sql`update users set plus_until = null where email = 'tb_alice@buddy.tablamigo'`;
    }
  });
});
