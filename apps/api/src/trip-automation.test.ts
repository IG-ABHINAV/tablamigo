// What the team did by hand for the first paid user on 31 Oct 2026, automatic (migration 069): trip match alerts
// (lib/trip-match.ts), the Plus welcome (lib/plus-welcome.ts), the empty-city nudge (lib/city-nudge.ts), the email ladder
// (lib/ladder.ts) and the engagement loops (lib/engagement.ts). Pinned to March 2035 so no other test file's trips, plans,
// messages or subscriptions fall inside any window here (and the jobs, which scan the whole database, only ever see this
// file's rows). Pushes and emails are recorded instead of sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.REVIEW_EMAILS = 'review@automatch.tablamigo';
process.env.ADMIN_EMAILS = 'boss@automatch.tablamigo';
const pushes: { to: string[]; title: string; body: string; data?: Record<string, string> }[] = [];
vi.mock('./lib/push.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib/push.js')>()),
  notify: (to: string[], p: { title: string; body: string; data?: Record<string, string> }) => { if (to.length) pushes.push({ to: [...to], title: p.title, body: p.body, data: p.data }); return Promise.resolve(); },
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { clock } = await import('./lib/clock.js');
const { config } = await import('./lib/config.js');
const { signAccess } = await import('./lib/auth.js');
const { setMailTransport } = await import('./lib/mail.js');
const { LIMITS } = await import('./lib/plus.js');
const TM = await import('./lib/trip-match.js');
const PW = await import('./lib/plus-welcome.js');
const CN = await import('./lib/city-nudge.js');
const L = await import('./lib/ladder.js');
const EN = await import('./lib/engagement.js');
const CH = await import('./lib/channels.js');
const { runSchedulerTick } = await import('./lib/scheduler.js');

const MAIL = '@automatch.tablamigo';
const NOW = new Date('2035-03-14T04:00:00Z');      // Wednesday: 12:00 in Bali, 09:30 in India
const NIGHT = new Date('2035-03-13T16:00:00Z');    // the night before: midnight in Bali
const H = 3600_000, MIN = 60_000;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const UBUD = { lat: -8.5069, lng: 115.2625 }, TEGALLALANG = { lat: -8.4318, lng: 115.2793 }, SANUR = { lat: -8.70, lng: 115.26 };
const pt = (p: { lat: number; lng: number }) => sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;

let app: Awaited<ReturnType<typeof build>>;
let hostId: string;
const mails: { to: string; subject: string; text: string }[] = [];
const id: Record<string, string> = {};

type P = { email?: string; name?: string; home?: string; gender?: string; plus?: boolean; interests?: string[]; at?: { lat: number; lng: number };
  deleted?: boolean; banned?: boolean; snoozed?: boolean; incognito?: boolean; alerts?: boolean; planAlerts?: boolean; role?: string; onboarded?: boolean; seen?: Date; prefs?: Record<string, boolean> };
async function person(tag: string, o: P = {}) {
  const [u] = await sql`insert into users (email, name, birthdate, gender, home_country, onboarded, interests, plus_until, deleted_at, banned_at,
      snoozed_until, is_incognito, trip_match_alerts, plan_alerts, role, location, location_at, last_seen_at, email_prefs)
    values (${o.email ?? tag + MAIL}, ${o.name ?? tag}, '1995-05-05', ${o.gender ?? 'woman'}, ${o.home ?? 'ZA'}, ${o.onboarded ?? true}, ${o.interests ?? []},
      ${o.plus ? at(30 * 24 * H) : null}, ${o.deleted ? NOW : null}, ${o.banned ? NOW : null}, ${o.snoozed ? sql`'infinity'::timestamptz` : null},
      ${o.incognito ?? false}, ${o.alerts ?? true}, ${o.planAlerts ?? true}, ${o.role ?? 'user'}, ${o.at ? pt(o.at) : null}, ${o.at ? NOW : null}, ${o.seen ?? NOW},
      ${sql.json(o.prefs ?? {})}) returning id`;
  return (id[tag] = u.id as string);
}
async function trip(tag: string, city: string, key: string, start: string, end: string, where: { lat: number; lng: number } | null = UBUD) {
  const [t] = await sql`insert into trips (user_id, city, country_code, city_key, location, start_date, end_date)
    values (${id[tag]}, ${city}, 'ID', ${key}, ${where ? pt(where) : null}, ${start}, ${end}) returning id`;
  return t.id as string;
}
const ubud = (tag: string, start = '2035-03-20', end = '2035-03-25') => trip(tag, 'Ubud', 'ubud-id', start, end);
const as = (userId: string) => (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${signAccess(userId)}` } });
const hostDm = async (userId: string) => sql`select m.id, m.body from messages m join chats c on c.id = m.chat_id
  join chat_members a on a.chat_id = c.id and a.user_id = ${userId} join chat_members h on h.chat_id = c.id and h.user_id = ${hostId}
  where c.kind = 'dm' and m.sender_id = ${hostId} order by m.id`;
const mine = () => sql`select id from users where email like ${'%' + MAIL}`;
const notices = async (userId: string) => sql`select status, reason, other_id from trip_match_notices where user_id = ${userId} order by created_at`;
/** Match only this file's trips (the jobs scan the whole shared test database), then send what is due to these people. */
async function matchAndSend(tripIds: string[], now = NOW) {
  await TM.discover(now, { mode: 'on', tripIds });
  return TM.deliverDue(now, { userIds: (await mine()).map(r => r.id) });
}
async function cleanup() {
  await sql`delete from chats where kind = 'dm' and id in (select chat_id from chat_members where user_id in (select id from users where email like ${'%' + MAIL}))`;
  await sql`delete from email_log where user_id in (select id from users where email like ${'%' + MAIL})`;
  await sql`delete from users where email like ${'%' + MAIL} or email like 'automatch-%'`;
}

beforeAll(async () => {
  app = await build();
  hostId = (await sql`select id from users where account_kind = 'team'`)[0].id;
  setMailTransport(async m => { mails.push({ to: m.to, subject: m.subject, text: m.text }); return { id: 'test' }; });
  vi.spyOn(clock, 'now').mockReturnValue(NOW);
  await cleanup();
});
afterAll(async () => {
  await cleanup();
  setMailTransport(null);
  await app.close();
  await sql.end();
});
beforeEach(async () => { await cleanup(); pushes.length = 0; mails.length = 0; for (const k of Object.keys(id)) delete id[k]; });

describe('trip match alerts', () => {
  it('introduces two real travellers in the same city on overlapping dates, both sides, once, with a profile link', async () => {
    await person('danielle', { name: 'Danielle Smith', plus: true, interests: ['yoga', 'coffee', 'hiking', 'nightlife'] });
    await person('nitya', { name: 'Nitya Singh', home: 'IN', interests: ['yoga', 'coffee', 'museums'] });
    const a = await ubud('danielle', '2035-03-20', '2035-03-25'), b = await ubud('nitya', '2035-03-22', '2035-04-02');
    const r = await matchAndSend([a, b]);
    expect(r.sent).toBe(2);
    const [toD] = await hostDm(id.danielle), [toN] = await hostDm(id.nitya);
    expect(toD.body).toContain('Nitya, another traveller on Tablamigo, will be in Ubud on 22–25 Mar too');
    expect(toD.body).toContain('You both like yoga and coffee.');
    expect(toD.body).toContain(`${config.siteUrl}/app/user/${id.nitya}`);
    expect(toN.body).toContain('Danielle, Tablamigo pe ek aur traveller,');              // Hinglish for India
    expect(toN.body).toContain(`/app/user/${id.danielle}`);
    // Only what the profile already shows: no surname, no email, no age, no plan history.
    for (const body of [toD.body, toN.body]) { expect(body).not.toMatch(/Smith|Singh|@|\b\d{2} ?y/); }
    // The DM pushed (post() pushes to both phones), the email waits for the ladder.
    expect(mails).toHaveLength(0);
    const log = await sql`select user_id, channel, status from notification_log where kind = 'trip_match' order by channel`;
    expect(log.filter(l => l.channel === 'inapp')).toHaveLength(2);
    // Again, and from the hourly sweep's side: nothing new.
    expect((await matchAndSend([a, b])).sent).toBe(0);
    expect(await hostDm(id.danielle)).toHaveLength(1);
    expect((await sql`select count(*)::int as n from trip_matches where user_lo in (${id.danielle}, ${id.nitya})`)[0].n).toBe(1);
  });

  it('matches within 20 km across city names, not farther', async () => {
    await person('a'); await person('b'); await person('c');
    const t1 = await ubud('a');
    const t2 = await trip('b', 'Tegallalang', 'tegallalang-id', '2035-03-21', '2035-03-23', TEGALLALANG);
    const t3 = await trip('c', 'Sanur', 'sanur-id', '2035-03-21', '2035-03-23', SANUR);
    const found = await TM.findCandidates({ tripIds: [t1, t2, t3], today: '2035-03-14' });
    const pairs = found.map(c => [c.aUser, c.bUser].sort().join(':'));
    expect(pairs).toContain([id.a, id.b].sort().join(':'));
    expect(pairs.some(p => p.includes(id.c))).toBe(false);
  });

  it('a match in a neighbouring town says where they are', async () => {
    await person('a', { name: 'Asha' }); await person('b', { name: 'Ben' });
    const t1 = await ubud('a'), t2 = await trip('b', 'Tegallalang', 'tegallalang-id', '2035-03-21', '2035-03-23', TEGALLALANG);
    await matchAndSend([t1, t2]);
    expect((await hostDm(id.a))[0].body).toContain('Ben, another traveller on Tablamigo, will be in Tegallalang, near Ubud, on 21–23 Mar too');
    expect((await hostDm(id.b))[0].body).toContain('Asha, another traveller on Tablamigo, will be in Ubud, near Tegallalang, on 21–23 Mar too');
  });

  it('notices that wait (night, a full day) step aside, so everyone behind them is still reached', async () => {
    await person('busy', { plus: true });
    const ts = [await ubud('busy')];
    // One day each, so the w's don't overlap one another: each has exactly one notice, about busy.
    for (const i of [1, 2, 3, 4, 5, 6]) { await person('w' + i, { plus: true }); ts.push(await ubud('w' + i, `2035-03-${19 + i}`, `2035-03-${19 + i}`)); }
    await TM.discover(NOW, { mode: 'on', tripIds: ts });
    // Busy's notices are first in line (Plus counterparts); a page of 4 is used up by them on the first pass.
    const everyone = (await mine()).map(r => r.id);
    for (let i = 0; i < 6; i++) await TM.deliverDue(NOW, { userIds: everyone, limit: 4 });
    for (const i of [1, 2, 3, 4, 5, 6]) expect((await sql`select status from trip_match_notices where user_id = ${id['w' + i]} and other_id = ${id.busy}`)[0].status, 'w' + i).toBe('sent');
    expect(await hostDm(id.busy)).toHaveLength(config.tripMatchPerDay);
    const [w] = await sql`select next_try_at from trip_match_notices where user_id = ${id.busy} and status = 'pending' limit 1`;
    expect(new Date(w.nextTryAt).getTime()).toBeGreaterThan(NOW.getTime() + 23 * H);
    // Deferred: the next passes don't even look at them (they used to fill every page).
    expect(await TM.deliverDue(at(MIN), { userIds: [id.busy] })).toEqual({ sent: 0, skipped: 0, failed: 0, waiting: 0 });
  });

  it('never matches demo, review, admin, team, deleted, banned, snoozed, incognito, opted-out, test-domain or not-onboarded accounts', async () => {
    await person('me');
    const others: [string, P][] = [
      ['demo', { email: 'automatch-x1@demo.tablamigo' }], ['review', { email: 'review@automatch.tablamigo' }], ['admin', { role: 'admin' }],
      ['boss', { email: 'boss@automatch.tablamigo' }], ['deleted', { deleted: true }], ['banned', { banned: true }],
      ['snoozed', { snoozed: true }], ['incog', { incognito: true, plus: true }], ['optout', { alerts: false }],
      ['qa', { email: 'automatch-qa@x.test' }], ['new', { onboarded: false }],
    ];
    const trips = [await ubud('me')];
    for (const [tag, o] of others) { await person(tag, o); trips.push(await ubud(tag)); }
    trips.push(await trip('me', 'Ubud', 'ubud-id', '2035-03-20', '2035-03-21'));
    expect(await TM.findCandidates({ tripIds: trips, today: '2035-03-14' })).toEqual([]);
  });

  it('never introduces people who blocked each other, are connected, already talk in a DM or sent a buddy request', async () => {
    for (const t of ['me', 'blocker', 'friend', 'talker', 'buddy']) await person(t);
    const trips = await Promise.all(['me', 'blocker', 'friend', 'talker', 'buddy'].map(t => ubud(t)));
    await sql`insert into blocks (blocker_id, blocked_id) values (${id.blocker}, ${id.me})`;
    await sql`insert into connections (user_id, friend_id) values (${id.me}, ${id.friend})`;
    const [c] = await sql`insert into chats (kind, dm_key) values ('dm', ${[id.me, id.talker].sort().join(':')}) returning id`;
    await sql`insert into chat_members (chat_id, user_id) values (${c.id}, ${id.me}), (${c.id}, ${id.talker})`;
    await sql`insert into messages (chat_id, sender_id, body) values (${c.id}, ${id.talker}, 'hey')`;
    await sql`insert into travel_buddy_requests (sender_id, recipient_id, city_key) values (${id.me}, ${id.buddy}, 'ubud-id')`;
    const found = await TM.findCandidates({ tripIds: [trips[0]], today: '2035-03-14' });
    expect(found).toEqual([]);
  });

  it('deleting and re-adding a trip, two nearby trips, or both people adding at once never introduce a pair twice', async () => {
    await person('x'); await person('y');
    const tx = await ubud('x'), ty = await ubud('y');
    // Both sides' discovery at the same moment, three times over.
    await Promise.all([1, 2, 3].flatMap(() => [TM.discover(NOW, { mode: 'on', tripIds: [tx] }), TM.discover(NOW, { mode: 'on', tripIds: [ty] })]));
    expect((await sql`select count(*)::int as n from trip_matches where user_lo in (${id.x}, ${id.y})`)[0].n).toBe(1);
    await TM.deliverDue(NOW, { userIds: [id.x, id.y] });
    await sql`delete from trips where id = ${tx}`;
    const again = await ubud('x', '2035-03-21', '2035-03-24');
    const near = await trip('x', 'Tegallalang', 'tegallalang-id', '2035-03-20', '2035-03-22', TEGALLALANG);
    await matchAndSend([again, near, ty]);
    expect(await hostDm(id.x)).toHaveLength(1);
    expect(await hostDm(id.y)).toHaveLength(1);
    // Concurrent senders for one notice: one DM.
    await person('z'); const tz = await ubud('z', '2035-03-22', '2035-03-23');
    await TM.discover(NOW, { mode: 'on', tripIds: [tz] });
    await Promise.all([1, 2, 3, 4].map(() => TM.deliverDue(NOW, { userIds: [id.z] })));
    expect(await hostDm(id.z)).toHaveLength(2);                     // x and y, once each (cap 3)
  });

  it('caps alerts per person per day; the rest wait for the next day, Plus counterparts first', async () => {
    await person('busy', { plus: true });
    const tb = await ubud('busy');
    const ts = [tb];
    for (const i of [1, 2, 3, 4, 5]) { await person('p' + i, { plus: i === 5 }); ts.push(await ubud('p' + i)); }
    await TM.discover(NOW, { mode: 'on', tripIds: ts });
    await TM.deliverDue(NOW, { userIds: [id.busy], limit: 50 });
    const first = await notices(id.busy);
    expect(first.filter(n => n.status === 'sent')).toHaveLength(config.tripMatchPerDay);
    expect(first.filter(n => n.status === 'pending')).toHaveLength(5 - config.tripMatchPerDay);
    expect(first.find(n => n.otherId === id.p5)?.status).toBe('sent');   // the Plus member went first
    await TM.deliverDue(at(25 * H), { userIds: [id.busy], limit: 50 });
    expect((await notices(id.busy)).filter(n => n.status === 'sent')).toHaveLength(5);
  });

  it('a free account is only told about people its trip screen shows it (no new paywall, none bypassed)', async () => {
    await person('free');
    const tf = await ubud('free');
    const ts = [tf];
    for (const i of [1, 2, 3, 4, 5]) { await person('q' + i); ts.push(await ubud('q' + i)); }
    await TM.discover(NOW, { mode: 'on', tripIds: ts });
    for (const d of [0, 25, 50]) await TM.deliverDue(at(d * H), { userIds: [id.free], limit: 50 });
    const n = await notices(id.free);
    expect(n.filter(x => x.status === 'sent')).toHaveLength(LIMITS.free.overlapPreview);
    expect(n.filter(x => x.status === 'skipped').every(x => ['free_preview_locked', 'free_preview_full'].includes(x.reason))).toBe(true);
    // The people it was told about are exactly the first ones of its own overlap list.
    const shown = (await as(id.free)('GET', `/trips/${tf}/overlaps`)).json().travelers.map((t: any) => t.id).sort();
    expect(n.filter(x => x.status === 'sent').map(x => x.otherId).sort()).toEqual(shown);
  });

  it('waits for daytime, and drops a notice when the other person is banned, blocks, or removes the trip before it goes', async () => {
    await person('m1'); await person('m2'); await person('m3'); await person('m4');
    const t = [await ubud('m1'), await ubud('m2'), await ubud('m3', '2035-03-24', '2035-03-25'), await ubud('m4', '2035-03-20', '2035-03-20')];
    await TM.discover(NIGHT, { mode: 'on', tripIds: t });
    const night = await TM.deliverDue(NIGHT, { userIds: [id.m1, id.m2, id.m3, id.m4], limit: 50 });
    expect(night.sent).toBe(0);
    expect(night.waiting).toBeGreaterThan(0);
    await sql`update users set banned_at = now() where id = ${id.m2}`;
    await sql`insert into blocks (blocker_id, blocked_id) values (${id.m3}, ${id.m1})`;
    await sql`delete from trips where id = ${t[3]}`;
    await TM.deliverDue(NOW, { userIds: [id.m1, id.m3, id.m4], limit: 50 });
    expect(await hostDm(id.m1)).toHaveLength(0);
    const reasons = (await sql`select reason from trip_match_notices where user_id = ${id.m1}`).map(r => r.reason).sort();
    expect(reasons).toEqual(['blocked', 'other_not_matchable', 'other_trip_gone'].sort());
  });

  it('the Profile switch: GET/PATCH /me, and off hides the person from everyone else too', async () => {
    await person('opt'); await person('other');
    expect((await as(id.opt)('GET', '/me')).json()).toMatchObject({ tripMatchAlerts: true, planAlerts: true });
    expect((await as(id.opt)('PATCH', '/me', { tripMatchAlerts: false, planAlerts: false })).statusCode).toBe(200);
    expect((await as(id.opt)('GET', '/me')).json()).toMatchObject({ tripMatchAlerts: false, planAlerts: false });
    const t = [await ubud('opt'), await ubud('other')];
    expect(await TM.findCandidates({ tripIds: t, today: '2035-03-14' })).toEqual([]);
    // Switched off after the match was made: the pending notices are dropped, nothing is sent.
    await sql`update users set trip_match_alerts = true where id = ${id.opt}`;
    await TM.discover(NOW, { mode: 'on', tripIds: t });
    await sql`update users set trip_match_alerts = false where id = ${id.opt}`;
    await TM.deliverDue(NOW, { userIds: [id.opt, id.other] });
    expect(await hostDm(id.opt)).toHaveLength(0);
    expect(await hostDm(id.other)).toHaveLength(0);
  });

  it('POST /trips matches at once when TRIP_MATCH is on, and does nothing when off; dry writes nothing', async () => {
    await person('early', { at: UBUD }); await person('late', { at: UBUD });
    await ubud('early');
    const prev = config.tripMatch;
    try {
      config.tripMatch = 'off';
      const off = await as(id.late)('POST', '/trips', { city: 'Ubud', countryCode: 'ID', lat: UBUD.lat, lng: UBUD.lng, startDate: '2035-03-21', endDate: '2035-03-23' });
      expect(off.statusCode).toBe(200);
      await new Promise(r => setTimeout(r, 200));
      expect((await sql`select count(*)::int as n from trip_matches where user_lo in (${id.early}, ${id.late})`)[0].n).toBe(0);
      await TM.processTripMatches(NOW, { mode: 'dry', force: true, state: { at: 0 }, dryLog: new Set() });
      expect((await sql`select count(*)::int as n from trip_matches where user_lo in (${id.early}, ${id.late})`)[0].n).toBe(0);
      config.tripMatch = 'on';
      await sql`delete from trips where user_id = ${id.late}`;
      const on = await as(id.late)('POST', '/trips', { city: 'Ubud', countryCode: 'ID', lat: UBUD.lat, lng: UBUD.lng, startDate: '2035-03-21', endDate: '2035-03-23' });
      expect(on.statusCode).toBe(200);
      // After the response, off the request path: allow a slow CI box up to 20 s.
      for (let i = 0; i < 200 && ((await hostDm(id.early)).length === 0 || (await hostDm(id.late)).length === 0); i++) await new Promise(r => setTimeout(r, 100));
      expect(await hostDm(id.early)).toHaveLength(1);
      expect(await hostDm(id.late)).toHaveLength(1);
    } finally { config.tripMatch = prev; }
  });

  it('migration 069 records the 31 Oct manual introduction, so the matcher never repeats it, and re-running it is harmless', async () => {
    const D = '22c4dd4e-eaff-42bf-99fa-fa5678f77c72', N = 'f73429fe-da84-4574-9495-f40910bfc264';
    await sql`delete from users where id in (${D}, ${N})`;
    await sql`insert into users (id, email, name, birthdate, gender, home_country, onboarded) values
      (${D}, ${'danielle-real' + MAIL}, 'Danielle', '1995-01-01', 'woman', 'ZA', true), (${N}, ${'nitya-real' + MAIL}, 'Nitya', '1995-01-01', 'woman', 'IN', true)`;
    id.dr = D; id.nr = N;
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'db/migrations/069_trip_matches_plus_welcome_city_nudges.sql');
    // 069 also sets the notifications kind list as it was then; later migrations widened it (077: connection requests). The
    // re-run leaves that statement out, so files running in parallel never see the old list (and no lock on notifications).
    const full = fs.readFileSync(file, 'utf8');
    const text = full.replace(/ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;\s*ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check\s*CHECK \(kind IN \([^)]*\)\);/, '');
    expect(text.length).toBeLessThan(full.length);
    // The migration's ALTER TABLE users takes an exclusive lock while other test files insert users in parallel; Postgres
    // can pick this side as the deadlock victim (40P01). The migration is idempotent, so run it again.
    const rerun = async () => {
      for (let i = 0; ; i++) {
        try { return await sql.unsafe(text); }
        catch (e: any) { if (e?.code !== '40P01' || i >= 4) throw e; await new Promise(r => setTimeout(r, 200 * (i + 1))); }
      }
    };
    await rerun();
    await rerun();
    expect((await sql`select count(*)::int as n from trip_match_notices where user_id in (${D}, ${N}) and status = 'sent'`)[0].n).toBe(2);
    const t = [await trip('dr', 'Ubud District', 'ubud-district-id', '2026-11-13', '2026-11-18'), await trip('nr', 'Ubud District', 'ubud-district-id', '2026-11-13', '2026-11-24')];
    expect(await TM.findCandidates({ tripIds: t, today: '2026-11-01' })).toEqual([]);
  });

  it('renders without a name that carries contact details', () => {
    const body = TM.renderMatchDm({ name: 'A', hinglish: false, city: 'Ubud', otherName: '9876543210', otherId: 'u1', overlapStart: '2035-03-20', overlapEnd: '2035-03-22', shared: [] });
    expect(body).not.toContain('9876543210');
    expect(body).toContain('another traveller on Tablamigo will be in Ubud on 20–22 Mar too');
  });
});

describe('the email ladder', () => {
  async function matched() {
    await person('r1', { name: 'Riya' }); await person('r2', { name: 'Sam' });
    await sql`insert into push_tokens (token, user_id, platform) values (${'tok-' + id.r1}, ${id.r1}, 'android')`;
    await matchAndSend([await ubud('r1'), await ubud('r2')]);
  }

  it('emails a trip match only when the DM is still unread after 6 hours (with a push token) or 15 minutes (without)', async () => {
    await matched();
    await L.processLadder(at(20 * MIN), { mode: 'on' });
    expect(mails.map(m => m.to)).toEqual(['r2' + MAIL]);            // no token: 15 minutes
    expect(mails[0].subject).toBe('Riya is in Ubud on your dates');
    expect(mails[0].text).toContain(`/app/user/${id.r1}`);
    // The email's one-tap "stop" link works for every app version, and can be undone.
    const stop = /\/alerts\/off\?t=([^)\s]+)/.exec(mails[0].text)![1];
    expect((await app.inject({ method: 'GET', url: `/alerts/off?t=${stop}` })).statusCode).toBe(200);
    expect((await sql`select trip_match_alerts from users where id = ${id.r2}`)[0].tripMatchAlerts).toBe(false);
    expect((await app.inject({ method: 'GET', url: `/alerts/off?t=${stop}&undo=1` })).statusCode).toBe(200);
    expect((await sql`select trip_match_alerts from users where id = ${id.r2}`)[0].tripMatchAlerts).toBe(true);
    expect((await app.inject({ method: 'GET', url: `/alerts/off?t=${id.r2}.trip_match.forged` })).statusCode).toBe(400);
    await L.processLadder(at(5 * H), { mode: 'on' });
    expect(mails).toHaveLength(1);
    await L.processLadder(at(6 * H + MIN), { mode: 'on' });
    expect(mails.map(m => m.to)).toEqual(['r2' + MAIL, 'r1' + MAIL]);
    await L.processLadder(at(7 * H), { mode: 'on' });
    expect(mails).toHaveLength(2);                                   // once
  });

  it('sends nothing once the DM was read or the push opened, in dry mode, or at night', async () => {
    await matched();
    await sql`update chat_members cm set last_read_message_id = (select max(id) from messages m where m.chat_id = cm.chat_id) where user_id = ${id.r2}`;
    expect((await as(id.r1)('POST', '/me/notifications/opened', { kind: 'trip_match', ref: (await sql`select ref from notification_log where user_id = ${id.r1} limit 1`)[0].ref })).json()).toEqual({ ok: true });
    await L.processLadder(at(20 * MIN), { mode: 'dry' });
    await L.processLadder(at(12 * H), { mode: 'on' });               // 16:00 UTC: midnight in Bali for both
    await L.processLadder(at(7 * H), { mode: 'on' });
    expect(mails).toHaveLength(0);
    expect((await sql`select count(*)::int as n from notification_log where read_at is not null and user_id = ${id.r2}`)[0].n).toBe(1);
  });

  it('respects email_prefs and the daily cap of fallback emails', async () => {
    await person('capped', { name: 'Cap' });
    const [c] = await sql`insert into chats (kind, dm_key) values ('dm', 'cap-test') returning id`;
    await sql`insert into chat_members (chat_id, user_id) values (${c.id}, ${id.capped})`;
    for (let i = 0; i < 6; i++) await L.recordInApp(id.capped, 'trip_match', 'm' + i, { chatId: c.id, messageId: 1, payload: { name: 'Cap', hinglish: false, city: 'Ubud', otherName: 'X', otherId: id.capped, overlapStart: '2035-03-20', overlapEnd: '2035-03-21', shared: [] } });
    await L.processLadder(at(7 * H), { mode: 'on' });
    expect(mails).toHaveLength(L.FALLBACK_EMAILS_PER_DAY);
    await person('nomail', { prefs: { activity: false } });
    await sql`insert into chat_members (chat_id, user_id) values (${c.id}, ${id.nomail})`;
    await L.recordInApp(id.nomail, 'trip_match', 'n1', { chatId: c.id, messageId: 1, payload: { name: 'N', hinglish: false, city: 'Ubud', otherName: 'X', otherId: id.capped, overlapStart: '2035-03-20', overlapEnd: '2035-03-21', shared: [] } });
    await L.processLadder(at(7 * H), { mode: 'on' });
    expect(mails.some(m => m.to === 'nomail' + MAIL)).toBe(false);
  });

  it('a person\'s unread DM or message request gets one email per unread streak, without the message text; muted and declined get none', async () => {
    await person('to', { at: UBUD }); await person('from', { name: 'Priya' }); await person('muted', { at: UBUD }); await person('declined', { at: UBUD });
    const dm = async (a: string, b: string, o: { muted?: boolean; status?: string } = {}) => {
      const [c] = await sql`insert into chats (kind, dm_key) values ('dm', ${[id[a], id[b]].sort().join(':')}) returning id`;
      await sql`insert into chat_members (chat_id, user_id, muted, request_status) values (${c.id}, ${id[a]}, ${o.muted ?? false}, ${o.status ?? 'pending'}), (${c.id}, ${id[b]}, false, 'accepted')`;
      await sql`insert into messages (chat_id, sender_id, body, created_at) values (${c.id}, ${id[b]}, 'my number is secret', ${at(-4 * H)})`;
      return c.id as string;
    };
    const chat = await dm('to', 'from'); await dm('muted', 'from', { muted: true }); await dm('declined', 'from', { status: 'declined' });
    await L.processLadder(NOW, { mode: 'on' });
    expect(mails.map(m => m.to)).toEqual(['to' + MAIL]);
    expect(mails[0].subject).toBe('Priya wants to chat on Tablamigo');
    expect(mails[0].text).not.toContain('secret');
    await L.processLadder(at(H), { mode: 'on' });
    expect(mails).toHaveLength(1);
    // Read, then a new unread message: a new streak, one more email.
    const [{ max }] = await sql`select max(id) as max from messages where chat_id = ${chat}`;
    await sql`update chat_members set last_read_message_id = ${max} where chat_id = ${chat} and user_id = ${id.to}`;
    await sql`insert into messages (chat_id, sender_id, body, created_at) values (${chat}, ${id.from}, 'again', ${at(-4 * H)})`;
    await L.processLadder(at(2 * H), { mode: 'on' });
    expect(mails).toHaveLength(2);
  });

  it('emails the 2-hour plan reminder to a going member who has no push token or left it unread, unless plan alerts are off', async () => {
    await person('host', { at: UBUD }); await person('g1', { at: UBUD }); await person('g2', { at: UBUD, planAlerts: false }); await person('g3', { at: UBUD });
    await sql`insert into push_tokens (token, user_id, platform) values (${'tok-' + id.g3}, ${id.g3}, 'android')`;
    const [a] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at, reminded_2h_at)
      values (${id.host}, 'Sunset walk', 'outdoors', 'Campuhan Ridge', ${pt(UBUD)}, ${at(2 * H)}, ${at(-MIN)}) returning id`;
    const [c] = await sql`insert into chats (kind, activity_id) values ('activity', ${a.id}) returning id`;
    for (const u of ['g1', 'g2', 'g3']) {
      await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${a.id}, ${id[u]}, 'going')`;
      await sql`insert into chat_members (chat_id, user_id, last_read_at) values (${c.id}, ${id[u]}, ${at(-H)})`;
    }
    await L.processLadder(NOW, { mode: 'on' });
    expect(mails.map(m => m.to)).toEqual(['g1' + MAIL]);
    expect(mails[0].text).toContain('2 pm local time');
    await L.processLadder(at(31 * MIN), { mode: 'on' });
    expect(mails.map(m => m.to).sort()).toEqual(['g1' + MAIL, 'g3' + MAIL]);
  });

});

describe('escalation channels after email (fake transport)', () => {
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  let status = 200;
  const ENV: Record<string, string> = {
    WHATSAPP_TOKEN: 'wa-token', WHATSAPP_PHONE_NUMBER_ID: '1099', WHATSAPP_TEMPLATE: 'tablamigo_alert',
    TELEGRAM_BOT_TOKEN: 'tg-token', TELEGRAM_BOT_USERNAME: 'tablamigo_bot', TELEGRAM_WEBHOOK_SECRET: 'tg-secret',
    TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'tw-token', TWILIO_FROM: '+15550001111',
  };
  beforeEach(() => {
    calls.length = 0; status = 200;
    CH.setChannelTransport(async c => { calls.push(c); return { status, body: '{}' }; });
    Object.assign(process.env, ENV);
  });
  afterAll(() => { CH.setChannelTransport(null); for (const k of Object.keys(ENV)) delete process.env[k]; });

  /** Kofi's DM to `tag`, unread for 2 hours. */
  async function unreadDm(tag: string) {
    await person('kofi' + tag, { name: 'Kofi' });
    const [c] = await sql`insert into chats (kind, dm_key) values ('dm', ${[id[tag], id['kofi' + tag]].sort().join(':')}) returning id`;
    await sql`insert into chat_members (chat_id, user_id, request_status) values (${c.id}, ${id[tag]}, 'accepted'), (${c.id}, ${id['kofi' + tag]}, 'accepted')`;
    await sql`insert into messages (chat_id, sender_id, body, created_at) values (${c.id}, ${id['kofi' + tag]}, 'secret plans', ${at(-2 * H)})`;
    return c.id as string;
  }
  const phone = (tag: string, o: { wa?: boolean; sms?: boolean; verified?: boolean } = {}) =>
    sql`update users set phone_e164 = '+919876543210', phone_verified_at = ${o.verified === false ? null : NOW}, whatsapp_opt_in = ${o.wa ?? false}, sms_opt_in = ${o.sms ?? false} where id = ${id[tag]}`;

  it('email first; when the email is opted out, the next channel the person said yes to (WhatsApp), and only that one', async () => {
    await person('wa', { at: UBUD, prefs: { activity: false } });
    await phone('wa', { wa: true, sms: true });
    await unreadDm('wa');
    await L.processLadder(NOW, { mode: 'on' });
    expect(mails).toHaveLength(0);
    expect(calls.map(c => c.url)).toEqual(['https://graph.facebook.com/v21.0/1099/messages']);
    const body = JSON.parse(calls[0].body);
    expect(body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'template', template: { name: 'tablamigo_alert', language: { code: 'en' } } });
    expect(body.template.components[0].parameters.map((p: any) => p.text)).toEqual(['New message from Kofi', `Open Tablamigo to read it and reply. ${config.siteUrl}/app/chat/${(await sql`select chat_id from chat_members where user_id = ${id.wa}`)[0].chatId}`]);
    expect(calls[0].headers.authorization).toBe('Bearer wa-token');
    await L.processLadder(at(10 * MIN), { mode: 'on' });
    expect(calls).toHaveLength(1);                                   // one event, one message per channel, and it stopped there
    // Even if the process died after sending and before marking the event done: the channel row holds, nothing goes twice.
    await sql`update notification_log set reason = null where user_id = ${id.wa} and kind = 'dm' and channel = 'inapp'`;
    await L.processLadder(at(20 * MIN), { mode: 'on' });
    expect(calls).toHaveLength(1);
    const log = await sql`select channel, status, reason from notification_log where user_id = ${id.wa} and kind = 'dm' and channel not in ('inapp', 'push') order by channel`;
    expect(log).toEqual([{ channel: 'email', status: 'skipped', reason: 'opted_out' }, { channel: 'whatsapp', status: 'sent', reason: null }]);
  });

  it('an unverified number or no yes means no WhatsApp or SMS; a failed provider call moves on to the next channel', async () => {
    await person('nv', { at: UBUD, prefs: { activity: false } }); await phone('nv', { wa: true, sms: true, verified: false });
    await person('sms', { at: UBUD, prefs: { activity: false } }); await phone('sms', { wa: true, sms: true });
    await unreadDm('nv'); await unreadDm('sms');
    status = 500;                                                    // WhatsApp is down
    await L.processLadder(NOW, { mode: 'on' });
    const urls = calls.map(c => c.url);
    expect(urls.filter(u => u.includes('graph.facebook.com'))).toHaveLength(1);   // only the verified one was tried
    expect(urls.filter(u => u.includes('api.twilio.com'))).toHaveLength(1);       // and it moved on to SMS
    const sms = calls.find(c => c.url.includes('twilio'))!;
    expect(sms.url).toBe('https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
    const form = new URLSearchParams(sms.body);
    expect(form.get('To')).toBe('+919876543210');
    expect(form.get('From')).toBe('+15550001111');
    expect(form.get('Body')!.length).toBeLessThanOrEqual(300);
    expect((await sql`select reason from notification_log where user_id = ${id.nv} and kind = 'dm' and channel = 'inapp'`)[0].reason).toBe('no_channel');
  });

  it('Telegram: only after the person started the bot with their own link; a blocked bot unlinks them', async () => {
    await person('tg', { at: UBUD, prefs: { activity: false } });
    await unreadDm('tg');
    const hook = (secret: string, text: string, chat = 5550001) => app.inject({ method: 'POST', url: '/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': secret }, payload: { update_id: 1, message: { message_id: 1, chat: { id: chat, type: 'private' }, text } } });
    const link = (await as(id.tg)('GET', '/me/telegram-link')).json().url as string;
    const token = new URL(link).searchParams.get('start')!;
    expect((await hook('nope', `/start ${token}`)).statusCode).toBe(401);
    expect((await hook('tg-secret', `/start ${token.slice(0, -2)}xx`)).json().result).toBe('ignored');
    expect((await hook('tg-secret', '/start')).json().result).toBe('ignored');
    await L.processLadder(NOW, { mode: 'on' });
    expect(calls.some(c => c.url.includes('telegram'))).toBe(false);  // not linked yet: nothing to send to
    expect((await hook('tg-secret', `/start ${token}`)).json().result).toBe('linked');
    await sql`update notification_log set reason = null where user_id = ${id.tg} and channel = 'inapp'`;
    await L.processLadder(at(MIN), { mode: 'on' });
    const tg = calls.filter(c => c.url === 'https://api.telegram.org/bottg-token/sendMessage');
    expect(tg).toHaveLength(1);
    expect(JSON.parse(tg[0].body)).toMatchObject({ chat_id: 5550001 });
    expect(JSON.parse(tg[0].body).text).not.toContain('secret plans');
    status = 403;
    expect(await CH.telegramChannel.send(id.tg, { kind: 'x', ref: 'y', title: 't', body: 'b' })).toBe('unavailable');
    expect((await sql`select telegram_chat_id from users where id = ${id.tg}`)[0].telegramChatId).toBeNull();
    // /stop from the same chat unlinks too, and a chat can belong to one person only.
    expect((await hook('tg-secret', `/start ${token}`)).json().result).toBe('linked');
    expect((await hook('tg-secret', '/stop')).json().result).toBe('unlinked');
    expect((await sql`select telegram_chat_id from users where id = ${id.tg}`)[0].telegramChatId).toBeNull();
  });

  it('nothing at night on any channel; and a person with nothing reachable is marked so, not retried every minute', async () => {
    await person('night', { at: UBUD, prefs: { activity: false } }); await phone('night', { wa: true });
    await unreadDm('night');
    await L.processLadder(at(12 * H), { mode: 'on' });               // midnight in Bali
    expect(calls).toHaveLength(0);
    for (const k of Object.keys(ENV)) delete process.env[k];         // no provider set up
    await L.processLadder(at(H), { mode: 'on' });
    expect(calls).toHaveLength(0);
    expect((await sql`select reason from notification_log where user_id = ${id.night} and channel = 'inapp'`)[0].reason).toBe('no_channel');
  });
});

describe('escalation of plan messages, buddy requests and digest events', () => {
  it('never escalates a demo persona\'s or a test account\'s message, nor an event recorded without its sender', async () => {
    await person('real', { at: UBUD });
    for (const [tag, email] of [['persona', 'automatch-persona@demo.tablamigo'], ['tester', 'automatch-t@x.test']] as const) {
      await person(tag, { email, name: 'Aisha' });
      const [c] = await sql`insert into chats (kind, dm_key) values ('dm', ${[id.real, id[tag]].sort().join(':')}) returning id`;
      await sql`insert into chat_members (chat_id, user_id, request_status) values (${c.id}, ${id.real}, 'accepted'), (${c.id}, ${id[tag]}, 'accepted')`;
      await sql`insert into messages (chat_id, sender_id, body, created_at) values (${c.id}, ${id[tag]}, 'hi!', ${at(-3 * H)})`;
    }
    // A row written by the first version (no senderId in its payload), as production has.
    const [c2] = await sql`insert into chats (kind, dm_key) values ('dm', 'automatch-legacy') returning id`;
    await sql`insert into chat_members (chat_id, user_id) values (${c2.id}, ${id.real})`;
    await L.recordInApp(id.real, 'dm', `${c2.id}:0`, { chatId: c2.id, messageId: 1, at: at(-3 * H), payload: { sender: 'Aisha', chatId: c2.id, request: false } });
    await L.processLadder(NOW, { mode: 'on' });
    expect(mails).toHaveLength(0);
    expect((await sql`select reason from notification_log where user_id = ${id.real} and channel = 'inapp'`).map(r => r.reason)).toEqual(['no_longer_valid']);
    await sql`delete from chats where dm_key = 'automatch-legacy'`;
  });

  it('an unread plan chat message escalates after 30 minutes; a muted chat never does', async () => {
    await person('host', { name: 'Leo' }); await person('m1', { at: UBUD }); await person('m2', { at: UBUD });
    const [a] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at) values (${id.host}, 'Sunset walk', 'outdoors', 'Campuhan', ${pt(UBUD)}, ${at(24 * H)}) returning id`;
    const [c] = await sql`insert into chats (kind, activity_id, title) values ('activity', ${a.id}, 'Sunset walk') returning id`;
    await sql`insert into chat_members (chat_id, user_id, muted) values (${c.id}, ${id.host}, false), (${c.id}, ${id.m1}, false), (${c.id}, ${id.m2}, true)`;
    await sql`insert into push_tokens (token, user_id, platform) values (${'t-' + id.m1}, ${id.m1}, 'android')`;
    await sql`insert into messages (chat_id, sender_id, body, created_at) values (${c.id}, ${id.host}, 'meet at the bridge', ${at(-20 * MIN)})`;
    await L.processLadder(NOW, { mode: 'on' });
    expect(mails).toHaveLength(0);                                   // 20 minutes: not yet
    await L.processLadder(at(11 * MIN), { mode: 'on' });
    expect(mails.map(m => [m.to, m.subject])).toEqual([['m1' + MAIL, 'Leo wrote in Sunset walk']]);
  });

  it('a travel buddy request notice escalates after 30 minutes unless it was read', async () => {
    await person('asker', { name: 'Tom' }); await person('b1', { at: UBUD }); await person('b2', { at: UBUD });
    for (const b of ['b1', 'b2']) await sql`insert into notifications (user_id, kind, actor_id, body, created_at) values (${id[b]}, 'buddy_request', ${id.asker}, 'Tom sent you a travel buddy request', ${at(-40 * MIN)})`;
    // b2's request is picked up while still unread (10 minutes in), then read before its 30 minutes are up.
    await L.processLadder(at(-30 * MIN), { mode: 'on' });
    expect(mails).toHaveLength(0);
    await sql`update notifications set read_at = now() where user_id = ${id.b2}`;
    await L.processLadder(NOW, { mode: 'on' });
    expect(mails.map(m => [m.to, m.subject])).toEqual([['b1' + MAIL, 'Tom wants to travel together']]);
  });

  it('a digest-type event (plan views) waits a day, then escalates once if the notice is still unread', async () => {
    await person('ph', { at: UBUD }); await person('pv1'); await person('pv2');
    const [a] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at) values (${id.ph}, 'Rice terrace walk', 'outdoors', 'Tegallalang', ${pt(UBUD)}, ${at(72 * H)}) returning id`;
    for (const v of ['pv1', 'pv2']) await as(id[v])('GET', `/activities/${a.id}`);
    await new Promise(r => setTimeout(r, 100));
    expect((await EN.planViewSummaries(NOW, { mode: 'on' })).sent).toBe(1);
    await L.processLadder(at(23 * H), { mode: 'on' });
    expect(mails).toHaveLength(0);
    await L.processLadder(at(24 * H + MIN), { mode: 'on' });
    expect(mails.map(m => m.subject)).toEqual(['2 people looked at Rice terrace walk']);
    await L.processLadder(at(25 * H), { mode: 'on' });
    expect(mails).toHaveLength(1);
  });
});

describe('the Plus welcome', () => {
  async function sub(tag: string, token: string, o: { linked?: string; status?: string } = {}) {
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, raw, updated_at)
      values (${token}, ${id[tag]}, 'google', 'tablamigo_plus', ${o.status ?? 'SUBSCRIPTION_STATE_ACTIVE'}, ${at(30 * 24 * H)},
        ${sql.json(o.linked ? { linkedPurchaseToken: o.linked } : {})}, ${NOW})`;
  }

  it('one DM and one email per new subscription, listing real Plus limits and the next step for their trip', async () => {
    await person('payer', { name: 'Danielle', plus: true }); await person('mate');
    const t = await ubud('payer'); await ubud('mate');
    await sub('payer', 'tok-payer-' + id.payer);
    const r = await PW.processPlusWelcomes(NOW, { mode: 'on' });
    expect(r.sent).toBe(1);
    const [dm] = await hostDm(id.payer);
    expect(dm.body).toContain('Welcome to Tablamigo Plus, Danielle');
    expect(dm.body).toContain(`free accounts see ${LIMITS.free.overlapPreview}`);
    expect(dm.body).toContain(`up to ${LIMITS.plus.cityChatDaysAhead} days before you land`);
    expect(dm.body).toContain(`Ubud (20–25 Mar): 1 other traveller is there on your dates. See them all: ${config.siteUrl}/app/trip/${t}`);
    expect(dm.body).toContain(`${config.siteUrl}/app/paywall`);
    expect(mails.map(m => m.subject)).toEqual(['Welcome to Plus, Danielle']);
    expect((await PW.processPlusWelcomes(at(MIN), { mode: 'on' })).sent).toBe(0);
    expect(await hostDm(id.payer)).toHaveLength(1);
    expect(mails).toHaveLength(1);
  });

  it('not for a plan change, a second subscription within 30 days, a pending one, a deleted account, dry mode or while all is free', async () => {
    await person('p'); await person('gone', { deleted: true }); await person('dry'); await person('pend');
    await sub('p', 'tok-a-' + id.p);
    await PW.processPlusWelcomes(NOW, { mode: 'on' });
    await sub('p', 'tok-b-' + id.p, { linked: 'tok-a-' + id.p });
    await sub('p', 'tok-c-' + id.p);
    await sub('gone', 'tok-' + id.gone); await sub('pend', 'tok-' + id.pend, { status: 'SUBSCRIPTION_STATE_PENDING' });
    await PW.processPlusWelcomes(NOW, { mode: 'on' });
    expect(await hostDm(id.p)).toHaveLength(1);
    expect((await sql`select reason from plus_welcomes where user_id = ${id.p} and status = 'skipped' order by reason`).map(r => r.reason)).toEqual(['plan_change', 'recent']);
    expect(await hostDm(id.gone)).toHaveLength(0);
    expect(await hostDm(id.pend)).toHaveLength(0);
    await sub('dry', 'tok-' + id.dry);
    await PW.processPlusWelcomes(NOW, { mode: 'dry', dryLog: new Set() });
    expect((await sql`select count(*)::int as n from plus_welcomes where user_id = ${id.dry}`)[0].n).toBe(0);
    config.allFree = true;
    try { expect((await PW.processPlusWelcomes(NOW, { mode: 'on' })).sent).toBe(0); } finally { config.allFree = false; }
  });

  it('not for a store review account', async () => {
    await person('rev', { email: 'review@automatch.tablamigo' });
    await sub('rev', 'tok-' + id.rev);
    await PW.processPlusWelcomes(NOW, { mode: 'on' });
    expect(await hostDm(id.rev)).toHaveLength(0);
  });

  it('every perk line comes from LIMITS (a limit change changes the message)', () => {
    const lines = PW.plusPerks();
    expect(lines.join('\n')).toContain(String(LIMITS.plus.activitiesPerDay));
    expect(lines.join('\n')).toContain(String(LIMITS.free.dmStartsPerDay));
    expect(PW.renderPlusWelcome({ name: 'X', hinglish: false, trips: [] })).toContain('/app/trip/new');
  });
});

describe('the empty-city nudge', () => {
  /** Every plan the nudge could post: hosted by anyone in this file (any date), or by the team or in Ubud on this file's dates.
   * Not a count of the whole table: other files share the database and post plans meanwhile, including team plans in Ubud in 2034. */
  const plansItCouldPost = async () => (await sql`select count(*)::int as n from activities a
    where a.host_id in (select id from users where email like ${'%' + MAIL})
      or ((a.host_id = ${hostId} or lower(a.city) = 'ubud' or st_dwithin(a.location, ${pt(UBUD)}, ${CN.NUDGE_RADIUS_KM * 1000}))
        and a.starts_at >= '2035-01-01' and a.starts_at < '2036-01-01')`)[0].n;

  it('one DM 3-10 days before a trip to a city with no plans, with three one-tap templates; never posts a plan', async () => {
    await person('solo', { gender: 'man' });
    const t = await ubud('solo', '2035-03-19', '2035-03-22');            // 5 days out
    const plansBefore = await plansItCouldPost();
    expect((await CN.processCityNudges(NOW, { mode: 'on' })).sent).toBe(1);
    const [dm] = await hostDm(id.solo);
    expect(dm.body).toContain('Nobody has posted a plan in Ubud for 19–22 Mar yet');
    for (const tpl of ['Coffee meetup', 'Morning walk', 'Food crawl']) expect(dm.body).toContain(tpl);
    expect(dm.body).toContain(`${config.siteUrl}/app/activity/new?title=Coffee+meetup+in+Ubud`);
    expect(dm.body).toContain('date=2035-03-19');
    expect(await plansItCouldPost()).toBe(plansBefore);
    expect((await CN.processCityNudges(at(H), { mode: 'on' })).sent).toBe(0);
    expect((await sql`select status from city_nudges where trip_id = ${t}`)[0].status).toBe('sent');
  });

  it('none when a plan exists nearby on the dates, too early or too late, at night, or with plan alerts off; women-only plans count for women only', async () => {
    await person('man', { gender: 'man' }); await person('woman'); await person('soon'); await person('far'); await person('quiet', { planAlerts: false });
    await person('planner');
    await ubud('man', '2035-03-19', '2035-03-22'); await ubud('woman', '2035-03-19', '2035-03-22');
    await ubud('soon', '2035-03-16', '2035-03-18'); await ubud('far', '2035-03-26', '2035-03-28'); await ubud('quiet', '2035-03-19', '2035-03-22');
    await sql`insert into activities (host_id, title, category, place_name, location, starts_at, women_only)
      values (${id.planner}, 'Women coffee', 'drinks', 'Cafe', ${pt(TEGALLALANG)}, '2035-03-20T02:00:00Z', true)`;
    expect((await CN.processCityNudges(NIGHT, { mode: 'on' })).sent).toBe(0);
    await CN.processCityNudges(NOW, { mode: 'on' });
    expect(await hostDm(id.man)).toHaveLength(1);
    for (const t of ['woman', 'soon', 'far', 'quiet']) expect(await hostDm(id[t])).toHaveLength(0);
  });

  it('the ladder emails the nudge only while the city is still empty', async () => {
    await person('e1', { gender: 'man' }); await person('e2', { gender: 'man' }); await person('poster');
    await ubud('e1', '2035-03-19', '2035-03-22');
    await trip('e2', 'Lovina', 'lovina-id', '2035-03-19', '2035-03-22', { lat: -8.16, lng: 115.03 });
    await CN.processCityNudges(NOW, { mode: 'on' });
    await sql`insert into activities (host_id, title, category, place_name, location, starts_at) values (${id.poster}, 'Coffee', 'drinks', 'Cafe', ${pt(UBUD)}, '2035-03-20T02:00:00Z')`;
    await L.processLadder(at(7 * H), { mode: 'on' });
    expect(mails).toHaveLength(0);                                   // digest-type: a day, not 6 hours
    await L.processLadder(at(24 * H + MIN), { mode: 'on' });
    expect(mails.map(m => m.to)).toEqual(['e2' + MAIL]);
    expect(mails[0].subject).toBe('Be the first plan in Lovina');
  });
});

describe('engagement loops', () => {
  it('a host hears "N people looked at your plan" once a day; incognito viewers, members and admins impersonating are not counted', async () => {
    await person('h', { at: UBUD }); await person('v1'); await person('v2'); await person('inc', { incognito: true, plus: true }); await person('mem'); await person('v3');
    const [a] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at) values (${id.h}, 'Rice terrace walk', 'outdoors', 'Tegallalang', ${pt(UBUD)}, ${at(48 * H)}) returning id`;
    await sql`insert into activity_members (activity_id, user_id) values (${a.id}, ${id.h}), (${a.id}, ${id.mem})`;
    for (const v of ['v1', 'inc', 'mem', 'h']) await as(id[v])('GET', `/activities/${a.id}`);
    expect((await EN.planViewSummaries(NOW, { mode: 'on' })).sent).toBe(0);     // 1 real view: below the minimum
    await as(id.v2)('GET', `/activities/${a.id}`);
    await new Promise(r => setTimeout(r, 100));
    expect((await EN.planViewSummaries(NOW, { mode: 'on' })).sent).toBe(1);
    const [n] = await sql`select body from notifications where user_id = ${id.h} and kind = 'plan_views'`;
    expect(n.body).toBe(EN.planViewsText(2, 'Rice terrace walk'));
    await as(id.v3)('GET', `/activities/${a.id}`);
    expect((await EN.planViewSummaries(at(2 * H), { mode: 'on' })).sent).toBe(0);  // once a day
    expect(pushes.some(p => p.to.includes(id.h) && p.title === 'Your plan is getting looks')).toBe(true);
  });

  it('a trip-in-3-days email to someone away from the app, with the real numbers; not to someone active; once', async () => {
    await person('away', { seen: at(-5 * 24 * H) }); await person('active'); await person('there');
    await ubud('away', '2035-03-17', '2035-03-20'); await ubud('active', '2035-03-17', '2035-03-20'); await ubud('there', '2035-03-18', '2035-03-19');
    expect((await EN.tripSoon(NOW, { mode: 'on' })).sent).toBe(1);
    expect(mails.map(m => m.to)).toEqual(['away' + MAIL]);
    expect(mails[0].subject).toBe('Ubud in 3 days');
    expect(mails[0].text).toContain('2 other travellers are there on your dates');
    expect(mails[0].text).toContain('No plans are posted in Ubud for your dates yet');
    expect((await EN.tripSoon(at(H), { mode: 'on' })).sent).toBe(0);
  });
});

describe('the scheduler', () => {
  it('runs every new job and stays quiet when they are off', async () => {
    const r = await runSchedulerTick(NOW, {}, { day: NOW.toISOString().slice(0, 10) });
    if (!r.ran) return;    // another file's tick held the lock this minute
    expect(r.tripMatches).toMatchObject({ mode: 'off' });
    expect(r.plusWelcomes).toMatchObject({ mode: 'off' });
    expect(r.cityNudges).toMatchObject({ mode: 'off' });
    expect(r.ladder).toMatchObject({ sent: 0, waiting: 0, skipped: 0 });
  });
});
