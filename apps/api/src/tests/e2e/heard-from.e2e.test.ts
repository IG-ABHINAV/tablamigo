// Journey: three new travellers sign up and onboard; in the "How did you hear about us?" step Ava taps Instagram, Ben taps
// "A friend or an invite link" and Cy skips. The owner opens the admin panel: the Users list and each drawer say what they
// answered, and the Activation Funnel counts sign-ups per answer (with how far each group got). Real routes, signed in.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@heard-e2e.tablamigo';
process.env.REVIEW_EMAILS = ['boss', 'ava', 'ben', 'cy'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '626262';
process.env.ADMIN_EMAILS = `boss${D}`;
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { signIn, onboard, createPlan, inHours } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let boss: Person, ava: Person, ben: Person, cy: Person;
const cleanup = () => sql`delete from users where email like ${'%' + D}`;

beforeAll(async () => {
  app = await build();
  config.adminEmails = [`boss${D}`];
  await cleanup();
  boss = await onboard(await signIn(app, 'boss' + D, '626262', 92), { name: 'Boss', gender: 'woman' });
  // An account from before the step: never asked.
  await sql`update users set heard_from = null where id = ${boss.id}`;
});
afterAll(async () => { await cleanup(); await app.close(); await sql.end(); });

describe('how did you hear about us, from onboarding to the admin panel', () => {
  it('three travellers answer during onboarding (one skips), and onboarding completes for all', async () => {
    ava = await signIn(app, 'ava' + D, '626262', 92);
    ben = await signIn(app, 'ben' + D, '626262', 92);
    cy = await signIn(app, 'cy' + D, '626262', 92);
    // The app's order: profile saved at the interests step, then this step, then location.
    ava = await onboard(ava, { name: 'Ava', gender: 'woman' });
    ben = await onboard(ben, { name: 'Ben', gender: 'man' });
    cy = await onboard(cy, { name: 'Cy', gender: 'nonbinary' });
    expect((await ava.call('POST', '/me/heard-from', { source: 'instagram' })).statusCode).toBe(200);
    expect((await ben.call('POST', '/me/heard-from', { source: 'friend' })).statusCode).toBe(200);
    expect((await cy.call('POST', '/me/heard-from', { source: 'skipped' })).statusCode).toBe(200);
    for (const p of [ava, ben, cy]) expect((await p.call('GET', '/me')).json().onboarded).toBe(true);
  });

  it('Ben joins Ava\'s plan, so the funnel shows how far each answer got', async () => {
    const plan = await createPlan(ava, { startsAt: inHours(30) });
    const r = await ben.call('POST', `/activities/${plan.id}/join`);
    expect([200, 201]).toContain(r.statusCode);
  });

  it('the Users list and the drawer show each answer; the never-asked account shows none', async () => {
    const list = (await boss.call('GET', `/admin/users?q=${encodeURIComponent(D)}&limit=10`)).json();
    const by = Object.fromEntries(list.users.map((u: any) => [u.email.split('@')[0], u.heardFrom]));
    expect(by).toEqual({ boss: null, ava: 'instagram', ben: 'friend', cy: 'skipped' });
    const drawer = (await boss.call('GET', `/admin/users/${ben.id}`)).json();
    expect(drawer.user.heardFrom).toBe('friend');
    expect(drawer.user.heardFromAt).toBeTruthy();
  });

  it('the Activation Funnel breaks sign-ups down by answer', async () => {
    const r = (await boss.call('GET', '/admin/analytics/funnel?days=1')).json();
    const row = (s: string) => r.heardFrom.find((h: any) => h.source === s);
    expect(row('instagram').signups).toBeGreaterThanOrEqual(1);
    expect(row('friend').joinedPlan).toBeGreaterThanOrEqual(1);
    expect(row('skipped').signups).toBeGreaterThanOrEqual(1);
    expect(row('not_asked').signups).toBeGreaterThanOrEqual(1);
    for (const h of r.heardFrom) expect(h.onboarded).toBeLessThanOrEqual(h.signups);
  });

  it('a traveller cannot read the admin breakdown', async () => {
    expect((await ava.call('GET', '/admin/analytics/funnel?days=1')).statusCode).toBe(403);
  });
});
