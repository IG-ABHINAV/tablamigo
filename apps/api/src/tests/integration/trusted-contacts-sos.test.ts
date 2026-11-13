// SOS and trusted contacts beyond the happy path in trusted-contacts-safety.test.ts: the Plus limit of 5, the same number
// saved twice, other people's contacts, who may raise an SOS for a plan, and what the person who pressed it gets back.
// Nobody but the person pressing SOS is contacted by the server; the app hands them WhatsApp/SMS links to send themselves.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@sos.tablamigo';
process.env.REVIEW_EMAILS = ['ana', 'ben', 'cy', 'dee'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { setMailTransport } = await import('../../lib/mail.js');
const { signIn, onboard, createPlan } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
const mails: { to: string; subject: string; text: string }[] = [];
let ana: Person, ben: Person, cy: Person, dee: Person;
const contact = (p: Person, name: string, phone: string, extra: Record<string, unknown> = {}) => p.call('POST', '/safety/contacts', { name, phone, relationship: 'friend', ...extra });

beforeAll(async () => {
  app = await build();
  setMailTransport(async m => { mails.push(m); return { id: 'test' }; });
  await sql`delete from users where email like ${'%' + D}`;
  ana = await onboard(await signIn(app, 'ana' + D, '424242', 71), { name: 'Ana', gender: 'woman' });
  ben = await onboard(await signIn(app, 'ben' + D, '424242', 71), { name: 'Ben', gender: 'man' });
  cy = await onboard(await signIn(app, 'cy' + D, '424242', 71), { name: 'Cy', gender: 'man' });
  dee = await onboard(await signIn(app, 'dee' + D, '424242', 71), { name: 'Dee', gender: 'woman' });
  await sql`update users set comp_until = now() + interval '7 days', plus_until = now() + interval '7 days' where id = ${dee.id}`;
});
afterAll(async () => { setMailTransport(null); await sql`delete from users where email like ${'%' + D}`; await app.close(); await sql.end(); });

describe('trusted contacts', () => {
  it('Plus allows 5, the 6th is a paywall', async () => {
    expect((await dee.call('GET', '/safety/contacts')).json()).toMatchObject({ limit: 5, remaining: 5 });
    for (let i = 1; i <= 5; i++) expect((await contact(dee, `C${i}`, `+91 98200 0000${i}`)).statusCode).toBe(200);
    const sixth = await contact(dee, 'C6', '+91 98200 00006');
    expect(sixth.statusCode).toBe(402);
    expect(sixth.json()).toMatchObject({ error: 'plus_required', feature: 'trusted_contacts_limit' });
    expect((await dee.call('GET', '/safety/contacts')).json()).toMatchObject({ limit: 5, remaining: 0 });
  });

  it('saving the same number again updates that contact, it does not take a slot', async () => {
    expect((await contact(ana, 'Mum', '+44 7700 900001', { relationship: 'parent' })).statusCode).toBe(200);
    const again = await contact(ana, 'Mother', '+44 7700 900001', { relationship: 'family', notifyOnPlanJoin: false });
    expect(again.json().contact).toMatchObject({ name: 'Mother', relationship: 'family', notifyOnPlanJoin: false });
    expect((await ana.call('GET', '/safety/contacts')).json()).toMatchObject({ limit: 2, remaining: 1 });
  });

  it('nobody sees or deletes someone else\'s contacts', async () => {
    const [mine] = (await ana.call('GET', '/safety/contacts')).json().contacts;
    expect((await ben.call('GET', '/safety/contacts')).json().contacts).toEqual([]);
    expect((await ben.call('DELETE', `/safety/contacts/${mine.id}`)).statusCode).toBe(200);
    expect((await ana.call('GET', '/safety/contacts')).json().contacts.map((c: any) => c.id)).toContain(mine.id);
  });

  it('refuses bad input', async () => {
    expect((await contact(ana, '', '+44 7700 900002')).statusCode).toBe(400);
    expect((await contact(ana, 'X', '12')).statusCode).toBe(400);
    expect((await contact(ana, 'X', '+44 7700 900002', { relationship: 'boss' })).statusCode).toBe(400);
    expect((await ana.call('DELETE', '/safety/contacts/not-a-uuid')).statusCode).toBe(400);
  });

  it('needs a signed-in user', async () => {
    expect((await app.inject({ method: 'GET', url: '/safety/contacts' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/safety/sos/dispatch', payload: {} })).statusCode).toBe(401);
  });
});

describe('SOS', () => {
  let planId: string;
  beforeAll(async () => {
    planId = (await createPlan(ana, { title: 'Night market walk', placeName: 'Rot Fai Market' })).id;
    expect((await ben.call('POST', `/activities/${planId}/join`)).statusCode).toBe(200);
  });

  it('from a plan: only its host and members; anyone else gets 403 not_in_plan and learns nothing about it', async () => {
    for (const url of [`/activities/${planId}/sos`, '/safety/sos/dispatch']) {
      const r = await cy.call('POST', url, url.startsWith('/safety') ? { activityId: planId } : {});
      expect(r.statusCode, url).toBe(403);
      expect(r.json().error).toBe('not_in_plan');
      expect(r.body).not.toContain('Rot Fai');
    }
    expect((await ana.call('POST', `/activities/${planId}/sos`, {})).statusCode).toBe(200);
    expect((await ben.call('POST', `/activities/${planId}/sos`, {})).statusCode).toBe(200);
  });

  it('emails only the person who pressed it, logs the alert, and contacts nobody else', async () => {
    mails.length = 0;
    const r = (await ben.call('POST', `/activities/${planId}/sos`, { note: 'Feeling unsafe & leaving' })).json();
    expect(r).toMatchObject({ ok: true, alertLogged: true, emailedYou: true, emergencyContactNotified: false, contactsNotified: 0 });
    expect(mails.map(m => m.to)).toEqual([ben.email]);
    const [alert] = await sql`select note, latitude, longitude from safety_alerts where activity_id = ${planId} and user_id = ${ben.id} order by created_at desc limit 1`;
    expect(alert.note).toBe('Feeling unsafe & leaving');
    expect(Number(alert.latitude)).toBeCloseTo(13.7466, 3);
  });

  it('dispatch links: one per contact, the message URL-encoded, the number cleaned, the note and the plan in it', async () => {
    await contact(ben, 'Sis', '+91 (98200) 11-111');
    const r = (await ben.call('POST', '/safety/sos/dispatch', { activityId: planId, note: 'Call me? #help' })).json();
    expect(r.dispatches).toHaveLength(1);
    const d = r.dispatches[0];
    expect(d.whatsappUrl).toMatch(/^https:\/\/api\.whatsapp\.com\/send\?phone=919820011111&text=/);
    expect(d.smsUrl).toMatch(/^sms:\+919820011111\?body=/);
    const text = decodeURIComponent(d.whatsappUrl.split('&text=')[1]);
    expect(text).toBe(d.message);
    expect(text).toContain('EMERGENCY ALERT from Ben');
    expect(text).toContain('Night market walk');
    expect(text).toContain('Note: Call me? #help');
    expect(d.whatsappUrl).not.toContain('#help');   // a raw # would cut the message off
    expect(r.alertId).toEqual(expect.any(String));
  });

  it('without a plan or contacts: still answers with emergency numbers, and no alert row for a point-only SOS', async () => {
    const r = (await cy.call('POST', '/safety/sos/dispatch', { lat: 48.8566, lng: 2.3522 })).json();
    expect(r).toMatchObject({ ok: true, alertId: null, dispatches: [] });
    expect(r.emergencyNumbers).toBeTruthy();
    expect(r.mapUrl).toContain('48.8566,2.3522');
    const none = (await cy.call('POST', '/safety/sos/dispatch', {})).json();
    expect(none).toMatchObject({ ok: true, mapUrl: null });
  });

  it('refuses coordinates out of range and an overlong note', async () => {
    expect((await cy.call('POST', '/safety/sos/dispatch', { lat: 91, lng: 0 })).statusCode).toBe(400);
    expect((await cy.call('POST', '/safety/sos/dispatch', { note: 'x'.repeat(501) })).statusCode).toBe(400);
    expect((await ben.call('POST', `/activities/${planId}/sos`, { note: 'x'.repeat(501) })).statusCode).toBe(400);
  });
});
