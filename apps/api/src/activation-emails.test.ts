// Activation nudges (lib/emails/activation.ts): the selection rules on their own, then end to end against the database
// with the mail transport replaced by a recorder. Nothing is sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const A = await import('./lib/emails/activation.js');
const { nextActivation, inSendWindow, runActivation, ACTIVATION_LAUNCH } = A;
type Candidate = import('./lib/emails/activation.js').Candidate;

const H = 3600_000, D = 24 * H;
const MAIL = '@activation.tablamigo';

// --- pure rules ---------------------------------------------------------------------------------
describe('nextActivation', () => {
  const now = new Date(ACTIVATION_LAUNCH.getTime() + 30 * D);
  const c = (o: Partial<Candidate> = {}): Candidate => ({
    id: 'u', createdAt: new Date(now.getTime() - 25 * H), verified: false, verifiedAt: null, verifyPending: false,
    hasPlan: false, hasTrip: true, log: [], ...o,
  });
  const row = (kind: string, hoursAgo: number, status = 'sent', attempts = 1) => ({ kind, at: new Date(now.getTime() - hoursAgo * H), status, attempts });

  it('first verification nudge from 24 hours after sign-up, not before', () => {
    expect(nextActivation(c({ createdAt: new Date(now.getTime() - 23 * H) }), now)).toBeNull();
    expect(nextActivation(c(), now)).toBe('activation_verify_1');
  });
  it('no verification nudge while a selfie is being checked, or once verified', () => {
    expect(nextActivation(c({ verifyPending: true }), now)).toBeNull();
    expect(nextActivation(c({ verified: true, hasPlan: true }), now)).toBeNull();
  });
  it('second verification nudge 4 days after the first, and never a third', () => {
    const old = new Date(now.getTime() - 10 * D);
    expect(nextActivation(c({ createdAt: old, log: [row('activation_verify_1', 95)] }), now)).toBeNull();
    expect(nextActivation(c({ createdAt: old, log: [row('activation_verify_1', 96)] }), now)).toBe('activation_verify_2');
    expect(nextActivation(c({ createdAt: old, log: [row('activation_verify_1', 200), row('activation_verify_2', 100)] }), now)).toBeNull();
  });
  it('48-hour cooldown between any two activation emails', () => {
    const old = new Date(now.getTime() - 10 * D);
    expect(nextActivation(c({ createdAt: old, hasTrip: false, log: [row('activation_verify_1', 47)] }), now)).toBeNull();
    expect(nextActivation(c({ createdAt: old, hasTrip: false, log: [row('activation_verify_1', 49)] }), now)).toBe('activation_trip');
  });
  it('at most 3 ever for new accounts, 1 for accounts from before the launch', () => {
    const three = [row('activation_verify_1', 300), row('activation_trip', 200), row('activation_verify_2', 100)];
    expect(nextActivation(c({ createdAt: new Date(now.getTime() - 20 * D), verified: true, verifiedAt: new Date(now.getTime() - 3 * D), log: three }), now)).toBeNull();
    const before = new Date(ACTIVATION_LAUNCH.getTime() - D);
    expect(nextActivation(c({ createdAt: before, hasTrip: false }), now)).toBe('activation_verify_1');
    expect(nextActivation(c({ createdAt: before, hasTrip: false, log: [row('activation_verify_1', 200)] }), now)).toBeNull();
  });
  it('a failed send neither counts against the caps nor settles its kind, until deliver() gives up after 3 tries', () => {
    expect(nextActivation(c({ log: [row('activation_verify_1', 1, 'failed', 1)] }), now)).toBe('activation_verify_1');
    expect(nextActivation(c({ log: [row('activation_verify_1', 1, 'failed', 3)] }), now)).toBeNull();   // settled, too early for verify_2
  });
  it('plan nudge: verified, never joined or hosted, 48 hours after verifying', () => {
    const old = new Date(now.getTime() - 10 * D);
    expect(nextActivation(c({ createdAt: old, verified: true, verifiedAt: new Date(now.getTime() - 47 * H) }), now)).toBeNull();
    expect(nextActivation(c({ createdAt: old, verified: true, verifiedAt: new Date(now.getTime() - 49 * H) }), now)).toBe('activation_plan');
    expect(nextActivation(c({ createdAt: old, verified: true, verifiedAt: null }), now)).toBe('activation_plan');   // verified by an admin
    expect(nextActivation(c({ createdAt: old, verified: true, hasPlan: true }), now)).toBeNull();
    expect(nextActivation(c({ createdAt: new Date(now.getTime() - 30 * H), verified: true, verifiedAt: new Date(now.getTime() - 60 * H) }), now)).toBeNull();
  });
  it('trip nudge 72 hours after sign-up, only without any trip', () => {
    expect(nextActivation(c({ verified: true, hasPlan: true, hasTrip: false, createdAt: new Date(now.getTime() - 71 * H) }), now)).toBeNull();
    expect(nextActivation(c({ verified: true, hasPlan: true, hasTrip: false, createdAt: new Date(now.getTime() - 73 * H) }), now)).toBe('activation_trip');
  });
  it('waits while any other email went out in the last 24 hours', () => {
    expect(nextActivation(c({ recentEmail: true }), now)).toBeNull();
  });
  it('no "last reminder" after a first verification nudge that never went out', () => {
    expect(nextActivation(c({ createdAt: new Date(now.getTime() - 10 * D), log: [row('activation_verify_1', 200, 'failed', 3)] }), now)).toBeNull();
  });
  it('accounts older than 60 days are left alone', () => {
    expect(nextActivation(c({ createdAt: new Date(now.getTime() - 61 * D) }), now)).toBeNull();
  });
  it('send window is 10:00 to 20:00 India time', () => {
    expect(inSendWindow(new Date('2026-10-14T04:29:00Z'))).toBe(false);   // 09:59 IST
    expect(inSendWindow(new Date('2026-10-14T04:30:00Z'))).toBe(true);    // 10:00 IST
    expect(inSendWindow(new Date('2026-10-14T14:29:00Z'))).toBe(true);    // 19:59 IST
    expect(inSendWindow(new Date('2026-10-14T14:30:00Z'))).toBe(false);   // 20:00 IST
  });
});

// --- end to end ---------------------------------------------------------------------------------
type Sent = { to: string; subject: string; html: string; text: string; headers?: Record<string, string> };
let sent: Sent[] = [];
const to = (name: string) => sent.filter(m => m.to === `${name}${MAIL}`);

/** The next 12:00 India time after the real clock, so log rows (stamped with the real now()) are always in the run's past. */
const noonIst = (() => { const d = new Date(Date.now() + 5.5 * H); d.setUTCHours(12, 0, 0, 0); let t = d.getTime() - 5.5 * H; if (t <= Date.now()) t += D; return new Date(t); })();
const at = (hours: number) => new Date(noonIst.getTime() + hours * H);
/** Every account here counts as a post-launch sign-up, whatever today's date. */
const LAUNCH = new Date(noonIst.getTime() - 400 * D);

async function user(name: string, extra: Record<string, unknown> = {}) {
  const [u] = await sql`insert into users ${sql({ email: `${name.toLowerCase()}${MAIL}`, name, birthdate: '1993-04-04', gender: 'woman', homeCountry: 'IN', onboarded: true, createdAt: at(-25), ...extra } as any)} returning id`;
  return u.id as string;
}
const clean = async () => {
  await sql`delete from email_log where to_email like ${'%' + MAIL}`;
  await sql`delete from users where email like ${'%' + MAIL} or email like ${'%activation-test@demo.tablamigo'}`;
};

beforeAll(async () => {
  await clean();
  setMailTransport(async m => { sent.push(m); return { id: `test-${sent.length}` }; });
});
beforeEach(() => { sent = []; });
afterAll(async () => { setMailTransport(null); await clean(); await sql.end(); });

describe('runActivation', () => {
  it('sends the right nudge once, to the right people, and respects every exclusion', async () => {
    const ana = await user('Ana');                                                           // unverified, has no trip
    await user('Del', { deletedAt: new Date() });
    await user('Ban', { bannedAt: new Date() });
    await user('Kid', { birthdate: new Date(Date.now() - 17 * 365 * D).toISOString().slice(0, 10) });
    await user('Opt', { emailPrefs: sql.json({ reminders: false }) as any });
    await user('All', { emailPrefs: sql.json({ all: false }) as any });
    await user('New', { onboarded: false });
    await user('Fresh', { createdAt: at(-20) });                                             // under 24 h
    await sql`insert into users ${sql({ email: 'activation-test@demo.tablamigo', name: 'Demo', birthdate: '1993-04-04', gender: 'woman', onboarded: true, createdAt: at(-25) } as any)}`;

    // A quiet-hours run sends nothing at all.
    const quiet = await runActivation({}, new Date(noonIst.getTime() + 9 * H), { emailLike: '%' + MAIL, launch: LAUNCH });   // 21:00 IST
    expect(quiet.skipped).toBe('quiet_hours');
    // A dry run lists Ana and writes nothing.
    const dry = await runActivation({}, at(0), { dryRun: true, emailLike: '%' + MAIL, launch: LAUNCH });
    expect(dry.planned.filter(p => p.email.endsWith(MAIL)).map(p => `${p.email}:${p.kind}`)).toEqual([`ana${MAIL}:activation_verify_1`]);
    expect(sent).toHaveLength(0);
    expect((await sql`select count(*)::int as n from email_log where to_email like ${'%' + MAIL}`)[0].n).toBe(0);

    await runActivation({}, at(0), { emailLike: '%' + MAIL, launch: LAUNCH });
    await runActivation({}, at(0), { emailLike: '%' + MAIL, launch: LAUNCH });                     // a second run (or a restart) in the same window: nothing new
    await runActivation({}, at(1), { emailLike: '%' + MAIL, launch: LAUNCH });
    expect(sent.filter(m => m.to.endsWith(MAIL)).map(m => `${m.to}:${m.subject}`)).toEqual([`ana${MAIL}:One selfie and you're verified`]);
    const m = to('ana')[0];
    expect(m.headers?.['List-Unsubscribe']).toContain('/email/unsubscribe?t=');
    expect(m.text).toContain('Ghatkopar, Mumbai, India');
    expect(m.text).toContain('/app/verify');

    // 49 hours later: the trip nudge (no trip, 74 h old); 5 days later: the last verification nudge; then nothing, ever.
    sent = [];
    await runActivation({}, at(49), { emailLike: '%' + MAIL, launch: LAUNCH });
    await runActivation({}, at(50), { emailLike: '%' + MAIL, launch: LAUNCH });
    expect(to('ana').map(x => x.subject)).toEqual(['Where are you headed next?']);
    sent = [];
    await runActivation({}, at(5 * 24 + 1), { emailLike: '%' + MAIL, launch: LAUNCH });
    expect(to('ana').map(x => x.subject)).toEqual(['Your verified tick is one selfie away']);
    sent = [];
    await sql`update users set verified = true where id = ${ana}`;
    await runActivation({}, at(10 * 24 + 1), { emailLike: '%' + MAIL, launch: LAUNCH });            // verified now and never joined a plan, but the cap of 3 is used up
    expect(to('ana')).toHaveLength(0);
    const kinds = (await sql`select kind from email_log where user_id = ${ana} order by created_at, kind`).map(r => r.kind).sort();
    expect(kinds).toEqual(['activation_trip', 'activation_verify_1', 'activation_verify_2']);
  });

  it('stops when the step is done, and opting out after the first email stops the rest', async () => {
    const bea = await user('Bea');
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${bea}, 'Goa', 'IN', 'goa-in', current_date + 20, current_date + 25)`;
    const cal = await user('Cal');
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${cal}, 'Goa', 'IN', 'goa-in', current_date + 20, current_date + 25)`;
    await runActivation({}, at(0), { emailLike: '%' + MAIL, launch: LAUNCH });
    expect(to('bea')).toHaveLength(1);
    expect(to('cal')).toHaveLength(1);
    // Bea verifies; Cal opts out of reminders.
    await sql`update users set verified = true where id = ${bea}`;
    await sql`update users set email_prefs = '{"reminders": false}' where id = ${cal}`;
    sent = [];
    await runActivation({}, at(5 * 24 + 1), { emailLike: '%' + MAIL, launch: LAUNCH });
    expect(to('bea').map(x => x.subject)).not.toContain('Your verified tick is one selfie away');
    expect(to('cal')).toHaveLength(0);
  });

  it('plan nudge shows real plans in the trip city, never demo, women-only (for a man), full or blocked hosts', async () => {
    const dan = await user('Dan', { gender: 'man', verified: true, createdAt: at(-24 * 5) });
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${dan}, 'Hampi', 'IN', 'hampi-in', current_date + 2, current_date + 6)`;
    const host = await user('Hostie', { verified: true, createdAt: at(-24 * 30) });
    const [demo] = await sql`insert into users ${sql({ email: 'host-activation-test@demo.tablamigo', name: 'Demo', birthdate: '1993-04-04', gender: 'woman', onboarded: true } as any)} returning id`;
    const plan = async (hostId: string, title: string, extra = sql``) => {
      const [p] = await sql`insert into activities (host_id, title, category, place_name, city, location, starts_at, women_only)
        values (${hostId}, ${title}, 'food', 'Mango Tree', 'Hampi', ST_SetSRID(ST_MakePoint(76.46, 15.33), 4326)::geography, current_date + 3 + interval '6 hours', ${title.includes('Women')}) returning id`;
      await sql`insert into activity_members (activity_id, user_id) values (${p.id}, ${hostId})`;
      return p.id as string;
    };
    await plan(host, 'Sunset at Hemakuta');
    await plan(host, 'Women only breakfast');
    await plan(demo.id, 'Demo boulder walk');
    try {
      const r = await runActivation({}, at(0), { dryRun: true, emailLike: '%' + MAIL, launch: LAUNCH });
      expect(r.planned.find(p => p.userId === dan)).toMatchObject({ kind: 'activation_plan', detail: { plans: 1, tripCity: 'Hampi', scope: 'trip_dates' } });
      await runActivation({}, at(0), { emailLike: '%' + MAIL, launch: LAUNCH });
      const m = to('dan');
      expect(m.map(x => x.subject)).toEqual(['Plans in Hampi for your trip']);
      expect(m[0].text).toContain('Sunset at Hemakuta');
      expect(m[0].text).not.toContain('Women only');
      expect(m[0].text).not.toContain('Demo boulder');
      expect(m[0].text).toContain('Joining is free');
    } finally {
      await sql`delete from users where id = ${demo.id}`;
    }
  });

  it('plan nudge: counts only people going, and never shows plans far from the user', async () => {
    const eva = await user('Eva', { verified: true, createdAt: at(-24 * 5), city: 'Pune', location: sql`ST_SetSRID(ST_MakePoint(73.85, 18.52), 4326)::geography` as any });
    const host = await user('Hostess', { verified: true, createdAt: at(-24 * 30) });
    const add = async (title: string, lng: number, lat: number, city: string) => {
      const [p] = await sql`insert into activities (host_id, title, category, place_name, city, location, starts_at)
        values (${host}, ${title}, 'food', 'Somewhere', ${city}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, now() + interval '3 days') returning id`;
      await sql`insert into activity_members (activity_id, user_id) values (${p.id}, ${host})`;
      return p.id as string;
    };
    const pune = await add('Misal at Bedekar', 73.86, 18.51, 'Pune');
    await add('Tacos in Mexico City', -99.13, 19.43, 'Mexico City');
    const maybe = await user('Maybe', { createdAt: at(-24 * 30) });
    await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${pune}, ${maybe}, 'maybe')`;
    await runActivation({}, at(0), { emailLike: '%' + MAIL, launch: LAUNCH });
    const m = to('eva');
    expect(m.map(x => x.subject)).toEqual(['1 plan near you']);
    expect(m[0].text).toContain('Misal at Bedekar');
    expect(m[0].text).toContain('1 going');
    expect(m[0].text).not.toContain('Mexico');
  });

  it('the per-run cap holds even if everyone is due', async () => {
    for (let i = 0; i < A.MAX_PER_RUN + 5; i++) await user(`Bulk${i}`, { verified: true, createdAt: at(-24 * 5) });
    const r = await runActivation({}, at(0), { dryRun: true, emailLike: '%' + MAIL, launch: LAUNCH });
    expect(r.planned.length).toBeLessThanOrEqual(A.MAX_PER_RUN);
  });
});
