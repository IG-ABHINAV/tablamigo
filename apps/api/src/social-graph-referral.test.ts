import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['sg_alice', 'sg_bob', 'sg_charlie'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@social.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1100;
async function login(name: string): Promise<Api> {
  const email = `${name}@social.tablamigo`;
  const remoteAddress = `10.97.0.${++ip}`;
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
    birthdate: '1996-06-06',
    gender: 'woman',
    homeCountry: 'IT',
    travelStyle: ['spontaneous', 'foodie'],
    interests: ['food', 'hiking']
  });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@social.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@social.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});

afterAll(async () => {
  await sql`delete from users where email like '%@social.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Social Graph (Connections/Friends) & Referral System', () => {
  it('connects with another user, becomes mutual when they connect back, lists upcoming trips', async () => {
    const aliceId = await idOf('sg_alice');
    const bobId = await idOf('sg_bob');

    // Bob creates an upcoming trip to Rome
    const start = new Date(Date.now() + 86400_000 * 5).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 86400_000 * 12).toISOString().slice(0, 10);
    const tripRes = await u.sg_bob('POST', '/trips', {
      city: 'Rome',
      countryCode: 'IT',
      startDate: start,
      endDate: end
    });
    expect(tripRes.statusCode).toBe(200);

    // Alice asks to connect with Bob: pending until Bob accepts (migration 077), so nothing is unlocked yet.
    const conn1 = await u.sg_alice('POST', `/users/${bobId}/connect`);
    expect(conn1.statusCode).toBe(200);
    expect(conn1.json()).toMatchObject({ status: 'requested', connected: false });
    expect((await u.sg_alice('GET', `/users/${bobId}`)).json()).toMatchObject({ isConnected: false, connectionStatus: 'requested' });
    expect((await u.sg_alice('GET', '/connections')).json().connections.find((c: any) => c.id === bobId)).toBeUndefined();

    // Bob connecting back accepts Alice's request: both connected, both ways.
    const conn2 = await u.sg_bob('POST', `/users/${aliceId}/connect`);
    expect(conn2.statusCode).toBe(200);
    expect(conn2.json()).toMatchObject({ status: 'connected', connected: true });
    const bobProfile = await u.sg_alice('GET', `/users/${bobId}`);
    expect(bobProfile.json()).toMatchObject({ isConnected: true, isMutual: true, connectionStatus: 'connected' });

    // Alice checks connections list: sees Bob and his upcoming trip to Rome!
    const connList = await u.sg_alice('GET', '/connections');
    expect(connList.statusCode).toBe(200);
    const bobInList = connList.json().connections.find((c: any) => c.id === bobId);
    expect(bobInList).toBeDefined();
    expect(bobInList.upcomingTrips).toHaveLength(1);
    expect(bobInList.upcomingTrips[0].city).toBe('Rome');

    // Disconnect removes it for both.
    const disconn = await u.sg_alice('DELETE', `/users/${bobId}/connect`);
    expect(disconn.statusCode).toBe(200);
    expect(disconn.json().connected).toBe(false);
    expect((await u.sg_bob('GET', `/users/${aliceId}`)).json().isConnected).toBe(false);
  });

  it('generates referral code and grants 7 days of Plus to both referrer and referee on redemption', async () => {
    // Charlie fetches referral code
    const refRes = await u.sg_charlie('GET', '/me/referral');
    expect(refRes.statusCode).toBe(200);
    const code = refRes.json().referralCode;
    expect(code).toBeDefined();
    expect(refRes.json().referralLink).toContain(code);

    // Charlie cannot redeem own code
    const selfRes = await u.sg_charlie('POST', '/me/referral/redeem', { code });
    expect(selfRes.statusCode).toBe(400);
    expect(selfRes.json().error).toBe('cannot_refer_self');

    // Alice redeems Charlie's code
    const redeemRes = await u.sg_alice('POST', '/me/referral/redeem', { code });
    expect(redeemRes.statusCode).toBe(200);
    expect(redeemRes.json().ok).toBe(true);
    expect(redeemRes.json().rewardDays).toBe(7);

    // Verify both Alice and Charlie now have plus_until >= now() + 6 days
    const aliceId = await idOf('sg_alice');
    const charlieId = await idOf('sg_charlie');

    const [aliceRow] = await sql`select plus_until from users where id = ${aliceId}`;
    const [charlieRow] = await sql`select plus_until from users where id = ${charlieId}`;

    expect(new Date(aliceRow.plusUntil).getTime()).toBeGreaterThan(Date.now() + 86400_000 * 6);
    expect(new Date(charlieRow.plusUntil).getTime()).toBeGreaterThan(Date.now() + 86400_000 * 6);

    // Alice cannot redeem another code
    const doubleRes = await u.sg_alice('POST', '/me/referral/redeem', { code });
    expect(doubleRes.statusCode).toBe(400);
    expect(doubleRes.json().error).toBe('already_referred');
  });

  it('matches travel buddies based on overlapping trips and travel styles', async () => {
    // Alice and Charlie both have trips to Barcelona on overlapping dates
    const start = new Date(Date.now() + 86400_000 * 10).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 86400_000 * 20).toISOString().slice(0, 10);

    await u.sg_alice('POST', '/trips', {
      city: 'Barcelona',
      countryCode: 'ES',
      startDate: start,
      endDate: end
    });

    await u.sg_charlie('POST', '/trips', {
      city: 'Barcelona',
      countryCode: 'ES',
      startDate: start,
      endDate: end
    });

    // Alice searches for buddies
    const buddyRes = await u.sg_alice('GET', '/travelers/buddies');
    expect(buddyRes.statusCode).toBe(200);
    const charlieId = await idOf('sg_charlie');
    const buddy = buddyRes.json().buddies.find((b: any) => b.id === charlieId);
    expect(buddy).toBeDefined();
    expect(buddy.city).toBe('Barcelona');
    expect(buddy.matchingStyles).toContain('spontaneous');
    expect(buddy.matchingStyles).toContain('foodie');
    expect(buddy.score).toBeGreaterThan(10);
  });
});
