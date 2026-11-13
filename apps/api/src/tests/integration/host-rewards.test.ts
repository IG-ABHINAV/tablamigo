// Host rewards (lib/host-rewards.ts): a real traveller who hosted a plan that 2+ real travellers went to gets 7 days of Plus, once
// per plan, at most 2 per 30 days. Guests that can't count (the host's own invitees, accounts made after the plan, demo/test
// accounts, maybe/waitlist) don't; cancelled, too-recent and too-old plans don't; dry and off write nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const D = '@hostreward.tablamigo';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { issueTokens } = await import('../../lib/auth.js');
const { processHostRewards, rewardablePlans, HOST_REWARD } = await import('../../lib/host-rewards.js');

let app: Awaited<ReturnType<typeof build>>;
const HOUR = 3600_000, DAY = 24 * HOUR;
const T0 = new Date('2038-03-10T12:00:00Z');   // plans in a year no other test file uses

async function person(local: string, o: { email?: string; createdAt?: Date; referredBy?: string } = {}) {
  const [u] = await sql`insert into users (email, name, onboarded, created_at, referred_by, birthdate, gender)
    values (${o.email ?? local + D}, ${local}, true, ${o.createdAt ?? new Date(T0.getTime() - 60 * DAY)}, ${o.referredBy ?? null}, '1993-04-05', 'woman') returning id`;
  return u.id as string;
}
async function plan(hostId: string, startsAt: Date, guests: string[], o: { status?: string; rsvp?: string; createdAt?: Date; checkedIn?: boolean } = {}) {
  const [a] = await sql`insert into activities (host_id, title, category, place_name, city, location, starts_at, status, created_at)
    values (${hostId}, 'Sunset walk', 'outdoors', 'Chowpatty', 'Mumbai', st_setsrid(st_makepoint(72.81, 18.95), 4326)::geography, ${startsAt},
      ${o.status ?? 'active'}, ${o.createdAt ?? new Date(startsAt.getTime() - 2 * DAY)}) returning id`;
  await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${a.id}, ${hostId}, 'going')`;
  const at = o.checkedIn === false ? null : new Date(startsAt.getTime() + 10 * 60_000);
  for (const g of guests) await sql`insert into activity_members (activity_id, user_id, rsvp_status, checked_in_at) values (${a.id}, ${g}, ${o.rsvp ?? 'going'}, ${at})`;
  return a.id as string;
}
const plusDays = async (id: string, at = Date.now()) => {
  const [u] = await sql`select comp_until from users where id = ${id}`;
  return u.compUntil ? Math.round((new Date(u.compUntil).getTime() - at) / DAY) : 0;
};

let host: string, g1: string, g2: string, g3: string;
beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D} or email like ${'%@demo.tablamigo'} and name like 'hr-%'`;
  host = await person('host'); g1 = await person('ana'); g2 = await person('bo'); g3 = await person('cy');
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D} or (email like '%@demo.tablamigo' and name like 'hr-%')`;
  await app.close();
});

describe('who qualifies', () => {
  it('2 real guests who checked in: yes. 1 guest: no', async () => {
    const yes = await plan(host, new Date(T0.getTime() - 5 * HOUR), [g1, g2]);
    const one = await plan(host, new Date(T0.getTime() - 5 * HOUR), [g1]);
    const ids = (await rewardablePlans(T0, host)).map(p => p.id);
    expect(ids).toContain(yes);
    expect(ids).not.toContain(one);
    await sql`delete from activities where id in (${yes}, ${one})`;
  });

  it('guests that cannot count: the host\'s invitees, accounts newer than the plan, demo/test addresses, maybe, and going without a check-in', async () => {
    const start = new Date(T0.getTime() - 5 * HOUR);
    const invited = await person('inv', { referredBy: host });
    const late = await person('late', { createdAt: new Date(start.getTime() - 1 * HOUR) });   // after the plan was posted (start - 2 days)
    const demo = await person('hr-demo', { email: `hr-demo-${Date.now()}@demo.tablamigo` });
    const tst = await person('tst', { email: `tst-${Date.now()}@qa.test` });
    const ids: string[] = [];
    for (const pair of [[g1, invited], [g1, late], [g1, demo], [g1, tst]]) ids.push(await plan(host, start, pair));
    const maybe = await plan(host, start, [g1, g2], { rsvp: 'maybe' });
    const rsvpOnly = await plan(host, start, [g1, g2], { checkedIn: false });   // going, but nobody checked in at the place
    const found = (await rewardablePlans(T0, host)).map(p => p.id);
    for (const id of [...ids, maybe, rsvpOnly]) expect(found).not.toContain(id);
    await sql`delete from activities where id = any(${[...ids, maybe, rsvpOnly]}::uuid[])`;
  });

  it('cancelled, not yet over (under 2 h since the start) and older than 7 days: no', async () => {
    const cancelled = await plan(host, new Date(T0.getTime() - 5 * HOUR), [g1, g2], { status: 'cancelled' });
    const recent = await plan(host, new Date(T0.getTime() - 1 * HOUR), [g1, g2]);
    const old = await plan(host, new Date(T0.getTime() - (HOST_REWARD.lookbackDays + 1) * DAY), [g1, g2]);
    const found = (await rewardablePlans(T0, host)).map(p => p.id);
    for (const id of [cancelled, recent, old]) expect(found).not.toContain(id);
    await sql`delete from activities where id in (${cancelled}, ${recent}, ${old})`;
  });

  it('a demo or team host is never rewarded', async () => {
    const demoHost = await person('hr-dh', { email: `hr-dh-${Date.now()}@demo.tablamigo` });
    const id = await plan(demoHost, new Date(T0.getTime() - 5 * HOUR), [g1, g2]);
    expect((await rewardablePlans(T0, demoHost)).length).toBe(0);
    await sql`delete from activities where id = ${id}`;
  });
});

describe('granting', () => {
  it('dry and off write nothing', async () => {
    const id = await plan(host, new Date(T0.getTime() - 5 * HOUR), [g1, g2]);
    expect((await processHostRewards(T0, { mode: 'off', hostId: host })).granted).toBe(0);
    const dry = await processHostRewards(T0, { mode: 'dry', hostId: host, dryLog: new Set() });
    expect(dry.planned).toBe(1);
    expect((await sql`select count(*)::int as n from host_rewards where activity_id = ${id}`)[0].n).toBe(0);
    expect(await plusDays(host)).toBe(0);
    await sql`delete from activities where id = ${id}`;
  });

  it('on: 7 days of Plus, a notice and an event, once per plan; then capped at 2 per 30 days', async () => {
    const a = await plan(host, new Date(T0.getTime() - 5 * HOUR), [g1, g2, g3]);
    const r1 = await processHostRewards(T0, { mode: 'on', hostId: host });
    expect(r1).toMatchObject({ granted: 1, capped: 0, failed: 0 });
    expect(await plusDays(host)).toBe(HOST_REWARD.days);
    const [row] = await sql`select guests, days, status from host_rewards where activity_id = ${a}`;
    expect(row).toEqual({ guests: 3, days: HOST_REWARD.days, status: 'granted' });
    const [note] = await sql`select body, activity_id from notifications where user_id = ${host} and kind = 'plus'`;
    expect(note.body).toContain('3 travelers checked in');
    expect(note.activityId).toBe(a);
    expect((await sql`select count(*)::int as n from analytics_events where user_id = ${host} and event_name = 'host_reward'`)[0].n).toBe(1);
    const [u] = await sql`select plus_until from users where id = ${host}`;
    expect(new Date(u.plusUntil).getTime()).toBeGreaterThan(Date.now() + 6 * DAY);   // recomputed from comp_until

    // Running again does nothing for the same plan.
    expect((await processHostRewards(T0, { mode: 'on', hostId: host })).granted).toBe(0);

    const b = await plan(host, new Date(T0.getTime() - 4 * HOUR), [g1, g2]);
    const c = await plan(host, new Date(T0.getTime() - 3 * HOUR), [g2, g3]);
    const r2 = await processHostRewards(T0, { mode: 'on', hostId: host });
    expect(r2).toMatchObject({ granted: 1, capped: 1 });
    expect(await plusDays(host)).toBe(2 * HOST_REWARD.days);
    const statuses = (await sql`select status from host_rewards where activity_id in (${b}, ${c}) order by status`).map(x => x.status);
    expect(statuses).toEqual(['capped', 'granted']);
  });

  it('GET /me/host-rewards: the rule\'s numbers and what the host earned', async () => {
    const { accessToken } = await issueTokens(host);
    const r = await app.inject({ method: 'GET', url: '/me/host-rewards', headers: { authorization: `Bearer ${accessToken}` } });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ days: HOST_REWARD.days, minGuests: HOST_REWARD.minGuests, maxPerWindow: HOST_REWARD.maxPerWindow, rewarded: 2, daysEarned: 2 * HOST_REWARD.days });
    expect((await app.inject({ method: 'GET', url: '/me/host-rewards' })).statusCode).toBe(401);
  });

  it('the days stack on earlier free days, not on a paid period (a refund must not leave Plus behind)', async () => {
    const paid = await person('paid');
    await sql`update users set plus_until = now() + interval '20 days' where id = ${paid}`;   // as if a pass were live
    await plan(paid, new Date(T0.getTime() - 5 * HOUR), [g1, g2]);
    expect((await processHostRewards(T0, { mode: 'on', hostId: paid })).granted).toBe(1);
    expect(await plusDays(paid)).toBe(HOST_REWARD.days);
  });

  it('two runs at once grant one reward for a plan', async () => {
    const other = await person('host2');
    await plan(other, new Date(T0.getTime() - 5 * HOUR), [g1, g2]);
    const rs = await Promise.all([1, 2, 3].map(() => processHostRewards(T0, { mode: 'on', hostId: other })));
    expect(rs.reduce((n, r) => n + r.granted, 0)).toBe(1);
    expect(await plusDays(other)).toBe(HOST_REWARD.days);
  });
});
