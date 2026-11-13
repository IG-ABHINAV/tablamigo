// Who gets a push, what it says, and what happens to a token FCM says is gone. push.test.ts covers the two senders' wire
// format; this file goes through the routes people use (send a message, DM, join a plan) with FCM mocked at the client.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Person } from '../helpers.js';

const { fcmRequest } = vi.hoisted(() => ({ fcmRequest: vi.fn(async (_o: any) => ({ data: {} })) }));
vi.mock('google-auth-library', async orig => ({ ...(await orig<any>()), GoogleAuth: class { async getClient() { return { request: fcmRequest }; } } }));
const sa = path.join(os.tmpdir(), `tablamigo-push-delivery-${process.pid}.json`);
fs.writeFileSync(sa, JSON.stringify({ project_id: 'fcm-delivery-test' }));
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = sa;

const D = '@pushd.tablamigo';
const NAMES = ['host', 'ana', 'ben', 'cat', 'dan'];
process.env.REVIEW_EMAILS = NAMES.map(n => n + D).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { signIn, onboard, createPlan, BKK } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
const u: Record<string, Person> = {};
const tokenOf = (n: string) => `fcm-token-for-${n}-0001`;
/** The FCM messages sent since the last clear, as { to: person, title, body, chatId, tag }. */
const sent = () => fcmRequest.mock.calls.map(([o]: any) => {
  const m = o.data.message;
  return { to: NAMES.find(n => tokenOf(n) === m.token) ?? m.token, title: m.notification.title, body: m.notification.body, chatId: m.data.chatId, tag: m.android.notification.tag };
});
// notify() is fire-and-forget after the response; wait for the pushes the test expects.
const pushedTo = async (...who: string[]) => vi.waitFor(() => expect(sent().map(s => s.to).sort()).toEqual([...who].sort()), { timeout: 3000, interval: 25 });
const settle = () => new Promise(r => setTimeout(r, 300));
/** Join a plan, then wait for the host's "joined your plan" pushes (fire-and-forget too) and clear them out of the way. */
async function joinAll(plan: { id: string }, names: string[]) {
  fcmRequest.mockClear();
  for (const n of names) expect((await u[n].call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
  await pushedTo(...names.map(() => 'host'));
  fcmRequest.mockClear();
}

beforeAll(async () => {
  app = await build();
  await sql`delete from push_tokens where token like 'fcm-token-for-%' or token = 'one-phone-two-accounts-0001'`;
  await sql`delete from users where email like ${'%' + D}`;
  for (const n of NAMES) {
    u[n] = await onboard(await signIn(app, n + D, '424242', 83), { name: n, gender: 'woman' }, BKK);
    expect((await u[n].call('POST', '/me/push-token', { token: tokenOf(n), platform: 'android' })).statusCode).toBe(200);
  }
  // Plus for everyone: the free plan and DM limits are not what this file is about.
  await sql`update users set comp_until = now() + interval '1 day', plus_until = now() + interval '1 day' where email like ${'%' + D}`;
});
afterAll(async () => {
  await sql`delete from push_tokens where token = 'one-phone-two-accounts-0001'`;
  await sql`delete from users where email like ${'%' + D}`;
  await app.close(); await sql.end(); fs.rmSync(sa, { force: true });
});
beforeEach(() => { fcmRequest.mockReset(); fcmRequest.mockImplementation(async () => ({ data: {} })); });

describe('push on a new message', () => {
  it('a group message goes to every other member, titled with the plan and "name: text", tagged with the chat; never the sender', async () => {
    const plan = await createPlan(u.host, { title: 'Street food walk' });
    await joinAll(plan, ['ana', 'ben']);
    expect((await u.ana.call('POST', `/chats/${plan.chatId}/messages`, { body: 'See you at 8' })).statusCode).toBe(200);
    await pushedTo('host', 'ben');
    for (const s of sent()) expect(s).toMatchObject({ title: 'Street food walk', body: 'ana: See you at 8', chatId: plan.chatId, tag: plan.chatId });
    expect(fcmRequest.mock.calls[0][0]).toMatchObject({ method: 'POST', url: 'https://fcm.googleapis.com/v1/projects/fcm-delivery-test/messages:send',
      data: { message: { android: { priority: 'high', notification: { channel_id: 'default' } } } } });
  });

  it('nobody on either side of a block with the sender, and nobody who muted the chat, is pushed', async () => {
    const plan = await createPlan(u.host, { title: 'Night market' });
    await joinAll(plan, ['ana', 'ben', 'cat']);
    expect((await u.ben.call('POST', `/blocks/${u.ana.id}`)).statusCode).toBe(200);          // ben blocked ana
    await sql`update chat_members set muted = true where chat_id = ${plan.chatId} and user_id = ${u.host.id}`;   // host muted it
    fcmRequest.mockClear();
    expect((await u.ana.call('POST', `/chats/${plan.chatId}/messages`, { body: 'Anyone hungry?' })).statusCode).toBe(200);
    await pushedTo('cat');
    await settle();
    expect(sent().map(s => s.to)).toEqual(['cat']);
    // The other direction: ben (the blocker) writes; ana is not pushed either.
    fcmRequest.mockClear();
    expect((await u.ben.call('POST', `/chats/${plan.chatId}/messages`, { body: 'I am in' })).statusCode).toBe(200);
    await pushedTo('cat');
    await settle();
    expect(sent().map(s => s.to)).toEqual(['cat']);
    await u.ben.call('DELETE', `/blocks/${u.ana.id}`);
  });

  it('a DM is titled with the sender\'s name and shows the text itself', async () => {
    const dm = await u.cat.call('POST', `/dm/${u.dan.id}`);
    expect(dm.statusCode, dm.body).toBe(200);
    const { chatId } = dm.json();
    await sql`update chat_members set request_status = 'accepted' where chat_id = ${chatId}`;
    fcmRequest.mockClear();
    expect((await u.cat.call('POST', `/chats/${chatId}/messages`, { body: 'Coffee tomorrow?' })).statusCode).toBe(200);
    await pushedTo('dan');
    expect(sent()[0]).toMatchObject({ title: 'cat', body: 'Coffee tomorrow?', chatId, tag: chatId });
  });
});

describe('push on a join', () => {
  it('the host hears "<name> joined your plan", with the plan title, opening its chat', async () => {
    const plan = await createPlan(u.host, { title: 'Temple run' });
    fcmRequest.mockClear();
    expect((await u.dan.call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
    await pushedTo('host');
    expect(sent()[0]).toMatchObject({ title: 'dan joined your plan 🎉', body: 'Temple run', chatId: plan.chatId });
  });
});

describe('tokens FCM refuses', () => {
  it('UNREGISTERED or a 404 deletes that token only; any other FCM error keeps it, and the message is still sent', async () => {
    const plan = await createPlan(u.host, { title: 'Gone tokens' });
    await joinAll(plan, ['ana', 'ben', 'cat']);
    fcmRequest.mockImplementation(async (o: any) => {
      const t = o.data.message.token;
      if (t === tokenOf('ana')) throw Object.assign(new Error('gone'), { response: { status: 404, data: { error: { details: [{ errorCode: 'UNREGISTERED' }] } } } });
      if (t === tokenOf('ben')) throw Object.assign(new Error('not found'), { response: { status: 404, data: {} } });
      if (t === tokenOf('cat')) throw Object.assign(new Error('quota'), { response: { status: 429, data: { error: { details: [{ errorCode: 'QUOTA_EXCEEDED' }] } } } });
      return { data: {} };
    });
    const r = await u.host.call('POST', `/chats/${plan.chatId}/messages`, { body: 'Meet at the gate' });
    expect(r.statusCode).toBe(200);
    await pushedTo('ana', 'ben', 'cat');
    await vi.waitFor(async () => {
      const left = (await sql`select token from push_tokens where token like 'fcm-token-for-%' and token in ${sql([tokenOf('ana'), tokenOf('ben'), tokenOf('cat')])}`).map(x => x.token);
      expect(left).toEqual([tokenOf('cat')]);
    }, { timeout: 3000, interval: 50 });
    // Each deleted token leaves one push_token_gone event on its owner (so ops can tell "uninstalled" from "never had one");
    // the token FCM only throttled leaves none.
    await vi.waitFor(async () => {
      const ev = await sql`select user_id, properties from analytics_events where event_name = 'push_token_gone'
        and user_id in ${sql([u.ana.id, u.ben.id, u.cat.id])} and created_at > now() - interval '1 minute'`;
      expect(ev.map(e => [e.userId, e.properties.platform]).sort()).toEqual([[u.ana.id, 'android'], [u.ben.id, 'android']].sort());
    }, { timeout: 3000, interval: 50 });
    const stored = await sql`select count(*)::int as n from messages where chat_id = ${plan.chatId} and body = 'Meet at the gate'`;
    expect(stored[0].n).toBe(1);
    // Put the two back for any later test.
    for (const n of ['ana', 'ben']) await u[n].call('POST', '/me/push-token', { token: tokenOf(n), platform: 'android' });
  });
});

describe('/me/push-token', () => {
  it('a phone that signs in to another account moves its token there (one phone, one owner)', async () => {
    expect((await u.dan.call('POST', '/me/push-token', { token: 'one-phone-two-accounts-0001', platform: 'android' })).statusCode).toBe(200);
    expect((await u.cat.call('POST', '/me/push-token', { token: 'one-phone-two-accounts-0001', platform: 'android' })).statusCode).toBe(200);
    const rows = await sql`select user_id from push_tokens where token = 'one-phone-two-accounts-0001'`;
    expect(rows.map(r => r.userId)).toEqual([u.cat.id]);
  });

  it('needs a signed-in user; refuses an unknown platform and a token too short to be real', async () => {
    expect((await app.inject({ method: 'POST', url: '/me/push-token', payload: { token: 'x'.repeat(20), platform: 'android' } })).statusCode).toBe(401);
    expect((await u.ana.call('POST', '/me/push-token', { token: 'x'.repeat(20), platform: 'windows' })).statusCode).toBe(400);
    expect((await u.ana.call('POST', '/me/push-token', { token: 'short', platform: 'android' })).statusCode).toBe(400);
  });
});
