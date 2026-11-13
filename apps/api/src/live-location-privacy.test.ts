// Live location in chats: coordinates never go to someone on either side of a block with the sharer (the socket updates used
// to go to the whole room), and the last position can't be read back once the share has expired or was stopped (history used
// to return the final coordinates for ever). An ended share is an inert { lat: 0, lng: 0, expiresAt, updatedAt, ended: true }, not null:
// the installed app (1.2.1) dereferences loc.lat/lng/expiresAt on every location message and must not crash. Sockets are bare socket.io clients over Node's WebSocket, as in realtime-rooms.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Response as InjectResponse } from 'light-my-request';

const D = '@liveloc.tablamigo';
const PEOPLE = ['ann', 'ben', 'cat'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { attachRealtime } = await import('./lib/realtime.js');

let app: Awaited<ReturnType<typeof build>>;
let port = 0;
type Api = (method: string, url: string, payload?: unknown) => Promise<InjectResponse>;
const u: Record<string, { call: Api; id: string; token: string }> = {};
let chatId = '';
let ip = 0;

async function login(name: string) {
  const email = name + D, remoteAddress = `10.91.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const token = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1993-03-03', gender: 'woman', homeCountry: 'IN' });
  u[name] = { call, id: (await call('GET', '/me')).json().id, token };
}

function socket(token: string) {
  const events: { event: string; data: any }[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rt/?EIO=4&transport=websocket`);
  const ready = new Promise<void>((resolve, reject) => {
    ws.onmessage = e => {
      const d = String(e.data);
      if (d === '2') ws.send('3');
      else if (d.startsWith('0')) ws.send('40' + JSON.stringify({ token }));
      else if (d.startsWith('40')) setTimeout(resolve, 250);
      else if (d.startsWith('44')) reject(new Error(d));
      else if (d.startsWith('42')) { const [event, data] = JSON.parse(d.slice(2)); events.push({ event, data }); }
    };
    ws.onerror = () => reject(new Error('socket error'));
  });
  return { ready, close: () => ws.close(), of: (event: string) => events.filter(e => e.event === event && e.data?.chatId === chatId).map(e => e.data) };
}
const settle = () => new Promise(r => setTimeout(r, 300));
const messages = async (who: string) => ((await u[who].call('GET', `/chats/${chatId}/messages`)).json().messages as any[]);

beforeAll(async () => {
  app = await build();
  attachRealtime(app.server);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as AddressInfo).port;
  await sql`delete from users where email like ${'%' + D}`;
  for (const p of PEOPLE) await login(p);
  // A plan chat with the three of them (made directly: creating a plan over HTTP looks the place up on Nominatim).
  const [a] = await sql`insert into activities (host_id, title, emoji, category, place_name, location, city, starts_at)
    values (${u.ann.id}, 'Live location walk', '🚶', 'explore', 'Old Town', ST_SetSRID(ST_MakePoint(100.5, 13.75), 4326)::geography, 'Bangkok', now() + interval '2 hours') returning id`;
  chatId = (await sql`insert into chats (kind, activity_id, title) values ('activity', ${a.id}, 'Live location walk') returning id`)[0].id;
  for (const p of PEOPLE) {
    await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${a.id}, ${u[p].id}, 'going')`;
    await sql`insert into chat_members (chat_id, user_id) values (${chatId}, ${u[p].id})`;
  }
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await app.close();
  await sql.end();
});

describe('live location and blocks', () => {
  it('exploit: a blocked person gets no coordinates, not on sharing, not on each update and not when it stops', async () => {
    expect((await u.cat.call('POST', `/blocks/${u.ann.id}`)).statusCode).toBe(200);   // Cat blocks Ann: neither may get the other's position
    const ben = socket(u.ben.token), cat = socket(u.cat.token);
    await Promise.all([ben.ready, cat.ready]);

    const shared = await u.ann.call('POST', `/chats/${chatId}/locations`, { lat: 13.7466, lng: 100.5346, minutes: 60 });
    expect(shared.statusCode).toBe(200);
    const mid = shared.json().id as string;
    expect((await u.ann.call('PATCH', `/chats/${chatId}/locations/${mid}`, { lat: 13.7501, lng: 100.5399 })).statusCode).toBe(200);
    // Ann edits a text message too: the new text is as private as the old one.
    const text = (await u.ann.call('POST', `/chats/${chatId}/messages`, { body: 'meet at the pier' })).json().id as string;
    expect((await u.ann.call('PATCH', `/chats/${chatId}/messages/${text}`, { body: 'meet at the old pier' })).statusCode).toBe(200);
    const stopped = await u.ann.call('POST', `/chats/${chatId}/locations/${mid}/stop`);
    expect(stopped.statusCode).toBe(200);
    await settle();

    // Ben (no block) gets everything, as before.
    expect(ben.of('message:new').some(m => m.kind === 'location' && m.location.lat === 13.7466)).toBe(true);
    const benUpdates = ben.of('message:update');
    expect(benUpdates.find(m => m.id === mid && m.location?.lat === 13.7501)).toBeTruthy();
    expect(benUpdates.find(m => m.id === text)?.body).toBe('meet at the old pier');
    expect(benUpdates.find(m => m.id === mid && m.location?.ended)?.location).toEqual({ lat: 0, lng: 0, expiresAt: expect.any(String), updatedAt: expect.any(String), ended: true });
    // Cat (blocked) gets none of it: no new message, no position update, no edit, no stop.
    expect(cat.of('message:new').filter(m => m.senderId === u.ann.id)).toEqual([]);
    expect(cat.of('message:update')).toEqual([]);
    expect(JSON.stringify(cat.of('message:new'))).not.toContain('13.75');
    ben.close(); cat.close();
  });
});

// What the installed 1.2.1 ChatLocationCard does with a location message (apps/mobile/src/components/ChatLocationCard.tsx): it
// reads loc.expiresAt, loc.updatedAt, loc.lat and loc.lng unconditionally, builds the "Open in Maps" link from lat/lng, and shows
// "Ended" when expiresAt is not in the future. A null or partial location would throw there.
function card121(loc: any) {
  const end = new Date(loc.expiresAt).getTime();
  const live = end > Date.now();
  const hhmm = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const geo = `geo:${loc.lat},${loc.lng}?q=${loc.lat},${loc.lng}(x)`;
  const center = [loc.lng, loc.lat];
  const label = live ? `Live until ${hhmm(loc.expiresAt)}` : 'Ended';
  return { live, label, updated: hhmm(loc.updatedAt), geo, center, end };
}

describe('live location after the share', () => {
  it('the installed 1.2.1 card renders an ended share (history, stop response, socket patch) as "Ended" and can read every field it touches', async () => {
    const live = await u.ann.call('POST', `/chats/${chatId}/locations`, { lat: 13.77, lng: 100.58, minutes: 15 });
    const lid = live.json().id as string;
    const liveCard = card121((await messages('ben')).find(x => x.id === lid).location);
    expect(liveCard.live).toBe(true);
    expect(liveCard.center).toEqual([100.58, 13.77]);

    const stop = await u.ann.call('POST', `/chats/${chatId}/locations/${lid}/stop`);
    const bens = socket(u.ben.token);
    await bens.ready;
    for (const loc of [stop.json().location, (await messages('ben')).find(x => x.id === lid).location, (await messages('ann')).find(x => x.id === lid).location]) {
      expect(loc).toBeTruthy();                                                   // never null/undefined: the card dereferences it
      const c = card121(loc);
      expect(c.live).toBe(false);
      expect(c.label).toBe('Ended');
      expect(Number.isFinite(c.end)).toBe(true);
      expect(c.updated).not.toBe('Invalid Date');
      expect(c.geo).toBe('geo:0,0?q=0,0(x)');                                     // no real position in the link or the map centre
      expect(c.center).toEqual([0, 0]);
      expect(typeof loc.lat).toBe('number'); expect(typeof loc.lng).toBe('number');
    }
    expect(JSON.stringify([stop.json(), await messages('ben'), await messages('ann')])).not.toMatch(/100\.58|13\.77/);
    bens.close();
  });

  let mid = '';

  it('while it is live the history has the coordinates; once expired or stopped it has none (the row stays for retention, never served)', async () => {
    const r = await u.ann.call('POST', `/chats/${chatId}/locations`, { lat: 13.7, lng: 100.51, minutes: 15 });
    mid = r.json().id as string;
    const live = (await messages('ben')).find(m => m.id === mid);
    expect(live.location).toMatchObject({ lat: 13.7, lng: 100.51 });
    expect(new Date(live.location.expiresAt).getTime()).toBeGreaterThan(Date.now());

    // It runs out.
    await sql`update chat_locations set expires_at = now() - interval '1 second' where message_id = ${mid}`;
    const expired = (await messages('ben')).find(m => m.id === mid);
    expect(expired.kind).toBe('location');
    expect(expired.location).toEqual({ lat: 0, lng: 0, expiresAt: expect.any(String), updatedAt: expect.any(String), ended: true });
    expect(new Date(expired.location.expiresAt).getTime()).toBeLessThan(Date.now());
    expect(JSON.stringify(await messages('ben'))).not.toContain('100.51');
    expect(JSON.stringify(await messages('ann'))).not.toContain('100.51');                 // not even for the person who shared it
    expect((await sql`select count(*)::int as n from chat_locations where message_id = ${mid}`)[0].n).toBe(1);   // kept until the purge, not served
    // It can't be revived, and the sharer's phone is told so.
    const late = await u.ann.call('PATCH', `/chats/${chatId}/locations/${mid}`, { lat: 13.9, lng: 100.9 });
    expect(late.statusCode).toBe(400);
    expect(late.json().error).toBe('location_ended');
  });

  it('stopping returns no coordinates in the response or the history', async () => {
    const r = await u.ann.call('POST', `/chats/${chatId}/locations`, { lat: 13.71, lng: 100.52, minutes: 60 });
    const id2 = r.json().id as string;
    const stop = await u.ann.call('POST', `/chats/${chatId}/locations/${id2}/stop`);
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toEqual({ id: id2, location: { lat: 0, lng: 0, expiresAt: expect.any(String), updatedAt: expect.any(String), ended: true } });
    expect(JSON.stringify(stop.json())).not.toMatch(/100\.52|13\.71/);
    const m = (await messages('ben')).find(x => x.id === id2);
    expect(m.location).toMatchObject({ lat: 0, lng: 0, ended: true });
    expect(JSON.stringify(await messages('ben'))).not.toContain('100.52');
    // Stopping twice is harmless, and someone else can't stop it.
    expect((await u.ann.call('POST', `/chats/${chatId}/locations/${id2}/stop`)).statusCode).toBe(200);
    expect((await u.ben.call('POST', `/chats/${chatId}/locations/${id2}/stop`)).statusCode).toBe(403);
  });
});
