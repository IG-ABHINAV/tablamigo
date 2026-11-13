import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['dmr_alice', 'dmr_bob', 'dmr_carol'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@dmr.tablamigo`).join(',');
process.env.REVIEW_CODE = '666666';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 2000;
async function login(name: string): Promise<Api> {
  const email = `${name}@dmr.tablamigo`;
  const remoteAddress = `10.99.10.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '666666' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1995-05-05', gender: 'man', homeCountry: 'IN' });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@dmr.tablamigo'`;
  for (const p of PEOPLE) {
    u[p] = await login(p);
  }
});

afterAll(async () => {
  await sql`delete from users where email like '%@dmr.tablamigo'`;
  await app.close();
});

describe('Backlog 20: DM Message Requests & Safety Decisions', () => {
  let aliceId: string;
  let bobId: string;
  let carolId: string;
  let dmChatId: string;
  let carolChatId: string;

  it('gets user IDs and grants Plus to Alice and Carol for DM initiation', async () => {
    aliceId = (await sql`select id from users where email = 'dmr_alice@dmr.tablamigo'`)[0].id;
    bobId = (await sql`select id from users where email = 'dmr_bob@dmr.tablamigo'`)[0].id;
    carolId = (await sql`select id from users where email = 'dmr_carol@dmr.tablamigo'`)[0].id;

    await sql`update users set plus_until = now() + interval '30 days' where id in (${aliceId}, ${carolId})`;
  });

  it('Alice starts a DM with Bob (unconnected), creating a pending message request', async () => {
    const res = await u.dmr_alice('POST', `/dm/${bobId}`);
    expect(res.statusCode).toBe(200);
    dmChatId = res.json().chatId;
    expect(dmChatId).toBeDefined();

    // Alice sends initial message
    const sendRes = await u.dmr_alice('POST', `/chats/${dmChatId}/messages`, {
      body: 'Hi Bob! Saw you are also heading to Kyoto next week.'
    });
    expect(sendRes.statusCode).toBe(200);
  });

  it('Bob sees the DM as a message request in GET /chats and GET /chats/:id/messages', async () => {
    const listRes = await u.dmr_bob('GET', '/chats');
    expect(listRes.statusCode).toBe(200);
    const chats = listRes.json().chats;
    const reqChat = chats.find((c: any) => c.id === dmChatId);
    expect(reqChat).toBeDefined();
    expect(reqChat.isRequest).toBe(true);

    const msgRes = await u.dmr_bob('GET', `/chats/${dmChatId}/messages`);
    expect(msgRes.statusCode).toBe(200);
    expect(msgRes.json().chat.isRequest).toBe(true);
  });

  it('Bob accepts Alice message request and request_decided_at is stored', async () => {
    const acceptRes = await u.dmr_bob('POST', `/chats/${dmChatId}/accept-request`);
    expect(acceptRes.statusCode).toBe(200);
    expect(acceptRes.json().ok).toBe(true);
    expect(acceptRes.json().status).toBe('accepted');

    // Verify chat is now accepted and has request_decided_at timestamp
    const [member] = await sql`
      select request_status, request_decided_at
      from chat_members where chat_id = ${dmChatId} and user_id = ${bobId}`;
    expect(member.requestStatus).toBe('accepted');
    expect(member.requestDecidedAt).toBeDefined();

    // In Bob's GET /chats, isRequest is now false
    const listRes = await u.dmr_bob('GET', '/chats');
    const acceptedChat = listRes.json().chats.find((c: any) => c.id === dmChatId);
    expect(acceptedChat.isRequest).toBe(false);
  });

  it('Carol sends a DM request to Bob, and Bob declines with block', async () => {
    const startRes = await u.dmr_carol('POST', `/dm/${bobId}`);
    carolChatId = startRes.json().chatId;

    await u.dmr_carol('POST', `/chats/${carolChatId}/messages`, {
      body: 'Spam promotional offer!'
    });

    const declineRes = await u.dmr_bob('POST', `/chats/${carolChatId}/decline-request`, {
      block: true
    });
    expect(declineRes.statusCode).toBe(200);
    expect(declineRes.json().ok).toBe(true);
    expect(declineRes.json().status).toBe('declined');
    expect(declineRes.json().blocked).toBe(true);

    // Verify Bob blocked Carol
    const [block] = await sql`
      select 1 from blocks where blocker_id = ${bobId} and blocked_id = ${carolId}`;
    expect(block).toBeDefined();

    // Verify declined chat no longer appears in Bob's GET /chats
    const listRes = await u.dmr_bob('GET', '/chats');
    const declinedChat = listRes.json().chats.find((c: any) => c.id === carolChatId);
    expect(declinedChat).toBeUndefined();
  });
});
