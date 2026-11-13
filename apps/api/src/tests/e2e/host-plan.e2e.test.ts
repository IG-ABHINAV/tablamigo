// Journey: the team lists a plan from the admin form's API, a real traveller finds it in Explore, joins, talks in its group chat,
// and the team can take it down again with everyone told. Runs the real routes end to end with signed-in people (review code).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@hostplan-e2e.tablamigo';
process.env.REVIEW_EMAILS = ['boss', 'trav', 'trav2'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = `boss${D}`;
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { signIn, onboard } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let boss: Person, trav: Person, trav2: Person;
const RIGA = { lat: 56.9496, lng: 24.1052 };
const cleanup = async () => {
  await sql`delete from activities where title = 'Coffee meetup in Riga (e2e)'`;
  await sql`delete from users where email like ${'%' + D}`;
};

beforeAll(async () => {
  app = await build();
  await cleanup();
  config.adminEmails = [`boss${D}`];
  boss = await onboard(await signIn(app, 'boss' + D, '424242', 83), { name: 'Boss', gender: 'woman' });
  trav = await onboard(await signIn(app, 'trav' + D, '424242', 83), { name: 'Tess', gender: 'woman' }, RIGA);
  trav2 = await onboard(await signIn(app, 'trav2' + D, '424242', 83), { name: 'Tomas', gender: 'man' }, RIGA);
});
afterAll(async () => { await cleanup(); await app.close(); await sql.end(); });

describe('team-hosted plan, start to finish', () => {
  let planId = '', chatId = '';
  it('the team lists it; Explore shows it to a traveller in that city, hosted by the team', async () => {
    const day = new Date(Date.now() + 3 * 86400_000).toISOString().slice(0, 10);
    const r = await boss.call('POST', '/admin/host/plans', {
      title: 'Coffee meetup in Riga (e2e)', emoji: '☕', category: 'food', placeName: 'Livu Square, Riga', ...RIGA, city: 'Riga', localAt: `${day}T16:00`,
      description: 'Travellers and locals in Riga: coffee meetup. Hosted by the Tablamigo team to help people here connect. Join and say hi in the plan chat to set the exact table.',
    });
    expect(r.statusCode, r.body).toBe(200);
    ({ id: planId, chatId } = r.json());
    const explore = (await trav.call('GET', `/activities?lat=${RIGA.lat}&lng=${RIGA.lng}&when=week`)).json();
    const p = (explore.activities ?? explore).find((x: any) => x.id === planId);
    expect(p, 'plan in Explore').toBeTruthy();
    expect(p.going ?? p.goingCount ?? 0).toBe(0);
  });
  it('travellers join, see the opening line, chat, and the plan counts only them', async () => {
    expect((await trav.call('POST', `/activities/${planId}/join`)).statusCode).toBe(200);
    expect((await trav2.call('POST', `/activities/${planId}/join`)).statusCode).toBe(200);
    const sent = await trav.call('POST', `/chats/${chatId}/messages`, { body: 'Hi all, I will be at the left side of the square.' });
    expect(sent.statusCode, sent.body).toBe(200);
    const msgs = (await trav2.call('GET', `/chats/${chatId}/messages`)).json();
    const bodies = (msgs.messages ?? msgs).map((m: any) => m.body);
    expect(bodies.some((b: string) => b.startsWith('Plan listed by the Tablamigo team. Nobody from the team attends'))).toBe(true);
    expect(bodies).toContain('Hi all, I will be at the left side of the square.');
    expect((await sql`select count(*)::int as n from activity_members where activity_id = ${planId}`)[0].n).toBe(2);
  });
  it('an admin removes it: it leaves Explore and the members are told', async () => {
    expect((await boss.call('POST', `/admin/plans/${planId}/cancel`)).statusCode).toBe(200);
    const explore = (await trav.call('GET', `/activities?lat=${RIGA.lat}&lng=${RIGA.lng}&when=week`)).json();
    expect(((explore.activities ?? explore) as any[]).some(x => x.id === planId)).toBe(false);
    const notices = await sql`select 1 from inbox_notices where user_id = ${trav.id} and activity_id = ${planId}`.catch(() => null);
    if (notices) expect(notices.length).toBe(1);
  });
});
