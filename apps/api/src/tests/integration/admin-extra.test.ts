// Admin endpoints no suite reached before: a user's journey, removing a plan, partner leads (and the public form that creates
// them). Plus the rule for all of them: a signed-in non-admin gets 403, and no sign-in gets 401. The AI engagement trigger
// (/admin/ai-engagement/run) acts on the whole database, so its admin run is tested in src/tests/e2e/ai-engagement.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@adminx.tablamigo';
process.env.REVIEW_EMAILS = ['boss', 'kai', 'lia', 'mo'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = `boss${D}`;
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { setMailTransport } = await import('../../lib/mail.js');
const { config } = await import('../../lib/config.js');
const { signIn, onboard, createPlan } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let boss: Person, kai: Person, lia: Person, mo: Person;
const mails: { to: string; subject: string; text: string; html: string; replyTo?: string }[] = [];
const LEAD_EMAIL = `cafe-owner${D}`;

beforeAll(async () => {
  app = await build();
  config.adminEmails = [`boss${D}`];
  setMailTransport(async m => { mails.push(m); return { id: 'test' }; });
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from partner_leads where email = ${LEAD_EMAIL}`;
  boss = await onboard(await signIn(app, 'boss' + D, '424242', 75), { name: 'Boss', gender: 'woman' });
  kai = await onboard(await signIn(app, 'kai' + D, '424242', 75), { name: 'Kai', gender: 'man' });
  lia = await onboard(await signIn(app, 'lia' + D, '424242', 75), { name: 'Lia', gender: 'woman' });
  mo = await onboard(await signIn(app, 'mo' + D, '424242', 75), { name: 'Mo', gender: 'man' });
  // Lia hosts more than the free 2 plans a day here.
  await sql`update users set comp_until = now() + interval '1 day', plus_until = now() + interval '1 day' where id = ${lia.id}`;
});
afterAll(async () => {
  setMailTransport(null);
  await sql`delete from users where email like ${'%' + D}`;
  await sql`delete from partner_leads where email = ${LEAD_EMAIL}`;
  await app.close(); await sql.end();
});

describe('who may use /admin/*', () => {
  const routes: [string, string, unknown?][] = [
    ['GET', '/admin/overview'], ['GET', '/admin/users'], ['GET', '/admin/plans'], ['GET', '/admin/partner-leads'],
    ['POST', '/admin/ai-engagement/run', {}], ['GET', '/admin/reports'], ['GET', '/admin/subscriptions'], ['GET', '/admin/revenue'],
    ['GET', '/admin/analytics/funnel'], ['GET', '/admin/starter-plans'],
  ];
  it.each(routes)('%s %s: 403 for a member, 401 signed out', async (method, url, body) => {
    expect((await kai.call(method, url, body)).statusCode).toBe(403);
    expect((await app.inject({ method: method as any, url, payload: body as any })).statusCode).toBe(401);
  });

  it('an ADMIN_EMAILS address is an admin', async () => {
    expect((await boss.call('GET', '/admin/me')).statusCode).toBe(200);
  });
});

describe('user journey', () => {
  it('shows what the person did, in time order, with a drop-off summary, and 404s an unknown id', async () => {
    const plan = await createPlan(lia, { title: 'Journey brunch' });
    expect((await kai.call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
    expect((await kai.call('POST', `/chats/${plan.chatId}/messages`, { body: 'see you there' })).statusCode).toBe(200);
    const r = await boss.call('GET', `/admin/users/${kai.id}/journey`);
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.user).toMatchObject({ id: kai.id, email: `kai${D}`, name: 'Kai' });
    expect(j.summary).toMatchObject({ dropoffStage: expect.any(String), recommendation: expect.any(String) });
    expect(j.summary.totalEvents).toBe(j.timeline.length);
    expect(j.timeline[0].type).toBe('signup');
    expect(JSON.stringify(j.timeline)).toContain('Journey brunch');
    expect(JSON.stringify(j.timeline)).toContain('see you there');
    const times = j.timeline.map((t: any) => new Date(t.time).getTime());
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect((await boss.call('GET', '/admin/users/00000000-0000-4000-8000-000000000000/journey')).statusCode).toBe(404);
    expect((await boss.call('GET', '/admin/users/not-a-uuid/journey')).statusCode).toBe(400);
  });
});

describe('removing a plan', () => {
  it('cancels it, says so in its chat, tells every member once, and a second removal is a 404', async () => {
    const plan = await createPlan(lia, { title: 'Removed by team' });
    for (const p of [kai, mo]) expect((await p.call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
    expect((await boss.call('POST', `/admin/plans/${plan.id}/cancel`, {})).json()).toEqual({ ok: true });
    expect((await sql`select status from activities where id = ${plan.id}`)[0].status).toBe('cancelled');
    const sys = await sql`select body from messages where chat_id = ${plan.chatId} and kind = 'system' order by created_at desc limit 1`;
    expect(sys[0].body).toBe('This plan was removed by the Tablamigo team.');
    const notices = await sql`select user_id, body from notifications where activity_id = ${plan.id} and kind = 'cancelled'`;
    expect(notices.map(n => n.userId).sort()).toEqual([lia.id, kai.id, mo.id].sort());
    expect(new Set(notices.map(n => n.body))).toEqual(new Set(['Removed by team was removed by the Tablamigo team']));
    expect((await boss.call('POST', `/admin/plans/${plan.id}/cancel`, {})).statusCode).toBe(404);
    expect((await kai.call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(404);
    // It no longer lists for anyone.
    const listed = (await boss.call('GET', '/admin/plans?status=active&when=all&q=Removed%20by%20team')).json().plans;
    expect(listed).toEqual([]);
  });

  it('a member cannot remove a plan through the admin route', async () => {
    const plan = await createPlan(lia, { title: 'Not yours' });
    expect((await kai.call('POST', `/admin/plans/${plan.id}/cancel`, {})).statusCode).toBe(403);
    expect((await sql`select status from activities where id = ${plan.id}`)[0].status).toBe('active');
  });
});

describe('partner leads', () => {
  const form = { businessName: 'Chai Point Goa', contactName: 'Asha Rao', email: LEAD_EMAIL, businessType: 'Cafe', city: 'Goa', message: 'We would like to host traveller meetups.' };

  it('the website form stores a lead, emails the team (reply-to the lead) and confirms to the sender', async () => {
    mails.length = 0;
    const r = await app.inject({ method: 'POST', url: '/partnerships', payload: form, remoteAddress: '10.75.200.1' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, leadId: expect.any(String) });
    await new Promise(res => setTimeout(res, 50));   // the emails are sent without awaiting
    expect(mails.find(m => m.to === `boss${D}`)).toMatchObject({ subject: 'New partner lead: Chai Point Goa (Goa)', replyTo: LEAD_EMAIL });
    const team = mails.find(m => m.to === `boss${D}`)!;
    for (const s of ['Business: Chai Point Goa', 'Contact: Asha Rao', `Email: ${LEAD_EMAIL}`, 'We would like to host traveller meetups.']) expect(team.text).toContain(s);
    expect(team.html).toContain('icon-192.png');   // the branded layout, not a <pre> dump
    expect(team.html).not.toContain('<pre');
    const conf = mails.find(m => m.to === LEAD_EMAIL)!;
    expect(conf.html).toContain('icon-192.png');
    expect(conf.text + conf.html).not.toContain('traveller meetups');   // none of the visitor's words go to the typed address
    expect(mails.find(m => m.to === LEAD_EMAIL)?.subject).toBe('We got your Tablamigo partnership enquiry');
  });

  it('the honeypot field stores nothing', async () => {
    const before = (await sql`select count(*)::int as n from partner_leads where email = ${LEAD_EMAIL}`)[0].n;
    const r = await app.inject({ method: 'POST', url: '/partnerships', payload: { ...form, website: 'http://spam.example' }, remoteAddress: '10.75.200.2' });
    expect(r.json()).toEqual({ ok: true });
    expect((await sql`select count(*)::int as n from partner_leads where email = ${LEAD_EMAIL}`)[0].n).toBe(before);
  });

  it('admins list leads and move them through new -> contacted -> active; bad status and unknown ids refused', async () => {
    const leads = (await boss.call('GET', '/admin/partner-leads')).json().leads;
    const lead = leads.find((l: any) => l.email === LEAD_EMAIL);
    expect(lead).toMatchObject({ businessName: 'Chai Point Goa', status: 'new' });
    for (const status of ['contacted', 'active']) {
      expect((await boss.call('POST', `/admin/partner-leads/${lead.id}/status`, { status })).json()).toEqual({ ok: true, lead: { id: lead.id, status } });
    }
    expect((await boss.call('POST', `/admin/partner-leads/${lead.id}/status`, { status: 'won' })).statusCode).toBe(400);
    expect((await boss.call('POST', '/admin/partner-leads/00000000-0000-4000-8000-000000000000/status', { status: 'declined' })).json().error).toBe('lead_not_found');
    expect((await kai.call('POST', `/admin/partner-leads/${lead.id}/status`, { status: 'declined' })).statusCode).toBe(403);
  });

  it('the form allows 5 an hour per address', async () => {
    const ip = '10.75.201.1';
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'POST', url: '/partnerships', payload: { ...form, website: 'x' }, remoteAddress: ip })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/partnerships', payload: { ...form, website: 'x' }, remoteAddress: ip })).statusCode).toBe(429);
  });
});
