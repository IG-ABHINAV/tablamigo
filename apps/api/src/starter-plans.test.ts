// Community starter plans (lib/starter-plans.ts) hosted by the Tablamigo Host, and the database guards of migration 059.
// Everything happens in May 2033 (every call says what time it is), so no other test file's plans or people fall inside these
// windows, and pushes are recorded instead of sent.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const pushes: { to: string[]; title: string; body: string; data?: Record<string, string> }[] = [];
vi.mock('./lib/push.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib/push.js')>()),
  notify: (to: string[], p: { title: string; body: string; data?: Record<string, string> }) => { if (to.length) pushes.push({ to: [...to], title: p.title, body: p.body, data: p.data }); return Promise.resolve(); },
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { signAccess } = await import('./lib/auth.js');
const { setMailTransport } = await import('./lib/mail.js');
const { planJoins } = await import('./lib/emails/jobs.js');
const { deliver } = await import('./lib/emails/send.js');
const S = await import('./lib/starter-plans.js');
const { STARTER_CITIES } = await import('./lib/starter-venues.js');
const { HOST_EMAIL } = await import('./lib/host.js');

const MAIL = '@starter.tablamigo';
const NOW = new Date('2033-05-02T06:00:00Z');                  // Monday, 11:30 in India
const H = 3600_000, DAY = 24 * H;
const at = (iso: string) => new Date(iso);
const MUMBAI = STARTER_CITIES.find(c => c.key === 'mumbai-in')!;
const GOA = STARTER_CITIES.find(c => c.key === 'goa-in')!;
const BANDRA = { lat: 19.0596, lng: 72.8295 };
const pt = (p: { lat: number; lng: number }) => sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;
const date = (d: Date) => d.toISOString().slice(0, 10);

let app: Awaited<ReturnType<typeof build>>;
let hostId: string;
const id: Record<string, string> = {};
const mails: { to: string; subject: string }[] = [];

async function person(tag: string, o: { email?: string; at?: { lat: number; lng: number }; seenAgoDays?: number } = {}) {
  const [u] = await sql`insert into users (email, name, birthdate, gender, home_country, onboarded, location, location_at, last_seen_at)
    values (${o.email ?? tag + MAIL}, ${tag}, '1994-02-02', 'man', 'IN', true,
      ${o.at ? pt(o.at) : null}, ${o.at ? new Date(NOW.getTime() - (o.seenAgoDays ?? 1) * DAY) : null}, now() - interval '1 day') returning id`;
  return (id[tag] = u.id as string);
}
const as = (userId: string) => (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${signAccess(userId)}` } });
const cleanPlans = () => sql`delete from activities where host_id = ${hostId} and starts_at >= '2033-01-01' and starts_at < '2034-01-01'`;
const starters = (key: string) => sql`select s.slot, s.starts_at, s.venue, s.go_announced_at, s.cancelled_at, s.real_going_at_cancel, a.id, a.title, a.status
  from starter_plans s join activities a on a.id = s.activity_id where s.city_key = ${key} and s.starts_at >= '2033-01-01' and s.starts_at < '2034-01-01' order by s.starts_at`;
const lines = async (activityId: string) => (await sql`select m.body from messages m join chats c on c.id = m.chat_id where c.activity_id = ${activityId} and m.kind = 'system' order by m.id`).map(m => m.body as string);

beforeAll(async () => {
  app = await build();
  setMailTransport(async m => { mails.push({ to: m.to, subject: m.subject }); return { id: 'test' }; });
  hostId = (await sql`select id from users where account_kind = 'team'`)[0].id;
  await cleanPlans();
  await sql`delete from users where email like ${'%' + MAIL} or email like 'starter%@demo.tablamigo'`;
});
afterAll(async () => {
  await cleanPlans();
  await sql`delete from users where email like ${'%' + MAIL} or email like 'starter%@demo.tablamigo'`;
  setMailTransport(null);
  await app.close();
  await sql.end();
});

describe('the team account in the database', () => {
  it('is one labelled, unverified, never-onboarded account that the engagement worker leaves alone (role admin)', async () => {
    const [h] = await sql`select email, name, bio, role, account_kind, onboarded, verified, id_verified from users where id = ${hostId}`;
    expect(h).toMatchObject({ email: HOST_EMAIL, name: 'Tablamigo Host (Team)', role: 'admin', accountKind: 'team', onboarded: false, verified: false, idVerified: false });
    expect(h.bio).toContain('Official Tablamigo team account, not a traveller.');
  });

  it('can never be verified, onboarded, a second team account, or a plan member', async () => {
    await expect(sql`update users set verified = true where id = ${hostId}`).rejects.toThrow(/users_team_account_rules/);
    await expect(sql`update users set onboarded = true where id = ${hostId}`).rejects.toThrow(/users_team_account_rules/);
    await expect(sql`insert into users (email, name, account_kind) values (${'team2' + MAIL}, 'Second team', 'team')`).rejects.toThrow(/users_one_team_account/);
    const [a] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at)
      values (${await person('guardHost')}, 'Guard test plan', 'food', 'Somewhere', ${pt(BANDRA)}, ${at('2033-12-01T10:00:00Z')}) returning id`;
    await expect(sql`insert into activity_members (activity_id, user_id) values (${a.id}, ${hostId})`).rejects.toThrow(/team_account_cannot_join_plans/);
    await sql`insert into activity_members (activity_id, user_id) values (${a.id}, ${id.guardHost})`;
    await expect(sql`update activity_members set user_id = ${hostId} where activity_id = ${a.id}`).rejects.toThrow(/team_account_cannot_join_plans/);
  });

  it('gets no email of any kind', async () => {
    const r = await deliver({ kind: 'starter_test', userId: hostId, periodKey: 'once', build: () => ({ subject: 'x', category: 'transactional', blocks: [] } as any) });
    expect(r).toBe('no_recipient');
    expect(await sql`select 1 from email_log where user_id = ${hostId}`).toEqual([]);
  });
});

describe('slot times', () => {
  it('each slot on its local day and time, from 72 hours to 10 days ahead', () => {
    const zone = 'Asia/Kolkata';
    expect(S.SLOTS.map(s => S.slotTimes(NOW, zone, s).map(d => d.toISOString()))).toEqual([
      ['2033-05-07T10:30:00.000Z'],   // Saturday 16:00 IST
      ['2033-05-08T11:30:00.000Z'],   // Sunday 17:00 IST
      ['2033-05-11T12:00:00.000Z'],   // Wednesday 17:30 IST (the 4th is less than 72 hours away)
    ]);
  });
});

describe('listing starter plans', () => {
  it('needs 2 real people around the city: one, or demo personas, are not enough', async () => {
    await person('local', { at: BANDRA, seenAgoDays: 2 });
    await person('stale', { at: BANDRA, seenAgoDays: 40 });
    for (const n of [1, 2]) await person('persona' + n, { email: `starter${n}${Date.now()}@demo.tablamigo`, at: BANDRA, seenAgoDays: 0 });
    expect(await S.cityDemand(MUMBAI, NOW)).toBe(1);
    const r = await S.maintainStarterPlans(NOW, 'on', { cities: [MUMBAI] });
    expect(r.created).toEqual([]);
    expect(await starters('mumbai-in')).toEqual([]);
  });

  it('with demand: one plan per slot at public places, hosted (not joined) by the Host, said plainly, no push', async () => {
    const visitor = await person('visitor');
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${visitor}, 'Mumbai', 'IN', 'mumbai-in', '2033-05-05', '2033-05-08')`;
    expect(await S.cityDemand(MUMBAI, NOW)).toBe(2);
    pushes.length = 0;
    const r = await S.maintainStarterPlans(NOW, 'on', { cities: [MUMBAI] });
    expect(r.created.map(c => `${c.slot} ${c.at}`)).toEqual(['sat_cafe 2033-05-07T10:30:00.000Z', 'sun_sunset 2033-05-08T11:30:00.000Z', 'wed_chai 2033-05-11T12:00:00.000Z']);
    const rows = await starters('mumbai-in');
    expect(rows.map(x => [x.slot, x.venue, x.title, x.status])).toEqual([
      ['sat_cafe', 'Kala Ghoda, Fort', 'Saturday café meetup (community)', 'active'],
      ['sun_sunset', 'Marine Drive promenade', 'Sunset walk (community)', 'active'],
      ['wed_chai', 'Carter Road Promenade, Bandra', 'Wednesday chai & chat (community)', 'active'],
    ]);
    const plans = await sql`select host_id, description, max_people, women_only, recurrence, city, closed,
        (select count(*)::int from activity_members m where m.activity_id = a.id) as members
      from activities a where id in ${sql(rows.map(x => x.id))}`;
    for (const p of plans) {
      expect(p).toMatchObject({ hostId, maxPeople: 8, womenOnly: false, recurrence: null, city: 'Mumbai', closed: false, members: 0 });
      expect(p.description).toContain('Tablamigo community meetup: travellers who join meet each other; no Tablamigo staff attends.');
    }
    expect(await lines(rows[0].id)).toEqual([S.OPENING_LINE]);
    expect(pushes).toEqual([]);
    expect(await sql`select 1 from analytics_events where event_name = 'plan_created' and user_id = ${hostId}`).toEqual([]);
  });

  it('is idempotent, and never more than 3 open plans in a city', async () => {
    expect((await S.maintainStarterPlans(NOW, 'on', { cities: [MUMBAI] })).created).toEqual([]);
    // Four days on, the next Saturday is in the window but the city already has 3 open plans.
    expect((await S.maintainStarterPlans(new Date(NOW.getTime() + 4 * DAY), 'on', { cities: [MUMBAI] })).created).toEqual([]);
    // Six days on, Saturday's plan has started: one more fits.
    const later = await S.maintainStarterPlans(new Date(NOW.getTime() + 6 * DAY), 'on', { cities: [MUMBAI] });
    expect(later.created.map(c => `${c.slot} ${c.at}`)).toEqual(['sat_cafe 2033-05-14T10:30:00.000Z']);
    expect((await starters('mumbai-in')).length).toBe(4);
  });

  it('dry run: logs once what it would list and writes nothing', async () => {
    const a = await person('goaA', { at: { lat: GOA.lat, lng: GOA.lng }, seenAgoDays: 1 });
    const b = await person('goaB', { at: { lat: 15.4977, lng: 73.8333 }, seenAgoDays: 3 });
    expect([a, b].length).toBe(2);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dryLog = new Set<string>();
    const r = await S.maintainStarterPlans(NOW, 'dry', { cities: [GOA], dryLog });
    expect(r.created).toHaveLength(3);
    expect(log.mock.calls.map(c => String(c[0]))).toEqual([
      'starter (dry): would create goa-in/sat_cafe/2033-05-07T10:30:00.000Z @ Fontainhas, Panaji',
      'starter (dry): would create goa-in/sun_sunset/2033-05-08T11:30:00.000Z @ Miramar Beach, Panaji',
      'starter (dry): would create goa-in/wed_chai/2033-05-11T12:00:00.000Z @ Church Square, Panaji',
    ]);
    await S.maintainStarterPlans(NOW, 'dry', { cities: [GOA], dryLog });
    expect(log).toHaveBeenCalledTimes(3);
    log.mockRestore();
    expect(await starters('goa-in')).toEqual([]);
  });

  it('processStarterPlans lists once an hour, and not at all when off; the decision runs either way', async () => {
    const state = { hour: null as string | null };
    const t = new Date(NOW.getTime() + 1 * H);
    const first = await S.processStarterPlans(t, state, { mode: 'dry', cities: [GOA], dryLog: new Set() });
    expect(first).toMatchObject({ mode: 'dry', cancelled: 0, confirmed: 0 });
    expect(first.maintained).not.toBeNull();
    expect((await S.processStarterPlans(new Date(t.getTime() + 10 * 60_000), state, { mode: 'dry', cities: [GOA], dryLog: new Set() })).maintained).toBeNull();
    expect(await S.processStarterPlans(new Date(t.getTime() + 2 * H), { hour: null }, { mode: 'off', cities: [GOA] })).toEqual({ mode: 'off', cancelled: 0, confirmed: 0, maintained: null });
  });
});

describe('the plan as people see it', () => {
  it('shows the Host as the team, with no rating, and "going" counts only the people who joined', async () => {
    const [sat] = await starters('mumbai-in');
    const r = await as(id.local)('GET', `/activities/${sat.id}`);
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(a.host).toMatchObject({ id: hostId, name: 'Tablamigo Host (Team)', verified: false, isTeam: true, rating: null, ratingsCount: 0 });
    expect(a.going).toBe(0);
    expect(a.attendees).toEqual([]);
    const profile = (await as(id.local)('GET', `/users/${hostId}`)).json();
    expect(profile).toMatchObject({ isTeam: true, verified: false, verificationTier: 'unverified' });
  });

  it('no plan-join email for the Host when someone joins its plan', async () => {
    const [sat] = await starters('mumbai-in');
    expect((await as(id.local)('POST', `/activities/${sat.id}/join`, {})).statusCode).toBe(200);
    await sql`update activity_members set joined_at = now() - interval '30 minutes' where activity_id = ${sat.id}`;
    await planJoins();
    expect(mails.filter(m => m.to === HOST_EMAIL)).toEqual([]);
    expect(await sql`select 1 from email_log where user_id = ${hostId}`).toEqual([]);
  });
});

describe('deciding: at least 2 real people, or it is cancelled 3 hours before', () => {
  it('1 real person plus a demo persona: cancelled, with the line in the chat, an inbox notice and a push; the Host gets nothing', async () => {
    const [sat] = await starters('mumbai-in');   // 'local' joined above
    const [c] = await sql`select id from chats where activity_id = ${sat.id}`;
    await sql`insert into activity_members (activity_id, user_id) values (${sat.id}, ${id.persona1})`;
    await sql`insert into chat_members (chat_id, user_id) values (${c.id}, ${id.persona1})`;
    expect(await S.realGoing(sat.id)).toBe(1);

    // 3 h 1 min before: not yet.
    expect(await S.decideStarterPlans(at('2033-05-07T07:29:00Z'))).toEqual({ cancelled: 0, confirmed: 0 });
    pushes.length = 0;
    const when = at('2033-05-07T07:31:00Z');
    expect(await S.decideStarterPlans(when)).toEqual({ cancelled: 1, confirmed: 0 });
    const [row] = (await starters('mumbai-in')).filter(x => x.id === sat.id);
    expect(row).toMatchObject({ status: 'cancelled', cancelledAt: when, realGoingAtCancel: 1 });
    expect((await lines(sat.id)).at(-1)).toBe(S.CANCEL_LINE);
    const notices = await sql`select user_id, body from notifications where activity_id = ${sat.id} and kind = 'cancelled'`;
    expect(notices.map(n => n.userId).sort()).toEqual([id.local, id.persona1].sort());
    expect(notices[0].body).toBe("Saturday café meetup (community) cancelled: 2 people hadn't joined");
    expect(pushes).toEqual([{ to: expect.arrayContaining([id.local, id.persona1]), title: 'Meetup cancelled', body: 'Saturday café meetup (community): kam se kam 2 log join nahi hue.', data: { chatId: c.id } }]);
    expect(pushes[0].to).not.toContain(hostId);
    expect(await sql`select 1 from notifications where user_id = ${hostId} and activity_id = ${sat.id} and kind = 'cancelled'`).toEqual([]);
    // Once decided, never again.
    expect(await S.decideStarterPlans(at('2033-05-07T08:00:00Z'))).toEqual({ cancelled: 0, confirmed: 0 });
  });

  it('2 real people: the "pakka" line, once; one dropping out afterwards still cancels it', async () => {
    const sun = (await starters('mumbai-in')).find(x => x.slot === 'sun_sunset')!;
    for (const who of ['local', 'visitor']) expect((await as(id[who])('POST', `/activities/${sun.id}/join`, {})).statusCode).toBe(200);
    expect(await S.decideStarterPlans(at('2033-05-08T08:31:00Z'))).toEqual({ cancelled: 0, confirmed: 1 });
    expect(await S.decideStarterPlans(at('2033-05-08T08:45:00Z'))).toEqual({ cancelled: 0, confirmed: 0 });
    expect((await lines(sun.id)).filter(l => l.startsWith('✅'))).toEqual([S.goLine(2)]);
    expect((await starters('mumbai-in')).find(x => x.id === sun.id)!.goAnnouncedAt).toEqual(at('2033-05-08T08:31:00Z'));

    expect((await as(id.visitor)('POST', `/activities/${sun.id}/leave`, {})).statusCode).toBe(200);
    expect(await S.decideStarterPlans(at('2033-05-08T10:00:00Z'))).toEqual({ cancelled: 1, confirmed: 0 });
    expect((await starters('mumbai-in')).find(x => x.id === sun.id)).toMatchObject({ status: 'cancelled', realGoingAtCancel: 1 });
  });

  it('a plan more than 3 hours away is left alone', async () => {
    const wed = (await starters('mumbai-in')).find(x => x.slot === 'wed_chai')!;
    expect(await S.decideStarterPlans(at('2033-05-11T08:59:00Z'))).toEqual({ cancelled: 0, confirmed: 0 });
    expect((await starters('mumbai-in')).find(x => x.id === wed.id)!.status).toBe('active');
  });
});
