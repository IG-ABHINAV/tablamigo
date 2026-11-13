// Support tickets: report -> ticket with a TM- ref, confirmation + internal copy, 60s dedupe,
// admin list / detail / reply / close / reopen. The mail transport is a recorder: nothing is sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
process.env.REVIEW_EMAILS = ['tboss', 'tuser', 'tother'].map(n => `${n}@support.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'tboss@support.tablamigo';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const { config } = await import('./lib/config.js');
const { ticketRef } = await import('./lib/support.js');

let app: Awaited<ReturnType<typeof build>>;
const DOMAIN = '@support.tablamigo';
type Sent = { to: string; subject: string; html: string; text: string; replyTo?: string };
let sent: Sent[] = [];
let ip = 0;

async function client(email: string) {
  const remoteAddress = `10.77.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
  const [u] = await sql`select id from users where email = ${email}`;
  return Object.assign(call, { id: u.id as string });
}
const clean = async () => {
  await sql`delete from support_tickets where email like ${'%' + DOMAIN}`;
  await sql`delete from email_log where to_email like ${'%' + DOMAIN} or to_email = ${config.supportEmail} and kind like 'support%'`;
  await sql`delete from reports where reporter_id in (select id from users where email like ${'%' + DOMAIN})`;
  await sql`delete from users where email like ${'%' + DOMAIN}`;
};

beforeAll(async () => {
  app = await build();
  await clean();
  setMailTransport(async m => { sent.push(m); return { id: `t-${sent.length}` }; });
});
beforeEach(() => { sent = []; });
afterAll(async () => { setMailTransport(null); await clean(); await app.close(); await sql.end(); });

describe('ticket refs', () => {
  it('TM- plus 4 unambiguous characters, stable per id', () => {
    const id = '0b7c1a4e-1111-4222-8333-944455556666';
    expect(ticketRef(id)).toMatch(/^TM-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(ticketRef(id)).toBe(ticketRef(id));
    expect(ticketRef(id, 1)).not.toBe(ticketRef(id));
  });
});

describe('report -> ticket', () => {
  it('creates a ticket, confirms to the reporter, copies support, and dedupes a double submit', async () => {
    const user = await client(`tuser${DOMAIN}`);
    const other = await client(`tother${DOMAIN}`);
    sent = [];
    const body = { targetType: 'user', targetId: other.id, reason: 'harassment', details: 'Kept messaging after I said no.' };
    const r1 = await user('POST', '/reports', body);
    expect(r1.statusCode).toBe(200);
    const ref = r1.json().ref as string;
    expect(ref).toMatch(/^TM-/);

    const ack = sent.filter(m => m.to === `tuser${DOMAIN}`);
    expect(ack).toHaveLength(1);
    expect(ack[0].subject).toBe(`Your report to Tablamigo [${ref}]`);
    expect(ack[0].text).toContain('A person on the team reviews every report');
    expect(ack[0].text).not.toMatch(/within|hours|24/i);
    expect(ack[0].text).toContain('Tablamigo by Hookstep · Ghatkopar, Mumbai, India');

    const internal = sent.filter(m => m.to === config.supportEmail);
    expect(internal).toHaveLength(1);
    expect(internal[0].subject.startsWith(`[${ref}] Report: Harassment`)).toBe(true);
    expect(internal[0].replyTo).toBe(`tuser${DOMAIN}`);
    expect(internal[0].text).toContain('Kept messaging');

    // Same report again within 60s: same ref, no new rows, nothing sent.
    sent = [];
    const r2 = await user('POST', '/reports', body);
    expect(r2.json().ref).toBe(ref);
    expect(sent).toHaveLength(0);
    const [{ n }] = await sql`select count(*)::int as n from support_tickets where email = ${`tuser${DOMAIN}`}`;
    expect(n).toBe(1);
    const [{ reports }] = await sql`select count(*)::int as reports from reports where reporter_id = ${user.id}`;
    expect(reports).toBe(1);

    // A different reason is a new report and a new ticket.
    const r3 = await user('POST', '/reports', { ...body, reason: 'spam' });
    expect(r3.json().ref).not.toBe(ref);
  });

  it('admin: list, filter, detail, reply (emailed, marks answered), close and reopen', async () => {
    const boss = await client(`tboss${DOMAIN}`);
    const user = await client(`tuser${DOMAIN}`);
    expect((await user('GET', '/admin/tickets')).statusCode).toBe(403);

    const list = (await boss('GET', `/admin/tickets?status=unanswered&q=tuser`)).json();
    const t = list.tickets.find((x: any) => x.subject.includes('Harassment'));
    expect(t).toBeTruthy();
    expect((await boss('GET', `/admin/tickets?q=${t.ref}`)).json().tickets.map((x: any) => x.id)).toEqual([t.id]);

    sent = [];
    const reply = await boss('POST', `/admin/tickets/${t.id}/reply`, { body: 'Thanks for reporting this. We have removed the account.\n\nBlock them from their profile too if you want.' });
    expect(reply.json()).toMatchObject({ ok: true, emailStatus: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(`tuser${DOMAIN}`);
    expect(sent[0].subject).toBe(`Re: Your report to Tablamigo [${t.ref}]`);
    expect(sent[0].text).toContain('We have removed the account.');
    expect(sent[0].text).toContain('You wrote: Kept messaging');

    const detail = (await boss('GET', `/admin/tickets/${t.id}`)).json();
    expect(detail.ticket.answeredAt).toBeTruthy();
    expect(detail.replies).toHaveLength(1);
    expect(detail.replies[0].adminEmail).toBe(`tboss${DOMAIN}`);
    expect((await boss('GET', `/admin/tickets?status=answered&q=${t.ref}`)).json().tickets).toHaveLength(1);

    expect((await boss('POST', `/admin/tickets/${t.id}/close`)).json().status).toBe('closed');
    expect((await boss('GET', `/admin/tickets?status=open&q=${t.ref}`)).json().tickets).toHaveLength(0);
    expect((await boss('POST', `/admin/tickets/${t.id}/reopen`)).json().status).toBe('open');
    expect((await boss('POST', `/admin/tickets/00000000-0000-4000-8000-000000000000/reply`, { body: 'hi there' })).statusCode).toBe(404);
  });

  it('health reports the database', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, db: 'ok' });
  });
});
