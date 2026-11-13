// Concurrency on the last seats of a plan (the join takes a row lock on the plan), double taps, and group-chat polls
// (2 to 6 options, vote, change vote, counts) from both sides of the membership line.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@race.tablamigo';
const NAMES = ['host', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'out', 'dmx'];
process.env.REVIEW_EMAILS = NAMES.map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { signIn, onboard, createPlan, BKK } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
const u: Record<string, Person> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  for (const n of NAMES) u[n] = await onboard(await signIn(app, n + D, '424242', 74), { name: n, gender: 'woman' }, BKK);
  // Plus for everyone: the free 2-plans-a-day and DM limits are not what these tests are about.
  await sql`update users set comp_until = now() + interval '1 day', plus_until = now() + interval '1 day' where email like ${'%' + D}`;
});
afterAll(async () => { await sql`delete from users where email like ${'%' + D}`; await app.close(); await sql.end(); });

describe('joining a plan at the same moment', () => {
  // Until 22 Oct 2026 six simultaneous joins on a plan with maxPeople 3 ended with 7 people "going": the join read the going
  // count in the same statement as `for update of a`, and under READ COMMITTED that count came from the snapshot taken before
  // the lock wait. routes/activities.ts now counts in a second statement once the lock is held (goingCount).
  it('six people tap Join on the last two seats at once: exactly two get in, four are told it is full', async () => {
    const plan = await createPlan(u.host, { maxPeople: 3, title: 'Race for seats' });
    const people = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];
    const results = await Promise.all(people.map(p => u[p].call('POST', `/activities/${plan.id}/join`)));
    const codes = results.map(r => (r.statusCode === 200 ? 'in' : r.json().error));
    expect(codes.filter(c => c === 'in')).toHaveLength(2);
    expect(codes.filter(c => c === 'full')).toHaveLength(4);
    const [{ going }] = await sql`select count(*)::int as going from activity_members where activity_id = ${plan.id} and rsvp_status = 'going'`;
    expect(going).toBe(3);
    const [{ members }] = await sql`select count(*)::int as members from chat_members where chat_id = ${plan.chatId}`;
    expect(members).toBe(3);
  });

  it('a double tap on Join adds one membership and one "joined" line', async () => {
    const plan = await createPlan(u.host, { maxPeople: 10, title: 'Double tap' });
    const rs = await Promise.all([1, 2, 3].map(() => u.p1.call('POST', `/activities/${plan.id}/join`)));
    expect(rs.every(r => r.statusCode === 200)).toBe(true);
    expect((await sql`select count(*)::int as n from activity_members where activity_id = ${plan.id} and user_id = ${u.p1.id}`)[0].n).toBe(1);
    const sys = await sql`select body from messages where chat_id = ${plan.chatId} and kind = 'system'`;
    expect(sys.filter(m => /p1/.test(m.body))).toHaveLength(1);
  });

  it('a repeat tap on Join by someone who took the last seat keeps their seat (it used to move them to the waitlist)', async () => {
    const plan = await createPlan(u.host, { maxPeople: 2, title: 'Last seat, tapped twice' });
    expect((await u.p1.call('POST', `/activities/${plan.id}/join`)).json()).toMatchObject({ rsvpStatus: 'going' });
    expect((await u.p2.call('POST', `/activities/${plan.id}/join`, { rsvp: 'waitlist' })).json()).toMatchObject({ rsvpStatus: 'waitlist' });
    const again = await u.p1.call('POST', `/activities/${plan.id}/join`);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ rsvpStatus: 'going', waitlisted: false });
    const rows = await sql`select u.email, m.rsvp_status from activity_members m join users u on u.id = m.user_id where m.activity_id = ${plan.id} order by u.email`;
    expect(rows.map(r => [r.email.split('@')[0], r.rsvpStatus])).toEqual([['host', 'going'], ['p1', 'going'], ['p2', 'waitlist']]);
  });

  it('a seat freed by someone leaving can be taken again', async () => {
    const plan = await createPlan(u.host, { maxPeople: 2, title: 'One seat' });
    expect((await u.p2.call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
    expect((await u.p3.call('POST', `/activities/${plan.id}/join`)).json().error).toBe('full');
    expect((await u.p2.call('POST', `/activities/${plan.id}/leave`)).statusCode).toBe(200);
    expect((await u.p3.call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
  });

  // Until 22 Oct 2026 the leave deleted the seat and promoted the first waitlisted person in separate statements, with no lock
  // on the plan: a Join landing between the two took the freed seat, and the promotion then put the plan one over.
  it('someone leaves a full plan with a waitlist while someone else taps Join: the seat goes to the waitlist, never one over', async () => {
    for (let round = 0; round < 5; round++) {
      const plan = await createPlan(u.host, { maxPeople: 3, title: `Leave and join ${round}` });
      for (const p of ['p1', 'p2']) expect((await u[p].call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
      expect((await u.p3.call('POST', `/activities/${plan.id}/join`, { rsvp: 'waitlist' })).json()).toMatchObject({ rsvpStatus: 'waitlist' });
      const [left, joined] = await Promise.all([
        u.p1.call('POST', `/activities/${plan.id}/leave`),
        u.p4.call('POST', `/activities/${plan.id}/join`),
      ]);
      expect(left.statusCode).toBe(200);
      expect(joined.json().error, `round ${round}`).toBe('full');
      const going = await sql`select u.email from activity_members m join users u on u.id = m.user_id
        where m.activity_id = ${plan.id} and m.rsvp_status = 'going'`;
      expect(going.map(r => r.email.split('@')[0]).sort(), `round ${round}`).toEqual(['host', 'p2', 'p3']);
    }
  });
});

describe('polls in a group chat', () => {
  let chatId: string;
  beforeAll(async () => {
    const plan = await createPlan(u.host, { maxPeople: 10, title: 'Poll night' });
    chatId = plan.chatId;
    for (const p of ['p4', 'p5']) expect((await u[p].call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
  });
  const poll = (p: Person, body: unknown) => p.call('POST', `/chats/${chatId}/polls`, body);

  it('2 to 6 distinct options', async () => {
    expect((await poll(u.host, { question: 'Where?', options: ['Only one'] })).statusCode).toBe(400);
    expect((await poll(u.host, { question: 'Where?', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] })).statusCode).toBe(400);
    expect((await poll(u.host, { question: 'Where?', options: ['Bar', 'bar'] })).statusCode).toBe(400);
    expect((await poll(u.host, { question: '', options: ['a', 'b'] })).statusCode).toBe(400);
    expect((await poll(u.host, { question: 'Where?', options: ['a', 'b', 'c', 'd', 'e', 'f'] })).statusCode).toBe(200);
  });

  it('vote, change the vote, counts follow; out-of-range votes refused', async () => {
    const created = (await poll(u.host, { question: 'Dinner time?', options: ['7 pm', '8 pm', '9 pm'] })).json();
    const pid = created.id as string;
    expect(created.poll).toEqual({ question: 'Dinner time?', options: ['7 pm', '8 pm', '9 pm'], counts: [0, 0, 0], myVote: null });
    const vote = (p: Person, option: number) => p.call('POST', `/chats/${chatId}/polls/${pid}/vote`, { option });
    expect((await vote(u.p4, 0)).json().poll.counts).toEqual([1, 0, 0]);
    expect((await vote(u.p5, 0)).json().poll.counts).toEqual([2, 0, 0]);
    const changed = (await vote(u.p4, 2)).json().poll;
    expect(changed.counts).toEqual([1, 0, 1]);
    expect(changed.myVote).toBe(2);
    expect((await vote(u.p5, 3)).statusCode).toBe(400);
    expect((await vote(u.p5, -1)).statusCode).toBe(400);
    const msgs = (await u.p5.call('GET', `/chats/${chatId}/messages`)).json().messages;
    expect(msgs.find((m: any) => m.id === pid).poll).toMatchObject({ counts: [1, 0, 1], myVote: 0 });
  });

  it('only members create or vote; polls are not for DMs', async () => {
    const pid = (await poll(u.host, { question: 'Members only?', options: ['yes', 'no'] })).json().id;
    expect((await poll(u.out, { question: 'Sneaky?', options: ['yes', 'no'] })).statusCode).toBe(403);
    expect((await u.out.call('POST', `/chats/${chatId}/polls/${pid}/vote`, { option: 0 })).statusCode).toBe(403);
    const dm = (await u.dmx.call('POST', `/dm/${u.out.id}`)).json().chatId;
    expect((await u.dmx.call('POST', `/chats/${dm}/polls`, { question: 'Hi?', options: ['a', 'b'] })).json().error).toBe('group_only');
  });

  it('a vote on a deleted poll is a 404', async () => {
    const pid = (await poll(u.host, { question: 'Delete me?', options: ['a', 'b'] })).json().id;
    expect((await u.host.call('DELETE', `/chats/${chatId}/messages/${pid}`)).statusCode).toBe(200);
    expect((await u.p4.call('POST', `/chats/${chatId}/polls/${pid}/vote`, { option: 0 })).statusCode).toBe(404);
  });
});
