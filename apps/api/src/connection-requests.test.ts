// Connect is a request (migration 077, 4 Nov 2026): pending until the other person accepts, declined quietly, cancellable by
// the sender, and nothing for connected people (chat, friends' trips, the connections list) unlocks before acceptance.
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';

const notify = vi.fn(async () => {});
vi.mock('./lib/push.js', async orig => ({ ...(await orig<any>()), notify }));

const PEOPLE = ['cr_ana', 'cr_ben', 'cr_cat', 'cr_dev'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@connreq.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = ((method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>) & { id: string };

let ip = 40;
async function login(name: string): Promise<Api> {
  const email = `${name}@connreq.tablamigo`;
  const remoteAddress = `10.77.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call = ((method: string, url: string, payload?: unknown) => app.inject({
    method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress,
  })) as Api;
  await call('PATCH', '/me', { name: name.replace('cr_', '').toUpperCase(), birthdate: '1995-05-05', gender: 'man', homeCountry: 'IN' });
  call.id = (await sql`select id from users where email = ${email}`)[0].id;
  return call;
}

const u: Record<string, Api> = {};
const notices = async (userId: string, kind: string) =>
  (await sql`select actor_id from notifications where user_id = ${userId} and kind = ${kind}`).map(r => r.actorId);
const connected = async (a: string, b: string) =>
  (await sql`select count(*)::int as n from connections where (user_id = ${a} and friend_id = ${b}) or (user_id = ${b} and friend_id = ${a})`)[0].n;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@connreq.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});
beforeEach(() => notify.mockClear());
afterAll(async () => {
  await sql`delete from users where email like '%@connreq.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Connect is a request the other person accepts', () => {
  it('stays pending (nothing unlocked) until accepted, then connects both ways with a notice and push each way', async () => {
    const { cr_ana: ana, cr_ben: ben } = u;
    const sent = await ana('POST', `/users/${ben.id}/connect`, { message: 'Hey Ben, saw you are in Goa too!' });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({ status: 'requested', connected: false });
    expect(await connected(ana.id, ben.id)).toBe(0);

    // Both sides see where it stands.
    expect((await ana('GET', `/users/${ben.id}`)).json()).toMatchObject({ isConnected: false, connectionStatus: 'requested', incomingRequestId: null });
    const benView = (await ben('GET', `/users/${ana.id}`)).json();
    expect(benView).toMatchObject({ isConnected: false, connectionStatus: 'incoming' });
    expect(benView.incomingRequestId).toBeTruthy();

    // Ben's inbox of requests, with the note; Ana's sent list.
    const inbox = (await ben('GET', '/connections/requests')).json();
    expect(inbox.received).toHaveLength(1);
    expect(inbox.received[0]).toMatchObject({ userId: ana.id, name: 'ANA', message: 'Hey Ben, saw you are in Goa too!' });
    expect(inbox.sent).toHaveLength(0);
    expect((await ana('GET', '/connections/requests')).json().sent.map((r: any) => r.userId)).toEqual([ben.id]);

    // Notice + push to Ben (opens Ana's profile, where Accept is).
    expect(await notices(ben.id, 'connection_request')).toEqual([ana.id]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toMatchObject([[ben.id], { data: { userId: ana.id, nkind: 'connection_request' } }]);

    // Re-tapping a pending request sends nothing again.
    expect((await ana('POST', `/users/${ben.id}/connect`)).json().status).toBe('requested');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(await notices(ben.id, 'connection_request')).toHaveLength(1);

    // Connected-only things are still locked: no connections list entry, and a DM is a message request on Ben's side.
    expect((await ana('GET', '/connections')).json().connections).toEqual([]);
    const dm = await ana('POST', `/dm/${ben.id}`);
    expect(dm.statusCode).toBe(200);
    const [side] = await sql`select request_status from chat_members where chat_id = ${dm.json().chatId} and user_id = ${ben.id}`;
    expect(side.requestStatus).toBe('pending');

    // Only Ben can answer it.
    const reqId = inbox.received[0].id;
    expect((await ana('POST', `/connections/requests/${reqId}/respond`, { action: 'accept' })).statusCode).toBe(404);
    expect((await u.cr_cat('POST', `/connections/requests/${reqId}/respond`, { action: 'accept' })).statusCode).toBe(404);

    notify.mockClear();
    const acc = await ben('POST', `/connections/requests/${reqId}/respond`, { action: 'accept' });
    expect(acc.statusCode).toBe(200);
    expect(acc.json()).toMatchObject({ status: 'connected', connected: true });
    expect(await connected(ana.id, ben.id)).toBe(2);
    expect((await ana('GET', `/users/${ben.id}`)).json()).toMatchObject({ isConnected: true, connectionStatus: 'connected' });
    expect((await ben('GET', `/users/${ana.id}`)).json()).toMatchObject({ isConnected: true, connectionStatus: 'connected', incomingRequestId: null });
    expect((await ana('GET', '/connections')).json().connections.map((c: any) => c.id)).toEqual([ben.id]);
    expect((await ben('GET', '/connections')).json().connections.map((c: any) => c.id)).toEqual([ana.id]);
    expect((await ben('GET', '/connections/requests')).json().received).toEqual([]);
    expect(await notices(ana.id, 'connection_accepted')).toEqual([ben.id]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]).toMatchObject([[ana.id], { data: { userId: ben.id, nkind: 'connection_accepted' } }]);

    // A second answer finds nothing to answer.
    expect((await ben('POST', `/connections/requests/${reqId}/respond`, { action: 'decline' })).statusCode).toBe(404);

    // A new DM between connected people is accepted on both sides at once.
    await sql`delete from chats where id = ${dm.json().chatId}`;
    const dm2 = await ana('POST', `/dm/${ben.id}`);
    const [side2] = await sql`select request_status from chat_members where chat_id = ${dm2.json().chatId} and user_id = ${ben.id}`;
    expect(side2.requestStatus).toBe('accepted');
  });

  it('a decline is quiet and sticks: the sender still sees Requested, and cancel-and-ask-again notifies nobody', async () => {
    const { cr_cat: cat, cr_dev: dev } = u;
    await cat('POST', `/users/${dev.id}/connect`);
    const reqId = (await dev('GET', '/connections/requests')).json().received[0].id;
    notify.mockClear();
    const dec = await dev('POST', `/connections/requests/${reqId}/respond`, { action: 'decline' });
    expect(dec.json()).toMatchObject({ status: 'declined', connected: false });
    expect(notify).not.toHaveBeenCalled();
    expect(await connected(cat.id, dev.id)).toBe(0);
    expect((await cat('GET', `/users/${dev.id}`)).json().connectionStatus).toBe('requested');
    expect((await dev('GET', `/users/${cat.id}`)).json().connectionStatus).toBe('none');
    expect((await dev('GET', '/connections/requests')).json().received).toEqual([]);

    // Cancel, then ask again: filed as declined, nobody told.
    expect((await cat('DELETE', `/users/${dev.id}/connect`)).json().status).toBe('none');
    expect((await cat('GET', `/users/${dev.id}`)).json().connectionStatus).toBe('none');
    expect((await cat('POST', `/users/${dev.id}/connect`)).json().status).toBe('requested');
    expect(notify).not.toHaveBeenCalled();
    expect(await notices(dev.id, 'connection_request')).toHaveLength(1);
    expect((await dev('GET', '/connections/requests')).json().received).toEqual([]);

    // After 30 days it is a new request again.
    await sql`update connection_requests set declined_at = now() - interval '31 days' where sender_id = ${cat.id} and recipient_id = ${dev.id}`;
    await cat('DELETE', `/users/${dev.id}/connect`);
    await cat('POST', `/users/${dev.id}/connect`);
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await dev('GET', '/connections/requests')).json().received.map((r: any) => r.userId)).toEqual([cat.id]);
  });

  it('the sender can cancel a pending request; Connect back on an incoming request accepts it', async () => {
    const { cr_ana: ana, cr_cat: cat, cr_dev: dev } = u;
    await dev('POST', `/users/${ana.id}/connect`);
    expect((await ana('GET', '/connections/requests')).json().received.map((r: any) => r.userId)).toEqual([dev.id]);
    expect((await dev('DELETE', `/users/${ana.id}/connect`)).statusCode).toBe(200);
    expect((await ana('GET', '/connections/requests')).json().received).toEqual([]);
    expect((await ana('GET', `/users/${dev.id}`)).json().connectionStatus).toBe('none');

    await cat('POST', `/users/${ana.id}/connect`);
    notify.mockClear();
    const back = await ana('POST', `/users/${cat.id}/connect`);
    expect(back.json()).toMatchObject({ status: 'connected', connected: true });
    expect(await connected(ana.id, cat.id)).toBe(2);
    expect(notify.mock.calls.map(c => (c as any)[0])).toEqual([[cat.id]]);
  });

  it('blocks: no request either way, and a blocked sender\'s pending request disappears', async () => {
    const { cr_ben: ben, cr_dev: dev } = u;
    await dev('POST', `/users/${ben.id}/connect`);
    const reqId = (await ben('GET', '/connections/requests')).json().received[0].id;
    await sql`insert into blocks (blocker_id, blocked_id) values (${ben.id}, ${dev.id})`;
    expect((await ben('GET', '/connections/requests')).json().received).toEqual([]);
    expect((await ben('POST', `/connections/requests/${reqId}/respond`, { action: 'accept' })).statusCode).toBe(404);
    expect((await dev('POST', `/users/${ben.id}/connect`)).statusCode).toBe(404);
    expect(await connected(ben.id, dev.id)).toBe(0);
    await sql`delete from blocks where blocker_id = ${ben.id}`;
  });

  it('cannot connect with yourself, and a message is capped at 300 characters', async () => {
    const { cr_ana: ana, cr_ben: ben } = u;
    expect((await ana('POST', `/users/${ana.id}/connect`)).statusCode).toBe(400);
    await ana('DELETE', `/users/${ben.id}/connect`);
    expect((await ana('POST', `/users/${ben.id}/connect`, { message: 'x'.repeat(301) })).statusCode).toBe(400);
  });
});
