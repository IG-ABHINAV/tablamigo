// Chat niceties: emoji reactions, replies and read receipts, their realtime events, and blocks hiding them both ways.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
const PEOPLE = ['amy', 'ben', 'cat', 'dan', 'eve', 'fay', 'gil'];
const D = '@chatx.tablamigo';
process.env.REVIEW_EMAILS = PEOPLE.map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { attachRealtime } = await import('./lib/realtime.js');

let app: Awaited<ReturnType<typeof build>>;
let port = 0;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;
const BKK = { lat: 13.7466, lng: 100.5346 };
const u: Record<string, { call: Api; id: string; token: string }> = {};

let ip = 0;
async function login(name: string) {
  const email = name + D; const remoteAddress = `10.77.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const token = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1992-02-02', gender: 'woman', homeCountry: 'th' });
  const id = (await call('GET', '/me')).json().id as string;
  return { call, id, token };
}

/** A bare socket.io v4 client over Node's WebSocket (the API has no socket.io-client dependency). */
function socket(token: string) {
  const events: { event: string; data: any }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/?EIO=4&transport=websocket`);
  const ready = new Promise<void>((resolve, reject) => {
    ws.onmessage = e => {
      const d = String(e.data);
      if (d === '2') ws.send('3');
      else if (d.startsWith('0')) ws.send('40' + JSON.stringify({ token }));
      else if (d.startsWith('40')) setTimeout(resolve, 250); // the server joins chat rooms after an async query
      else if (d.startsWith('44')) reject(new Error(d));
      else if (d.startsWith('42')) { const [event, data] = JSON.parse(d.slice(2)); events.push({ event, data }); }
    };
    ws.onerror = () => reject(new Error('socket error'));
  });
  return { ready, events, close: () => ws.close(), of: (event: string) => events.filter(e => e.event === event).map(e => e.data) };
}
const settle = () => new Promise(r => setTimeout(r, 300));

const say = (who: string, chatId: string, body: string, replyTo?: string) => u[who].call('POST', `/chats/${chatId}/messages`, { body, replyTo });
const react = (who: string, chatId: string, mid: string, emoji: string) => u[who].call('POST', `/chats/${chatId}/messages/${mid}/react`, { emoji });
const messages = async (who: string, chatId: string) => (await u[who].call('GET', `/chats/${chatId}/messages`)).json();
const msg = async (who: string, chatId: string, mid: string) => (await messages(who, chatId)).messages.find((m: any) => m.id === mid);

let group = '', dm = '';
beforeAll(async () => {
  app = await build();
  attachRealtime(app.server);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  await sql`delete from users where email like ${'%' + D}`;
  for (const p of PEOPLE) u[p] = await login(p);
  const startsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
  const a = (await u.amy.call('POST', '/activities', { title: 'Chatx noodle crawl', category: 'food', placeName: 'Yaowarat', ...BKK, startsAt })).json();
  group = a.chatId;
  for (const p of ['ben', 'cat', 'dan']) expect((await u[p].call('POST', `/activities/${a.id}/join`)).statusCode).toBe(200);
  // amy and ben share the plan, so their DM has no free-tier limits
  dm = (await u.amy.call('POST', `/dm/${u.ben.id}`)).json().chatId;
});
afterAll(async () => { await sql`delete from users where email like ${'%' + D}`; await app.close(); await sql.end(); });

describe('reactions', () => {
  it('add, count, see who, switch, toggle off', async () => {
    const m = (await say('amy', group, 'Meet at the gate at 7?')).json();
    const r1 = (await react('ben', group, m.id, '👍')).json();
    expect(r1).toMatchObject({ id: m.id, emoji: '👍', reactions: [{ emoji: '👍', count: 1, mine: true, users: [{ id: u.ben.id, name: 'ben' }] }] });
    await react('cat', group, m.id, '👍');
    expect((await msg('amy', group, m.id)).reactions).toEqual([{ emoji: '👍', count: 2, mine: false, users: [{ id: u.ben.id, name: 'ben' }, { id: u.cat.id, name: 'cat' }] }]);

    // another emoji replaces ben's, the same one again removes it
    expect((await react('ben', group, m.id, '❤️')).json().reactions.map((r: any) => [r.emoji, r.count, r.mine])).toEqual([['👍', 1, false], ['❤️', 1, true]]);
    const off = (await react('ben', group, m.id, '❤️')).json();
    expect(off.emoji).toBeNull();
    expect(off.reactions).toEqual([{ emoji: '👍', count: 1, mine: false, users: [{ id: u.cat.id, name: 'cat' }] }]);
    expect(await sql`select 1 from message_reactions where message_id = ${m.id} and user_id = ${u.ben.id}`).toHaveLength(0);
  });

  it('refuses other emoji, other chats, system lines and non-members', async () => {
    const m = (await say('amy', group, 'Refusals')).json();
    expect((await react('ben', group, m.id, '🔥')).statusCode).toBe(400);
    expect((await react('amy', dm, m.id, '👍')).statusCode).toBe(404);
    const [sys] = await sql`select id::text from messages where chat_id = ${group} and kind = 'system' limit 1`;
    expect((await react('ben', group, sys.id, '👍')).statusCode).toBe(404);
    expect((await react('gil', group, m.id, '👍')).statusCode).toBe(403);
  });

  it('a block hides reactions both ways, over HTTP and realtime', async () => {
    const m = (await say('amy', group, 'Who is bringing cash?')).json();
    await react('cat', group, m.id, '👍');
    await react('dan', group, m.id, '😂');
    const amySock = socket(u.amy.token), catSock = socket(u.cat.token);
    await Promise.all([amySock.ready, catSock.ready]);

    await u.dan.call('POST', `/blocks/${u.cat.id}`);
    // dan no longer sees cat's reaction, and cat no longer sees dan's; amy sees both
    expect((await msg('dan', group, m.id)).reactions.map((r: any) => r.emoji)).toEqual(['😂']);
    expect((await msg('cat', group, m.id)).reactions.map((r: any) => r.emoji)).toEqual(['👍']);
    expect((await msg('amy', group, m.id)).reactions.map((r: any) => r.emoji)).toEqual(['👍', '😂']);

    // realtime: dan's new reaction and message reach amy, never cat
    await react('dan', group, m.id, '😮');
    const dm2 = (await say('dan', group, 'I can bring some')).json();
    await settle();
    expect(amySock.of('message:reaction')).toContainEqual({ chatId: group, id: m.id, userId: u.dan.id, userName: 'dan', emoji: '😮' });
    expect(amySock.of('message:new').map(x => x.id)).toContain(dm2.id);
    expect(catSock.of('message:reaction').filter(x => x.userId === u.dan.id)).toEqual([]);
    expect(catSock.of('message:new').map(x => x.id)).not.toContain(dm2.id);
    // and cat can't react to a message of dan's it can't see
    expect((await react('cat', group, dm2.id, '👍')).statusCode).toBe(404);
    amySock.close(); catSock.close();
    await u.dan.call('DELETE', `/blocks/${u.cat.id}`);
  });

  it("don't count toward the free DM limit", async () => {
    const chat = (await u.eve.call('POST', `/dm/${u.fay.id}`)).json().chatId as string;
    const sent = [];
    for (const b of ['Hi Fay', 'In Bangkok this week?', 'Street food?']) sent.push((await say('eve', chat, b)).json());
    expect((await say('eve', chat, 'Hello?')).json().error).toBe('dm_wait_reply');
    // eve can still react at the limit, and fay's reaction isn't a reply
    expect((await react('eve', chat, sent[0].id, '🙏')).statusCode).toBe(200);
    expect((await react('fay', chat, sent[1].id, '😂')).statusCode).toBe(200);
    expect((await messages('eve', chat)).chat.gate).toMatchObject({ code: 'dm_wait_reply', remaining: 0, open: null });
    expect(await sql`select 1 from dm_starts where user_id = ${u.fay.id}`).toHaveLength(0);
  });
});

describe('replies', () => {
  it('quote a message in the same chat; the quote shows in the new message', async () => {
    const orig = (await say('amy', group, 'Dinner at 8, Jay Fai?')).json();
    const r = (await say('ben', group, 'Yes! Booking now', orig.id)).json();
    expect(r.replyTo).toMatchObject({ id: orig.id, senderId: u.amy.id, senderName: 'amy', kind: 'text', body: 'Dinner at 8, Jay Fai?', unavailable: false });
    expect((await msg('cat', group, r.id)).replyTo).toEqual({ id: orig.id, senderId: u.amy.id, senderName: 'amy', kind: 'text', body: 'Dinner at 8, Jay Fai?', unavailable: false });
    expect((await msg('cat', group, orig.id)).replyTo).toBeNull();
  });

  it('refuses a quote from another chat, a missing one or a system line', async () => {
    const other = (await say('amy', dm, 'Private note')).json();
    const res = await say('ben', group, 'Leaking a DM', other.id);
    expect(res.statusCode).toBe(400); expect(res.json().error).toBe('reply_not_in_chat');
    expect((await say('ben', group, 'Nothing', '999999999999')).json().error).toBe('reply_not_in_chat');
    const [sys] = await sql`select id::text from messages where chat_id = ${group} and kind = 'system' limit 1`;
    expect((await say('ben', group, 'System', sys.id)).json().error).toBe('reply_not_in_chat');
    expect(await sql`select 1 from messages where body in ('Leaking a DM', 'Nothing', 'System')`).toHaveLength(0);
  });

  it('moderation and the contact shield apply to reply text', async () => {
    const orig = (await say('amy', group, 'What time works?')).json();
    const { config } = await import('./lib/config.js');
    config.openaiKey = 'sk-test';
    const flagged = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ results: [{ flagged: true, categories: { harassment: true } }] })));
    expect((await say('ben', group, 'something nasty', orig.id)).json().error).toBe('message_blocked');
    flagged.mockRestore(); config.openaiKey = '';

    // eve and gil are strangers on the free tier: a phone number in a DM reply is held back
    const chat = (await u.gil.call('POST', `/dm/${u.eve.id}`)).json().chatId as string;
    const hi = (await say('gil', chat, 'Hi Eve, saw your plan')).json();
    const res = await say('eve', chat, 'text me on +66 81 234 5678', hi.id);
    expect(res.statusCode).toBe(403); expect(res.json().error).toBe('contact_shield');
  });

  it("a quote of someone the viewer blocked shows as unavailable, and can't be made", async () => {
    const catMsg = (await say('cat', group, 'I found a great spot')).json();
    await u.dan.call('POST', `/blocks/${u.cat.id}`);
    expect((await say('dan', group, 'Where?', catMsg.id)).json().error).toBe('reply_not_in_chat');
    const danSock = socket(u.dan.token); await danSock.ready;
    const r = (await say('amy', group, 'Send the pin!', catMsg.id)).json();
    await settle();
    expect((await msg('dan', group, r.id)).replyTo).toEqual({ id: catMsg.id, senderId: null, senderName: null, kind: 'text', body: '', unavailable: true });
    expect((await msg('ben', group, r.id)).replyTo.body).toBe('I found a great spot');
    // realtime: dan gets amy's reply once, with the quote hidden
    const got = danSock.of('message:new').filter(x => x.id === r.id);
    expect(got).toHaveLength(1);
    expect(got[0].replyTo).toMatchObject({ id: catMsg.id, body: '', senderName: null, unavailable: true });
    danSock.close();
    await u.dan.call('DELETE', `/blocks/${u.cat.id}`);
  });
});

describe('read receipts', () => {
  it('DM: "Seen" once the other person has read my last message', async () => {
    const amySock = socket(u.amy.token); await amySock.ready;
    const m = (await say('amy', dm, 'Are you coming tonight?')).json();
    expect((await messages('amy', dm)).reads).toEqual({});
    await u.ben.call('GET', `/chats/${dm}/messages`);
    expect((await u.ben.call('POST', `/chats/${dm}/read`)).statusCode).toBe(200);
    expect(Number((await messages('amy', dm)).reads[u.ben.id])).toBeGreaterThanOrEqual(Number(m.id));
    await settle();
    expect(amySock.of('chat:read')).toContainEqual({ chatId: dm, userId: u.ben.id, lastReadId: m.id });
    // reading again with nothing new sends nothing
    const n = amySock.of('chat:read').length;
    await u.ben.call('POST', `/chats/${dm}/read`); await settle();
    expect(amySock.of('chat:read')).toHaveLength(n);
    // a newer message of mine isn't seen yet
    await say('amy', dm, 'Ping');
    expect((await messages('amy', dm)).reads).toEqual({});
    amySock.close();
  });

  it('group: "Seen by N", sending counts as reading, blocks hide read state both ways', async () => {
    const m = (await say('cat', group, 'Running 5 min late')).json();
    await u.ben.call('POST', `/chats/${group}/read`);
    await u.dan.call('POST', `/chats/${group}/read`);
    expect(Object.keys((await messages('cat', group)).reads).sort()).toEqual([u.ben.id, u.dan.id].sort());
    // amy posting reads everything up to her own message
    await say('amy', group, 'No worries');
    expect(Object.keys((await messages('cat', group)).reads)).toContain(u.amy.id);

    const catSock = socket(u.cat.token); await catSock.ready;
    const m2 = (await say('cat', group, 'Here now')).json();
    await u.dan.call('POST', `/blocks/${u.cat.id}`);
    await u.dan.call('POST', `/chats/${group}/read`);
    await u.ben.call('POST', `/chats/${group}/read`);
    await settle();
    expect(Object.keys((await messages('cat', group)).reads)).toEqual([u.ben.id]);
    expect(catSock.of('chat:read').map(x => x.userId)).toEqual([u.ben.id]);
    expect(Number(catSock.of('chat:read')[0].lastReadId)).toBeGreaterThanOrEqual(Number(m2.id));
    expect(Number(m2.id)).toBeGreaterThan(Number(m.id));
    catSock.close();
    await u.dan.call('DELETE', `/blocks/${u.cat.id}`);
  });
});
