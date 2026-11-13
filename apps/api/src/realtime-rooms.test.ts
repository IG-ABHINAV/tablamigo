// Live chat events stop reaching an open socket as soon as its user may no longer listen to that chat: a DM request
// they declined, a women-only chat once their profile stops saying woman, and a mixed chat on a ':women' key that has
// just become women-only. Edits, deletes and pins go to the whole room, so the socket has to leave the room.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Response as InjectResponse } from 'light-my-request';
const PEOPLE = ['eva', 'fin', 'gia', 'hana', 'ivan', 'jon', 'kira', 'lee', 'root'];
const D = '@rooms.tablamigo';
process.env.REVIEW_EMAILS = PEOPLE.map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { attachRealtime } = await import('./lib/realtime.js');
const { config } = await import('./lib/config.js');
const jwt = (await import('jsonwebtoken')).default;

let app: Awaited<ReturnType<typeof build>>;
let port = 0;
type Api = (method: string, url: string, payload?: unknown) => Promise<InjectResponse>;
const u: Record<string, { call: Api; id: string; token: string }> = {};
const CHAT_KEYS = ['bali:women', 'bangalore:women', 'bali-id:women', 'bangalore-in:women'];   // the old slug keys, and the canonical ones (lib/city-chats.ts)

let ip = 0;
async function login(name: string, gender: 'woman' | 'man') {
  const email = name + D; const remoteAddress = `10.79.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const token = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1993-03-03', gender, homeCountry: 'in' });
  const id = (await call('GET', '/me')).json().id as string;
  return { call, id, token };
}

/** A bare socket.io v4 client over Node's WebSocket (as chat-extras.test.ts; the API has no socket.io-client). */
function socket(token: string) {
  const events: { event: string; data: any }[] = [];
  let closed = false, refused = false;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/?EIO=4&transport=websocket`);
  const ready = new Promise<void>((resolve, reject) => {
    ws.onmessage = e => {
      const d = String(e.data);
      if (d === '2') ws.send('3');
      else if (d.startsWith('0')) ws.send('40' + JSON.stringify({ token }));
      else if (d.startsWith('40')) setTimeout(resolve, 250); // the server joins chat rooms after an async query
      else if (d.startsWith('44')) { refused = true; reject(new Error(d)); }
      else if (d.startsWith('42')) { const [event, data] = JSON.parse(d.slice(2)); events.push({ event, data }); }
    };
    ws.onerror = () => reject(new Error('socket error'));
    ws.onclose = () => { closed = true; };
  });
  return { ready, events, close: () => ws.close(), isClosed: () => closed, wasRefused: () => refused, of: (event: string, chatId: string) => events.filter(e => e.event === event && e.data?.chatId === chatId).map(e => e.data) };
}
const settle = () => new Promise(r => setTimeout(r, 300));
const say = async (who: string, chatId: string, body: string) => {
  const r = await u[who].call('POST', `/chats/${chatId}/messages`, { body });
  expect(r.statusCode, `${who} posts`).toBe(200);
  return r.json().id as string;
};

beforeAll(async () => {
  app = await build();
  attachRealtime(app.server);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from chats where city_key in ${sql(CHAT_KEYS)}`;
  for (const p of PEOPLE) u[p] = await login(p, p === 'ivan' ? 'man' : 'woman');
  // Plus: no DM or city-chat limits get in the way of what is being tested.
  await sql`update users set plus_until = now() + interval '1 day' where email like ${'%' + D}`;
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from chats where city_key in ${sql(CHAT_KEYS)}`;
  await app.close();
  await sql.end();
});

describe('sockets leave a chat when their user may no longer listen', () => {
  it('exploit: after declining a DM request, edits and deletes in it no longer reach the open socket', async () => {
    const dm = (await u.eva.call('POST', `/dm/${u.fin.id}`)).json().chatId as string;
    const finSock = socket(u.fin.token); await finSock.ready;
    try {
      const m1 = await say('eva', dm, 'hi, same hostel?');
      const m2 = await say('eva', dm, 'we could share a cab');
      await settle();
      expect(finSock.of('message:new', dm).map(m => m.id)).toEqual([m1, m2]);   // the socket was in the room

      expect((await u.fin.call('POST', `/chats/${dm}/decline-request`, {})).json().status).toBe('declined');
      expect((await u.eva.call('PATCH', `/chats/${dm}/messages/${m1}`, { body: 'hi, are you at the same hostel?' })).statusCode).toBe(200);
      expect((await u.eva.call('DELETE', `/chats/${dm}/messages/${m2}`)).statusCode).toBe(200);
      await settle();
      expect(finSock.of('message:update', dm)).toEqual([]);
    } finally { finSock.close(); }
  });

  it('exploit: after changing gender away from woman, a women-only chat stops reaching the open socket', async () => {
    const chat = (await u.gia.call('POST', '/cities/bangalore/join-chat', { womenOnly: true })).json().chatId as string;
    expect((await u.hana.call('POST', '/cities/bangalore/join-chat', { womenOnly: true })).json().chatId).toBe(chat);
    const giaSock = socket(u.gia.token); await giaSock.ready;
    try {
      const m1 = await say('hana', chat, 'Koramangala brunch on Sunday?');
      await settle();
      expect(giaSock.of('message:new', chat).map(m => m.id)).toEqual([m1]);

      expect((await u.gia.call('PATCH', '/me', { gender: 'man' })).statusCode).toBe(200);
      expect((await u.hana.call('PATCH', `/chats/${chat}/messages/${m1}`, { body: 'Koramangala brunch on Sunday at 11?' })).statusCode).toBe(200);
      expect((await u.hana.call('POST', `/chats/${chat}/pin/${m1}`)).statusCode).toBe(200);
      await settle();
      expect(giaSock.of('message:update', chat)).toEqual([]);
      expect(giaSock.of('chat:pin', chat)).toEqual([]);
    } finally { giaSock.close(); }
  });

  it('exploit: a mixed chat squatting a :women key turns women-only, and its men stop getting live events', async () => {
    // Made before the fix: a man pre-created 'bali:women' as an ordinary chat.
    const [c] = await sql`insert into chats (kind, city_key, title, women_only, last_message_at)
      values ('city', 'bali:women', 'Bali Women Nomads', false, now()) returning id`;
    const chat = c.id as string;
    await sql`insert into chat_members (chat_id, user_id) values (${chat}, ${u.ivan.id})`;
    const ivanSock = socket(u.ivan.token); await ivanSock.ready;
    try {
      const own = await say('ivan', chat, 'welcome to Bali');
      await settle();
      expect(ivanSock.of('message:new', chat).map(m => m.id)).toEqual([own]);   // the socket was in the room

      // The first woman to join through the app makes it women-only.
      expect((await u.hana.call('POST', '/cities/bali/join-chat', { womenOnly: true })).json().chatId).toBe(chat);
      expect((await sql`select women_only from chats where id = ${chat}`)[0].womenOnly).toBe(true);
      const m1 = await say('hana', chat, 'Ubud yoga at 7, anyone?');
      expect((await u.hana.call('PATCH', `/chats/${chat}/messages/${m1}`, { body: 'Ubud yoga at 7:30, anyone?' })).statusCode).toBe(200);
      expect((await u.hana.call('POST', `/chats/${chat}/pin/${m1}`)).statusCode).toBe(200);
      await settle();
      expect(ivanSock.of('message:new', chat).map(m => m.id)).toEqual([own]);
      expect(ivanSock.of('message:update', chat)).toEqual([]);
      expect(ivanSock.of('chat:pin', chat)).toEqual([]);
    } finally { ivanSock.close(); }
  });

  it('exploit: leaving a plan takes the open socket out of the plan chat (it kept every message)', async () => {
    const plan = await u.eva.call('POST', '/activities', { title: 'Rooftop chai', category: 'food', startsAt: new Date(Date.now() + 4 * 3600_000).toISOString(), lat: 19.07, lng: 72.87, placeName: 'Bandra' });
    expect(plan.statusCode).toBe(200);
    const joined = await u.jon.call('POST', `/activities/${plan.json().id}/join`, {});
    expect(joined.statusCode).toBe(200);
    const chat = joined.json().chatId as string;
    const jonSock = socket(u.jon.token); await jonSock.ready;
    try {
      const m1 = await say('eva', chat, 'meet at 6');
      await settle();
      expect(jonSock.of('message:new', chat).map(m => m.id)).toEqual([m1]);   // the socket was in the room
      expect((await u.jon.call('POST', `/activities/${plan.json().id}/leave`)).statusCode).toBe(200);
      await say('eva', chat, 'address is the blue gate');
      await settle();
      expect(jonSock.of('message:new', chat).map(m => m.id)).toEqual([m1]);
    } finally { jonSock.close(); }
  });

  it('exploit: leaving a trip circle takes the open socket out of the circle chat', async () => {
    const trip = { city: 'Lisbon', countryCode: 'PT', startDate: '2026-11-10', endDate: '2026-11-20' };
    const gTrip = (await u.gia.call('POST', '/trips', trip)).json().id as string;
    await u.hana.call('POST', '/trips', trip);
    const chat = (await u.gia.call('POST', `/trips/${gTrip}/group-chat`)).json().chatId as string;
    expect(chat).toBeTruthy();
    const hTrip = (await u.hana.call('GET', '/trips')).json().trips[0].id as string;
    expect((await u.hana.call('POST', `/trips/${hTrip}/group-chat`)).json().chatId).toBe(chat);
    const hanaSock = socket(u.hana.token); await hanaSock.ready;
    try {
      const m1 = await say('gia', chat, 'who is up for Sintra?');
      await settle();
      expect(hanaSock.of('message:new', chat).map(m => m.id)).toEqual([m1]);
      expect((await u.hana.call('DELETE', `/trips/${hTrip}/group-chat`)).json().left).toBe(true);
      await say('gia', chat, 'train at 9');
      await settle();
      expect(hanaSock.of('message:new', chat).map(m => m.id)).toEqual([m1]);
    } finally { hanaSock.close(); }
  });

  it('exploit: deleting the account closes the open sockets and they cannot sign back in', async () => {
    const dm = (await u.eva.call('POST', `/dm/${u.kira.id}`)).json().chatId as string;
    const kiraSock = socket(u.kira.token); await kiraSock.ready;
    try {
      await say('eva', dm, 'hey');
      await settle();
      expect(kiraSock.isClosed()).toBe(false);
      expect((await u.kira.call('DELETE', '/me')).statusCode).toBe(200);
      await settle();
      expect(kiraSock.isClosed()).toBe(true);
    } finally { kiraSock.close(); }
    const again = socket(u.kira.token);
    await expect(again.ready).rejects.toThrow();   // the access token is still valid for 30 minutes
    expect(again.wasRefused()).toBe(true);
    again.close();
  });

  it('exploit: banning a user closes their open sockets and a reconnect is refused', async () => {
    await sql`update users set role = 'admin' where id = ${u.root.id}`;
    const dm = (await u.eva.call('POST', `/dm/${u.lee.id}`)).json().chatId as string;
    const leeSock = socket(u.lee.token); await leeSock.ready;
    try {
      await say('eva', dm, 'ping');
      await settle();
      expect(leeSock.isClosed()).toBe(false);
      expect((await u.root.call('POST', `/admin/users/${u.lee.id}/ban`)).statusCode).toBe(200);
      await settle();
      expect(leeSock.isClosed()).toBe(true);
    } finally { leeSock.close(); }
    const again = socket(u.lee.token);
    await expect(again.ready).rejects.toThrow();
    expect(again.wasRefused()).toBe(true);
    again.close();
  });

  it("an admin's look ends on the socket too: it is closed when the impersonation token expires", async () => {
    // A real one lives 15 minutes (lib/auth.ts signImpersonation); this one is the same token with 5 seconds to go.
    const exp = Math.floor(Date.now() / 1000) + 5;
    const short = jwt.sign({ sub: u.hana.id, imp: u.root.id, exp }, config.jwtSecret);
    const looking = socket(short); await looking.ready;
    const own = socket(u.hana.token); await own.ready;
    try {
      expect(looking.isClosed()).toBe(false);
      await new Promise(r => setTimeout(r, Math.max(0, exp * 1000 - Date.now()) + 600));
      expect(looking.isClosed()).toBe(true);
      expect(own.isClosed()).toBe(false);   // the person's own session is not on a clock
    } finally { looking.close(); own.close(); }
  }, 15_000);
});
