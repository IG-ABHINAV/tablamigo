import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['trip_alice', 'trip_bob'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@tripchat.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1400;
async function login(name: string): Promise<Api> {
  const email = `${name}@tripchat.tablamigo`;
  const remoteAddress = `10.99.1.${++ip}`;
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
    birthdate: '1996-05-15',
    gender: 'woman',
    homeCountry: 'ES',
    city: 'Lisbon'
  });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@tripchat.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@tripchat.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});

afterAll(async () => {
  await sql`delete from users where email like '%@tripchat.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Trip Group Chats / Destination Overlap Circles', () => {
  let aliceTripId: string;
  let bobTripId: string;
  let tripChatId: string;

  it('creates trips for Alice and Bob in Tokyo for November 2026', async () => {
    const resA = await u['trip_alice']('POST', '/trips', {
      city: 'Tokyo',
      countryCode: 'JP',
      startDate: '2026-11-10',
      endDate: '2026-11-20'
    });
    expect(resA.statusCode).toBe(200);
    aliceTripId = resA.json().id;

    const resB = await u['trip_bob']('POST', '/trips', {
      city: 'Tokyo',
      countryCode: 'JP',
      startDate: '2026-11-15',
      endDate: '2026-11-25'
    });
    expect(resB.statusCode).toBe(200);
    bobTripId = resB.json().id;
  });

  it('Alice checks group chat preview before joining', async () => {
    const res = await u['trip_alice']('GET', `/trips/${aliceTripId}/group-chat`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isMember).toBe(false);
    expect(body.title).toContain('Tokyo');
    expect(body.title).toContain('2026');
  });

  it('Alice joins Tokyo November circle chat', async () => {
    const res = await u['trip_alice']('POST', `/trips/${aliceTripId}/group-chat`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chatId).toBeDefined();
    expect(body.memberCount).toBe(1);
    expect(body.title).toContain('Tokyo');
    tripChatId = body.chatId;
  });

  it('Bob joins the same Tokyo November circle chat', async () => {
    const res = await u['trip_bob']('POST', `/trips/${bobTripId}/group-chat`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.chatId).toBe(tripChatId);
    expect(body.memberCount).toBe(2);
  });

  it('Trip chat appears in GET /chats with airplane emoji', async () => {
    const res = await u['trip_alice']('GET', '/chats');
    expect(res.statusCode).toBe(200);
    const chats = res.json().chats;
    const tc = chats.find((c: any) => c.id === tripChatId);
    expect(tc).toBeDefined();
    expect(tc.kind).toBe('trip');
    expect(tc.emoji).toBe('✈️');
    expect(tc.memberCount).toBe(2);
  });

  it('Members can send and read messages in the trip circle', async () => {
    const sendRes = await u['trip_alice']('POST', `/chats/${tripChatId}/messages`, {
      body: 'Hey Tokyo crew! Anyone down for Shibuya ramen tonight?'
    });
    expect(sendRes.statusCode).toBe(200);

    const getRes = await u['trip_bob']('GET', `/chats/${tripChatId}/messages`);
    expect(getRes.statusCode).toBe(200);
    const msgs = getRes.json().messages;
    expect(msgs.length).toBeGreaterThanOrEqual(1);
    expect(msgs.some((m: any) => m.body.includes('Shibuya ramen'))).toBe(true);
    expect(msgs.some((m: any) => m.kind === 'system' && m.body.includes('joined'))).toBe(true);
  });

  it('GET /trips/:id/group-chat returns member preview avatars', async () => {
    const res = await u['trip_alice']('GET', `/trips/${aliceTripId}/group-chat`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.isMember).toBe(true);
    expect(body.memberCount).toBe(2);
    expect(Array.isArray(body.members)).toBe(true);
    expect(body.members.length).toBe(2);
    expect(body.members.some((m: any) => m.name === 'trip_alice')).toBe(true);
    expect(body.members.some((m: any) => m.name === 'trip_bob')).toBe(true);
  });

  it('Bob can leave the trip circle via DELETE /trips/:id/group-chat', async () => {
    const leaveRes = await u['trip_bob']('DELETE', `/trips/${bobTripId}/group-chat`);
    expect(leaveRes.statusCode).toBe(200);
    expect(leaveRes.json().ok).toBe(true);
    expect(leaveRes.json().left).toBe(true);

    // Verify Bob's view
    const bobCheck = await u['trip_bob']('GET', `/trips/${bobTripId}/group-chat`);
    expect(bobCheck.statusCode).toBe(200);
    expect(bobCheck.json().isMember).toBe(false);
    expect(bobCheck.json().memberCount).toBe(1);

    // Verify Alice's view
    const aliceCheck = await u['trip_alice']('GET', `/trips/${aliceTripId}/group-chat`);
    expect(aliceCheck.statusCode).toBe(200);
    expect(aliceCheck.json().memberCount).toBe(1);
    expect(aliceCheck.json().members.length).toBe(1);
    expect(aliceCheck.json().members[0].name).toBe('trip_alice');

    // Verify departure system message was posted
    const msgsRes = await u['trip_alice']('GET', `/chats/${tripChatId}/messages`);
    expect(msgsRes.statusCode).toBe(200);
    const msgs = msgsRes.json().messages;
    expect(msgs.some((m: any) => m.kind === 'system' && m.body.includes('left the circle'))).toBe(true);
  });
});

