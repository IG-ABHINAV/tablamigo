import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['ws_maya', 'ws_david', 'ws_free'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@ws.tablamigo`).join(',');
process.env.REVIEW_CODE = '888888';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1500;
async function login(name: string, gender: 'woman' | 'man'): Promise<Api> {
  const email = `${name}@ws.tablamigo`;
  const remoteAddress = `10.99.5.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '888888' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1997-07-07', gender, homeCountry: 'IN' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@ws.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@ws.tablamigo'`;
  u.ws_maya = await login('ws_maya', 'woman');
  u.ws_david = await login('ws_david', 'man');
  u.ws_free = await login('ws_free', 'woman');
  await sql`update users set plus_until = now() + interval '30 days' where email like '%@ws.tablamigo' and email <> 'ws_free@ws.tablamigo'`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@ws.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Feature 28: Women-Only City Chats & Safety Advice', () => {
  it('returns curated female safety advice and handles city chat joining', async () => {
    // 1. Get city guide with womenSafety advice
    const res = await u.ws_maya('GET', '/cities/mumbai');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.womenSafety)).toBe(true);
    expect(body.womenSafety.length).toBeGreaterThan(0);
    expect(body.womenSafety[0]).toContain('Mumbai');

    // 2. Maya (woman) joins women-only city chat
    const joinMaya = await u.ws_maya('POST', '/cities/mumbai/join-chat', { womenOnly: true });
    expect(joinMaya.statusCode).toBe(200);
    expect(joinMaya.json().womenOnly).toBe(true);
    expect(joinMaya.json().title).toContain('Women Nomads 🌸');
    const womenChatId = joinMaya.json().chatId;
    expect(womenChatId).toBeDefined();

    // 3. David (man) tries to join women-only city chat -> rejected with 403
    const joinDavidFail = await u.ws_david('POST', '/cities/mumbai/join-chat', { womenOnly: true });
    expect(joinDavidFail.statusCode).toBe(403);
    expect(joinDavidFail.json().error).toBe('women_only');

    // 4. David joins general city chat -> succeeds
    const joinDavidGeneral = await u.ws_david('POST', '/cities/mumbai/join-chat', { womenOnly: false });
    expect(joinDavidGeneral.statusCode).toBe(200);
    expect(joinDavidGeneral.json().womenOnly).toBe(false);
    expect(joinDavidGeneral.json().title).toContain('travelers');

    // 5. GET /cities now returns womenChatId for Mumbai
    const citiesRes = await u.ws_maya('GET', '/cities');
    const mumbai = citiesRes.json().cities.find((c: any) => c.slug === 'mumbai');
    expect(mumbai).toBeDefined();
    expect(mumbai.womenChatId).toBe(womenChatId);
  });

  it('exploit: nobody can name a women-only chat key; the server builds it from a known city', async () => {
    const davidId = await idOf('ws_david');
    // The takeover: a man joined (or created, as a mixed chat) "<city>:women" by putting it in the slug.
    for (const url of ['/cities/mumbai:women/join-chat', '/cities/mumbai%3Awomen/join-chat', '/cities/delhi:women/join-chat', '/cities/chiang-mai:women/join-chat']) {
      const r = await u.ws_david('POST', url, {});
      expect(r.statusCode, url).toBe(400);
      expect(r.json().error).toBe('invalid_input');
    }
    // Only known city guides: a made-up city gets no chat at all.
    expect((await u.ws_david('POST', '/cities/pathankot/join-chat', {})).statusCode).toBe(404);
    const squatted = await sql`select c.city_key from chat_members cm join chats c on c.id = cm.chat_id where cm.user_id = ${davidId} and c.city_key like '%:women'`;
    expect(squatted).toHaveLength(0);
    // Every women's chat row is women_only, so assertMember keeps men out even if one were a member somehow.
    expect((await sql`select count(*)::int as n from chats where city_key in ('mumbai:women', 'delhi:women', 'chiang-mai:women') and not women_only`)[0].n).toBe(0);
  });

  it('exploit: a member whose profile stops saying woman loses the women-only chat in lists, history and pushes', async () => {
    const chatId = (await u.ws_maya('POST', '/cities/mumbai/join-chat', { womenOnly: true })).json().chatId;
    await u.ws_maya('PATCH', '/me', { gender: 'man' });
    expect((await u.ws_maya('GET', '/chats')).json().chats.map((c: any) => c.id)).not.toContain(chatId);
    expect((await u.ws_maya('GET', `/chats/${chatId}/messages`)).statusCode).toBe(403);
    await u.ws_maya('PATCH', '/me', { gender: 'woman' });
    expect((await u.ws_maya('GET', '/chats')).json().chats.map((c: any) => c.id)).toContain(chatId);
  });

  it('exploit: free accounts get the city-chat window here too (in the city, or a trip within 3 days)', async () => {
    const freeId = await idOf('ws_free');
    await sql`update users set city = null where id = ${freeId}`;
    const early = await u.ws_free('POST', '/cities/goa/join-chat', {});
    expect(early.statusCode).toBe(402);
    expect(early.json().feature).toBe('city_chat_early');
    // A trip a month away is still too early on the free tier.
    const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
    await u.ws_free('POST', '/trips', { city: 'Goa', countryCode: 'IN', startDate: day(30), endDate: day(35) });
    expect((await u.ws_free('POST', '/cities/goa/join-chat', {})).statusCode).toBe(402);
    await u.ws_free('POST', '/trips', { city: 'Goa', countryCode: 'IN', startDate: day(2), endDate: day(6) });
    expect((await u.ws_free('POST', '/cities/goa/join-chat', {})).statusCode).toBe(200);
    // Being in the city counts too.
    await sql`update users set city = 'Mumbai' where id = ${freeId}`;
    expect((await u.ws_free('POST', '/cities/mumbai/join-chat', {})).statusCode).toBe(200);
    // Plus has no window: a city they are neither in nor travelling to.
    expect((await u.ws_free('POST', '/cities/lisbon/join-chat', {})).statusCode).toBe(402);
    await sql`update users set plus_until = now() + interval '30 days' where id = ${freeId}`;
    expect((await u.ws_free('POST', '/cities/lisbon/join-chat', {})).statusCode).toBe(200);
  });

  it('filters nearby travelers by women-only for female users and rejects male users', async () => {
    const mayaId = await idOf('ws_maya');
    const davidId = await idOf('ws_david');

    // Set locations in Mumbai
    await sql`update users set location = ST_SetSRID(ST_MakePoint(72.8777, 19.0760), 4326)::geography, location_at = now() where id in (${mayaId}, ${davidId})`;

    // Maya queries with women_only=true -> succeeds and returns only women
    const mayaQuery = await u.ws_maya('GET', '/travelers/nearby?lat=19.0760&lng=72.8777&women_only=true');
    expect(mayaQuery.statusCode).toBe(200);
    const { travelers } = mayaQuery.json();
    // David (man) must not appear
    expect(travelers.find((t: any) => t.id === davidId)).toBeUndefined();

    // David (man) queries with women_only=true -> 403 forbidden
    const davidQuery = await u.ws_david('GET', '/travelers/nearby?lat=19.0760&lng=72.8777&women_only=true');
    expect(davidQuery.statusCode).toBe(403);
    expect(davidQuery.json().error).toBe('women_only');
  });
});
