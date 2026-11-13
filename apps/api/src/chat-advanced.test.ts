import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['ca_host', 'ca_member', 'ca_other'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@chatadv.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 900;
let hostAuth = '';
async function login(name: string): Promise<Api> {
  const email = `${name}@chatadv.tablamigo`;
  const remoteAddress = `10.99.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  if (name === 'ca_host') hostAuth = `Bearer ${tok}`;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1995-05-05', gender: 'woman', homeCountry: 'ES' });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@chatadv.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});

afterAll(async () => {
  await sql`delete from users where email like '%@chatadv.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Message Edit & Delete (5 min window), Pinning, Search, and Media', () => {
  let chatId: string;
  let planId: string;

  beforeAll(async () => {
    // Host creates a plan
    const res = await u.ca_host('POST', '/activities', {
      title: 'Tapas & Sangria Evening',
      emoji: '🍷',
      category: 'food',
      placeName: 'Mercado Central',
      lat: 41.3851,
      lng: 2.1734,
      startsAt: new Date(Date.now() + 7200_000).toISOString(),
      maxPeople: 5
    });
    expect(res.statusCode).toBe(200);
    planId = res.json().id;
    chatId = res.json().chatId;

    // Member joins the plan
    const joinRes = await u.ca_member('POST', `/activities/${planId}/join`);
    expect(joinRes.statusCode).toBe(200);
  });

  it('allows message editing by sender within 5 minutes, updates body and sets edited_at', async () => {
    // Member sends a message
    const msgRes = await u.ca_member('POST', `/chats/${chatId}/messages`, {
      body: 'Hello everyone! Excited for tapas.'
    });
    expect(msgRes.statusCode).toBe(200);
    const msgId = msgRes.json().id;

    // Member edits their message
    const editRes = await u.ca_member('PATCH', `/chats/${chatId}/messages/${msgId}`, {
      body: 'Hello everyone! Super excited for tapas and sangria!'
    });
    expect(editRes.statusCode).toBe(200);
    expect(editRes.json().body).toBe('Hello everyone! Super excited for tapas and sangria!');
    expect(editRes.json().editedAt).toBeDefined();

    // Verification in chat messages list
    const listRes = await u.ca_host('GET', `/chats/${chatId}/messages`);
    const found = listRes.json().messages.find((m: any) => m.id === msgId);
    expect(found.body).toBe('Hello everyone! Super excited for tapas and sangria!');
    expect(found.editedAt).toBeDefined();

    // Other user cannot edit member's message
    const failEdit = await u.ca_host('PATCH', `/chats/${chatId}/messages/${msgId}`, {
      body: 'Unauthorized edit attempt'
    });
    expect(failEdit.statusCode).toBe(403);
  });

  it('enforces 5 minute window for editing', async () => {
    const msgRes = await u.ca_member('POST', `/chats/${chatId}/messages`, {
      body: 'Time check message'
    });
    const msgId = msgRes.json().id;

    // Artificially move message created_at 6 minutes into the past in the database
    await sql`update messages set created_at = now() - interval '6 minutes' where id = ${msgId}`;

    const editRes = await u.ca_member('PATCH', `/chats/${chatId}/messages/${msgId}`, {
      body: 'Too late edit'
    });
    expect(editRes.statusCode).toBe(400);
    expect(editRes.json().error).toBe('edit_window_expired');
  });

  it('allows sender to delete their message within 5 minutes', async () => {
    const msgRes = await u.ca_member('POST', `/chats/${chatId}/messages`, {
      body: 'I will delete this shortly'
    });
    const msgId = msgRes.json().id;

    // ca_other (not member) cannot delete
    const strangerDel = await u.ca_other('DELETE', `/chats/${chatId}/messages/${msgId}`);
    expect(strangerDel.statusCode).toBe(403);

    // ca_member deletes it
    const delRes = await u.ca_member('DELETE', `/chats/${chatId}/messages/${msgId}`);
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json().deleted).toBe(true);

    // Messages list no longer returns body
    const listRes = await u.ca_host('GET', `/chats/${chatId}/messages`);
    const found = listRes.json().messages.find((m: any) => m.id === msgId);
    expect(found.body).toBe('');
  });

  it('allows plan host to delete any message in group chat (moderation)', async () => {
    const msgRes = await u.ca_member('POST', `/chats/${chatId}/messages`, {
      body: 'Host can moderate this message'
    });
    const msgId = msgRes.json().id;

    // Artificially move created_at beyond 5 minutes
    await sql`update messages set created_at = now() - interval '10 minutes' where id = ${msgId}`;

    // Sender cannot delete anymore
    const senderFail = await u.ca_member('DELETE', `/chats/${chatId}/messages/${msgId}`);
    expect(senderFail.statusCode).toBe(403);

    // Host CAN delete it
    const hostDel = await u.ca_host('DELETE', `/chats/${chatId}/messages/${msgId}`);
    expect(hostDel.statusCode).toBe(200);
    expect(hostDel.json().deleted).toBe(true);
  });

  it('supports pinning and unpinning messages by host', async () => {
    const msgRes = await u.ca_host('POST', `/chats/${chatId}/messages`, {
      body: 'Meeting outside the fountain at 7 PM sharp!'
    });
    const msgId = msgRes.json().id;

    // Non-host member cannot pin
    const failPin = await u.ca_member('POST', `/chats/${chatId}/pin/${msgId}`);
    expect(failPin.statusCode).toBe(403);

    // Host pins it
    const pinRes = await u.ca_host('POST', `/chats/${chatId}/pin/${msgId}`);
    expect(pinRes.statusCode).toBe(200);
    expect(pinRes.json().pinnedMessage.id).toBe(msgId);
    expect(pinRes.json().pinnedMessage.body).toBe('Meeting outside the fountain at 7 PM sharp!');

    // Pinned message is visible in GET /chats/:id/messages
    const listRes = await u.ca_member('GET', `/chats/${chatId}/messages`);
    expect(listRes.json().chat.pinnedMessage).toBeDefined();
    expect(listRes.json().chat.pinnedMessage.id).toBe(msgId);

    // Host unpins it
    const unpinRes = await u.ca_host('DELETE', `/chats/${chatId}/pin`);
    expect(unpinRes.statusCode).toBe(200);

    const listRes2 = await u.ca_member('GET', `/chats/${chatId}/messages`);
    expect(listRes2.json().chat.pinnedMessage).toBeNull();
  });

  it('searches messages and retrieves media gallery', async () => {
    // Post distinct text messages and an image message
    await u.ca_host('POST', `/chats/${chatId}/messages`, {
      body: 'Does anyone have a reservation under Asha?'
    });
    await u.ca_member('POST', `/chats/${chatId}/messages`, {
      body: 'Yes, reservation is confirmed for 5.'
    });
    // An image message must be the sender's own upload: any other URL is refused.
    const foreign = await u.ca_host('POST', `/chats/${chatId}/messages`, { body: 'https://example.com/tapas.jpg', kind: 'image' });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error).toBe('bad_photo');
    const up = await app.inject({ method: 'POST', url: '/uploads/image/direct?kind=chat', payload: Buffer.from('fake-jpeg'),
      headers: { 'content-type': 'image/jpeg', authorization: hostAuth } });
    expect(up.statusCode).toBe(200);
    const photoUrl = up.json().publicUrl as string;
    expect((await u.ca_host('POST', `/chats/${chatId}/messages`, { body: photoUrl, kind: 'image' })).statusCode).toBe(200);

    // Search query 'reservation'
    const searchRes = await u.ca_member('GET', `/chats/${chatId}/search?q=reservation`);
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().results.length).toBeGreaterThanOrEqual(2);
    expect(searchRes.json().results[0].body).toContain('reservation');

    // Media gallery
    const mediaRes = await u.ca_member('GET', `/chats/${chatId}/media`);
    expect(mediaRes.statusCode).toBe(200);
    expect(mediaRes.json().media.length).toBeGreaterThanOrEqual(1);
    expect(mediaRes.json().media[0].url).toBe(photoUrl);
  });
});
