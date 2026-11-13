// Journey: Priya posts a plan, two travellers join it and check in at the meeting point through the app's routes, and the scheduler's host-reward
// pass gives Priya Plus: GET /me says Plus, her inbox thanks her, GET /me/host-rewards counts it, and the Plus-only who-viewed list
// opens for her. A second pass the same day changes nothing.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@hostreward-e2e.tablamigo';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { issueTokens } = await import('../../lib/auth.js');
const { processHostRewards, HOST_REWARD } = await import('../../lib/host-rewards.js');
const { onboard, createPlan, freshIp, inHours, BKK } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let priya: Person, ravi: Person, sam: Person;
const cleanup = () => sql`delete from users where email like ${'%' + D}`;

/** A real traveller (not a review account, which never counts): created directly, real tokens, onboarded through PATCH /me. */
async function traveller(local: string, name: string): Promise<Person> {
  const email = local + D;
  const [u] = await sql`insert into users (email) values (${email}) returning id`;
  const { accessToken: token, refreshToken } = await issueTokens(u.id);
  const ip = freshIp(85);
  const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress: ip });
  return onboard({ call, id: u.id, token, refreshToken, email, ip }, { name, gender: 'woman' }, BKK);
}

beforeAll(async () => {
  app = await build();
  await cleanup();
  ravi = await traveller('ravi', 'Ravi');
  sam = await traveller('sam', 'Sam');
  await sql`update users set created_at = now() - interval '1 day' where id in (${ravi.id}, ${sam.id})`;
  priya = await traveller('priya', 'Priya');
});
afterAll(async () => { await cleanup(); await app.close(); await sql.end(); });

describe('host a plan, get Plus', () => {
  let planId = '', startsAt = '';
  it('Priya is not on Plus and posts a plan; two travellers join, one checks in, then the other', async () => {
    expect((await priya.call('GET', '/me')).json().plus).toBe(false);
    startsAt = inHours(0.1);   // inside the check-in window (from 30 min before the start)
    ({ id: planId } = await createPlan(priya, { title: 'Street food walk (host e2e)', startsAt }));
    for (const g of [ravi, sam]) expect((await g.call('POST', `/activities/${planId}/join`)).statusCode).toBe(200);
    // Far from the meeting point: refused, and it doesn't count.
    expect((await ravi.call('POST', `/activities/${planId}/checkin`, { lat: BKK.lat + 0.05, lng: BKK.lng })).statusCode).toBe(400);
    expect((await ravi.call('POST', `/activities/${planId}/checkin`, BKK)).statusCode).toBe(200);
    const after = new Date(Date.parse(startsAt) + (HOST_REWARD.afterStartHours + 1) * 3600_000);
    expect((await processHostRewards(after, { mode: 'on', hostId: priya.id })).granted).toBe(0);   // only 1 checked in so far
    expect((await sam.call('POST', `/activities/${planId}/checkin`, BKK)).statusCode).toBe(200);
  });

  it('the plan happens; the reward pass gives her Plus and tells her', async () => {
    const after = new Date(Date.parse(startsAt) + (HOST_REWARD.afterStartHours + 1) * 3600_000);
    // Before it is over, nothing.
    expect((await processHostRewards(new Date(Date.parse(startsAt) + 3600_000), { mode: 'on', hostId: priya.id })).granted).toBe(0);
    expect((await processHostRewards(after, { mode: 'on', hostId: priya.id })).granted).toBe(1);
    expect((await priya.call('GET', '/me')).json().plus).toBe(true);
    const inbox = JSON.stringify((await priya.call('GET', '/inbox')).json());
    expect(inbox).toContain('Thanks for hosting');
    expect(inbox).toContain('2 travelers checked in');
    expect(inbox).toContain(`${HOST_REWARD.days} days of Tablamigo Plus`);
    expect((await priya.call('GET', '/me/host-rewards')).json()).toMatchObject({ rewarded: 1, daysEarned: HOST_REWARD.days });
    // A Plus-only screen opens for her now.
    expect((await priya.call('GET', '/me/viewers')).json().locked).toBe(false);
    expect((await ravi.call('GET', '/me/viewers')).json().locked).toBe(true);
    // The guests got nothing and were not told.
    expect((await ravi.call('GET', '/me')).json().plus).toBe(false);
  });

  it('a second pass changes nothing', async () => {
    const after = new Date(Date.parse(startsAt) + 4 * 3600_000);
    expect((await processHostRewards(after, { mode: 'on', hostId: priya.id })).granted).toBe(0);
    expect((await priya.call('GET', '/me/host-rewards')).json().rewarded).toBe(1);
  });
});
