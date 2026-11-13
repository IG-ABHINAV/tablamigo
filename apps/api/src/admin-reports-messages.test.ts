// GET /admin/reports shows the text of a reported message so an admin can judge the report. That text is read from the message
// the report is about and nothing else, and a message that was deleted (by its sender, or with their account) is shown as deleted
// instead of looking like live content.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Response as InjectResponse } from 'light-my-request';

const D = '@adminrep.tablamigo';
const PEOPLE = ['boss', 'rae', 'sam'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'boss' + D;
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<InjectResponse>;
const u: Record<string, { call: Api; id: string }> = {};
let chatId = '';
let ip = 0;

async function login(name: string) {
  const email = name + D, remoteAddress = `10.92.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const token = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress });
  u[name] = { call, id: (await call('GET', '/me')).json().id };
}
const say = async (who: string, body: string) => (await u[who].call('POST', `/chats/${chatId}/messages`, { body })).json().id as string;
const report = async (targetType: string, targetId: string) => {
  const r = await u.rae.call('POST', '/reports', { targetType, targetId, reason: 'harassment', details: 'see the message' });
  expect(r.statusCode).toBe(200);
};
const reports = async () => (await u.boss.call('GET', '/admin/reports?status=all')).json().reports as any[];

beforeAll(async () => {
  app = await build();
  setMailTransport(async () => ({ id: 'test' }));
  await sql`delete from users where email like ${'%' + D}`;
  for (const p of PEOPLE) await login(p);
  const [a] = await sql`insert into activities (host_id, title, emoji, category, place_name, location, city, starts_at)
    values (${u.sam.id}, 'Reported plan', '🍜', 'food', 'Night market', ST_SetSRID(ST_MakePoint(100.5, 13.75), 4326)::geography, 'Bangkok', now() + interval '2 hours') returning id`;
  chatId = (await sql`insert into chats (kind, activity_id, title) values ('activity', ${a.id}, 'Reported plan') returning id`)[0].id;
  for (const p of ['rae', 'sam']) {
    await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${a.id}, ${u[p].id}, 'going')`;
    await sql`insert into chat_members (chat_id, user_id) values (${chatId}, ${u[p].id})`;
  }
  (u as any).planId = a.id;
});
afterAll(async () => {
  setMailTransport(null);
  await sql`delete from reports where reporter_id in (select id from users where email like ${'%' + D})`;
  await sql`delete from support_tickets where email like ${'%' + D}`;
  await sql`delete from users where email like ${'%' + D}`;
  await app.close();
  await sql.end();
});

describe('admin reports and message text', () => {
  it('an admin reads the reported text, and only the reported message\'s text; a message deleted by its sender is marked as deleted', async () => {
    const bad = await say('sam', 'the reported words');
    const other = await say('sam', 'an unreported message nobody complained about');
    await report('message', bad);
    await report('activity', (u as any).planId);

    let list = await reports();
    const mine = list.find(r => r.targetType === 'message' && r.targetId === bad)!;
    expect(mine.messageBody).toBe('the reported words');
    expect(mine.messageDeleted).toBe(false);
    expect(mine.messageDeletedAt).toBeNull();
    // Nothing else of the chat is in the response: not the other message, and a plan report carries no message text at all.
    expect(JSON.stringify(list)).not.toContain('an unreported message');
    const plan = list.find(r => r.targetType === 'activity')!;
    expect(plan).toMatchObject({ messageBody: null, messageDeleted: null, activityTitle: 'Reported plan' });

    // The sender deletes it: the admin can still read what was reported, marked as deleted.
    expect((await u.sam.call('DELETE', `/chats/${chatId}/messages/${bad}`)).statusCode).toBe(200);
    list = await reports();
    const after = list.find(r => r.targetId === bad)!;
    expect(after.messageBody).toBe('the reported words');
    expect(after.messageDeleted).toBe(true);
    expect(new Date(after.messageDeletedAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect(JSON.stringify(list)).not.toContain('an unreported message');
    expect(other).toBeTruthy();
  });

  it('a message removed with its sender\'s account shows what is left, marked as deleted; non-admins get nothing', async () => {
    const bad = await say('rae', 'words that go with the account');
    await u.sam.call('POST', '/reports', { targetType: 'message', targetId: bad, reason: 'spam' });
    expect((await u.rae.call('DELETE', '/me')).statusCode).toBe(200);
    const r = (await reports()).find(x => x.targetId === bad)!;
    expect(r.messageBody).toBe('[deleted]');
    expect(r.messageDeleted).toBe(true);
    expect((await u.sam.call('GET', '/admin/reports?status=all')).statusCode).toBe(403);
  });
});
