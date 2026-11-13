// The Tablamigo Host's welcome DM (lib/host.ts): the text on its own, then end to end against the database at a pinned time in
// March 2034 (so no other test file's people, plans or trips fall inside its windows), and the admin Host inbox. Pushes are
// recorded instead of sent.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

process.env.REVIEW_EMAILS = 'review@hostwelcome.tablamigo';
const pushes: { to: string[]; title: string; body: string; data?: Record<string, string> }[] = [];
vi.mock('./lib/push.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib/push.js')>()),
  notify: (to: string[], p: { title: string; body: string; data?: Record<string, string> }) => { if (to.length) pushes.push({ to: [...to], title: p.title, body: p.body, data: p.data }); return Promise.resolve(); },
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { clock } = await import('./lib/clock.js');
const { signAccess, sha256 } = await import('./lib/auth.js');
const Host = await import('./lib/host.js');
const { renderWelcome, whenLabel, processHostWelcomes, HOST_EMAIL } = Host;

const MAIL = '@hostwelcome.tablamigo';
const NOW = new Date('2034-03-15T06:30:00Z');             // Wednesday, 12:00 in India
const NIGHT = new Date('2034-03-15T17:00:00Z');           // 22:30 in India
const H = 3600_000, DAY = 24 * H;
const BANDRA = { lat: 19.0596, lng: 72.8295 }, ANDHERI = { lat: 19.1136, lng: 72.8697 }, PUNE = { lat: 18.5204, lng: 73.8567 }, LEH = { lat: 34.1526, lng: 77.5771 };
const BANDRA_CELL = '19.05,72.85';                        // lib/geo.ts cell(): 0.05° grid
const pt = (p: { lat: number; lng: number }) => sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const inDays = (d: number, hUtc: number, m = 0) => new Date(Date.UTC(2034, 2, 15 + d, hUtc, m));

let app: Awaited<ReturnType<typeof build>>;
let hostId: string;
let hadCell = false;
let coffee: string;
const id: Record<string, string> = {};

type P = { email?: string; name?: string; home?: string; gender?: string; at?: { lat: number; lng: number }; city?: string | null; created?: Date; birthdate?: string; onboarded?: boolean; deleted?: boolean; banned?: boolean; role?: string };
async function person(tag: string, o: P = {}) {
  const [u] = await sql`insert into users (email, name, birthdate, gender, home_country, onboarded, location, location_at, city, created_at, deleted_at, banned_at, role)
    values (${o.email ?? tag + MAIL}, ${o.name ?? tag}, ${o.birthdate ?? '1996-04-04'}, ${o.gender ?? 'man'}, ${o.home ?? 'IN'}, ${o.onboarded ?? true},
      ${o.at ? pt(o.at) : null}, ${o.at ? ago(H) : null}, ${o.city ?? null}, ${o.created ?? ago(2 * H)},
      ${o.deleted ? ago(H) : null}, ${o.banned ? ago(H) : null}, ${o.role ?? 'user'}) returning id`;
  return (id[tag] = u.id as string);
}
async function plan(hostTag: string, title: string, emoji: string, place: string, startsAt: Date, o: { going?: string[]; womenOnly?: boolean; max?: number; paid?: boolean; at?: { lat: number; lng: number } } = {}) {
  const host = id[hostTag] ?? hostTag;
  const [a] = await sql`insert into activities (host_id, title, emoji, category, place_name, location, city, starts_at, women_only, max_people, is_paid)
    values (${host}, ${title}, ${emoji}, 'food', ${place}, ${pt(o.at ?? BANDRA)}, 'Mumbai', ${startsAt}, ${o.womenOnly ?? false}, ${o.max ?? null}, ${o.paid ?? false}) returning id`;
  for (const u of o.going ?? [hostTag]) await sql`insert into activity_members (activity_id, user_id) values (${a.id}, ${id[u]})`;
  return a.id as string;
}
const dmWithHost = async (userId: string) => (await sql`select c.id from chats c join chat_members a on a.chat_id = c.id and a.user_id = ${userId}
  join chat_members h on h.chat_id = c.id and h.user_id = ${hostId} where c.kind = 'dm'`)[0]?.id as string | undefined;
const as = (userId: string) => (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${signAccess(userId)}` } });
const cleanup = async () => {
  await sql`delete from chats where kind = 'dm' and id in (select chat_id from chat_members where user_id in (select id from users where email like ${'%' + MAIL}))`;
  await sql`delete from activities where host_id = ${hostId} and starts_at >= '2034-01-01' and starts_at < '2035-01-01'`;
  await sql`delete from analytics_events where user_id in (select id from users where email like ${'%' + MAIL})`;
  await sql`delete from users where email like ${'%' + MAIL} or email like 'hw%@demo.tablamigo'`;
  await sql`delete from otp_codes where email = ${HOST_EMAIL}`;
};

// The plan links are filled in once the plans exist (beforeAll).
const RAVI_TEMPLATE = `Hi Ravi 👋 Yeh Tablamigo team ka official account hai, koi traveller nahi.

Mumbai mein aane wale plans:
• 🍜 Street food crawl · Thu 16 Mar, 7 pm · Mohammed Ali Road · 2 going
https://tablamigo.hookstep.in/app/activity/FOOD
• ☕ Coffee in Bandra · Fri 17 Mar, 11 am · Bandra Bandstand · 1 going
https://tablamigo.hookstep.in/app/activity/COFFEE
Explore tab pe "Plans nearby" mein Join dabao.

☕ Tablamigo community meetup: Saturday café meetup (community), Sat 18 Mar, 4 pm, Kala Ghoda, Fort. Jo join karte hain woh aapas mein milte hain, team se koi nahi aata. Kam se kam 2 log join karein tabhi hoga.
Join karo: https://tablamigo.hookstep.in/app/activity/STARTER

Iss hafte Mumbai mein Tablamigo pe 2 aur log hain ya aa rahe hain.

Pehla plan banao: Explore tab pe "Create" dabao, jagah aur time chuno. Chai, walk, kuch bhi chalega.

Koi sawaal ho toh yahin reply karo, team ka koi insaan padhke jawab dega. Milna hamesha public jagah pe.`;

let RAVI = '';

const TOM = `Hi Tom 👋 This is the official Tablamigo team account, not a traveller.

There are no open plans in Leh yet, so the first one could be yours.
Post your first plan: tap "Create" on the Explore tab and pick a place and a time. Chai, a walk, anything works.

Questions? Reply here and a person from the team will read it and answer. Always meet in a public place.`;

const MEERA = `Hi Meera 👋 Yeh Tablamigo team ka official account hai, koi traveller nahi.

Goa mein abhi koi khula plan nahi hai, toh pehla plan aapka ho sakta hai.
Pehla plan banao: Explore tab pe "Create" dabao, jagah aur time chuno. Chai, walk, kuch bhi chalega.

Koi sawaal ho toh yahin reply karo, team ka koi insaan padhke jawab dega. Milna hamesha public jagah pe.`;

beforeAll(async () => {
  app = await build();
  hostId = (await sql`select id from users where account_kind = 'team'`)[0].id;
  await cleanup();
  hadCell = (await sql`select 1 from geo_cache where cell = ${BANDRA_CELL}`).length > 0;
  await sql`insert into geo_cache (cell, city, country) values (${BANDRA_CELL}, 'Mumbai', 'IN') on conflict (cell) do update set city = 'Mumbai', country = 'IN', cached_at = now()`;

  // The people who should get a welcome now.
  await person('ravi', { name: 'Ravi Kumar', at: BANDRA, city: 'Mumbai', created: ago(3 * H) });
  await person('tom', { name: 'Tom Hale', home: 'GB', at: LEH, city: 'Leh', created: ago(2.5 * H) });
  await person('meera', { name: 'Meera', gender: 'woman', created: ago(2 * H) });
  await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${id.meera}, 'Goa', 'IN', 'goa-in', '2034-03-20', '2034-03-25')`;

  // Real plans near Ravi, and the ones he must not be shown.
  await person('priya', { gender: 'woman', created: ago(90 * DAY) });
  await person('sam', { created: ago(90 * DAY) });
  await person('persona', { email: `hw${Date.now()}@demo.tablamigo`, created: ago(90 * DAY) });
  const food = await plan('priya', 'Street food crawl', '🍜', 'Mohammed Ali Road', inDays(1, 13, 30), { going: ['priya', 'sam'] });   // Thu 19:00 IST
  // Sam's plan, joined by a demo persona (the AI engagement worker joins quiet plans) and, below, a store review account:
  // three seats taken, one real person going.
  coffee = await plan('sam', 'Coffee in Bandra', '☕', 'Bandra Bandstand', inDays(2, 5, 30), { going: ['sam', 'persona'] }); // Fri 11:00 IST
  await plan('priya', 'Call me 98765 43210 for the plan', '📞', 'Bandra', inDays(1, 12), { going: ['priya', 'sam'] }); // contact details: left out
  await plan('persona', 'Demo host drinks', '🍹', 'Bandra', inDays(1, 14), { going: ['persona'] });
  await plan('priya', 'Women only brunch', '🥞', 'Bandra', inDays(1, 6), { womenOnly: true, going: ['priya'] });
  await person('blockedHost', { created: ago(90 * DAY) });
  await sql`insert into blocks (blocker_id, blocked_id) values (${id.ravi}, ${id.blockedHost})`;
  await plan('blockedHost', 'Blocked host dinner', '🍛', 'Bandra', inDays(1, 15), { going: ['blockedHost'] });
  await plan('sam', 'Full plan', '🎲', 'Bandra', inDays(1, 16), { max: 2, going: ['sam', 'priya'] });
  await plan('sam', 'Paid plan', '🎟️', 'Bandra', inDays(1, 17), { paid: true, going: ['sam'] });

  // The Host's community starter plans: one too soon to mention, one on Saturday. The welcome finds them by their point (Kala
  // Ghoda is within 30 km of Ravi). Their city key is this file's own: starter-plans.test.ts counts every open 'mumbai-in' plan
  // when it lists, and runs at the same time as this file.
  let starter = '';
  for (const [startsAt, slot] of [[ago(-2 * H), 'soon'], [inDays(3, 10, 30), 'sat_cafe']] as const) {
    const a = await plan(hostId, 'Saturday café meetup (community)', '☕', 'Kala Ghoda, Fort', startsAt, { going: [], at: { lat: 18.92846, lng: 72.83260 } });
    await sql`insert into starter_plans (activity_id, city_key, slot, starts_at, venue) values (${a}, 'hostwelcome-test-zz', ${slot}, ${startsAt}, 'Kala Ghoda, Fort')`;
    if (slot === 'sat_cafe') starter = a;
  }
  RAVI = RAVI_TEMPLATE.replace('FOOD', food).replace('COFFEE', coffee).replace('STARTER', starter);

  // Others in Mumbai this week: a trip typed for the city (no point) and someone seen in Andheri yesterday.
  await person('neha', { created: ago(30 * DAY) });
  await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${id.neha}, 'Mumbai', 'IN', 'mumbai-in', '2034-03-16', '2034-03-20')`;
  await person('arjun', { at: ANDHERI, created: ago(30 * DAY) });

  // People who must never get one (all in Pune, so none of them counts for Ravi either).
  const skip: [string, P][] = [
    ['deleted', { deleted: true }], ['banned', { banned: true }], ['demo', { email: `hw${Date.now() + 1}@demo.tablamigo` }], ['review', { email: 'review' + MAIL }],
    ['minor', { birthdate: '2020-01-01' }], ['blocksHost', {}], ['blockedByHost', {}], ['declined', {}], ['old', { created: ago(73 * H) }], ['fresh', { created: ago(5 * 60_000) }],
    ['notOnboarded', { onboarded: false }],
  ];
  for (const [tag, o] of skip) await person(tag, { at: PUNE, ...o });
  await sql`insert into activity_members (activity_id, user_id) values (${coffee}, ${id.review})`;
  await person('nowhere', {});                                                               // no location and no trip
  await sql`insert into blocks (blocker_id, blocked_id) values (${id.blocksHost}, ${hostId}), (${hostId}, ${id.blockedByHost})`;
  const [c] = await sql`insert into chats (kind, dm_key) values ('dm', ${[hostId, id.declined].sort().join(':')}) returning id`;
  await sql`insert into chat_members (chat_id, user_id, request_status) values (${c.id}, ${hostId}, 'accepted'), (${c.id}, ${id.declined}, 'declined')`;
});
afterAll(async () => {
  await cleanup();
  if (!hadCell) await sql`delete from geo_cache where cell = ${BANDRA_CELL}`;
  vi.restoreAllMocks();
  await app.close();
  await sql.end();
});

describe('the welcome text', () => {
  const base = { name: 'Ravi Kumar', hinglish: true, city: 'Mumbai', plans: [], starter: null, others: 0 };
  it('times read like "Sat 18 Mar, 4 pm" on the plan\'s own clock', () => {
    expect(whenLabel('2034-03-18T10:30:00Z', 'Asia/Kolkata')).toBe('Sat 18 Mar, 4 pm');
    expect(whenLabel('2034-03-22T12:00:00Z', 'Asia/Kolkata')).toBe('Wed 22 Mar, 5:30 pm');
    expect(whenLabel('2034-03-18T00:00:00Z', 'UTC')).toBe('Sat 18 Mar, 12 am');
  });
  it('says nothing about other travellers at 0, and "1 aur insaan" / "1 other person" at 1', () => {
    expect(renderWelcome(base)).not.toMatch(/Iss hafte/);
    expect(renderWelcome({ ...base, others: 1 })).toContain('Iss hafte Mumbai mein Tablamigo pe 1 aur insaan hai ya aa raha hai.');
    expect(renderWelcome({ ...base, hinglish: false, others: 1 })).toContain('This week 1 other person on Tablamigo is in Mumbai or on the way.');
    expect(renderWelcome({ ...base, hinglish: false, others: 4 })).toContain('This week 4 other people on Tablamigo are in Mumbai or on the way.');
  });
  it('without a city it says "near you", and the empty state only when there is nothing to join', () => {
    expect(renderWelcome({ ...base, city: null })).toContain('Aapke aas-paas abhi koi khula plan nahi hai, toh pehla plan aapka ho sakta hai.');
    expect(renderWelcome({ ...base, hinglish: false, city: null })).toContain('There are no open plans near you yet, so the first one could be yours.');
    const withStarter = renderWelcome({ ...base, starter: { title: 'Sunset walk (community)', startsAt: '2034-03-19T11:30:00Z', placeName: 'Marine Drive promenade', zone: 'Asia/Kolkata' } });
    expect(withStarter).not.toContain('abhi koi khula plan nahi hai');
    expect(withStarter).toContain('☕ Tablamigo community meetup: Sunset walk (community), Sun 19 Mar, 5 pm, Marine Drive promenade.');
  });
  it('every plan it names and the community meetup carry their link, which the app opens in the plan screen', () => {
    const plans = [{ id: 'p1', emoji: '🍜', title: 'Food crawl', startsAt: '2034-03-18T10:30:00Z', placeName: 'Fort', going: 2, zone: 'Asia/Kolkata' }];
    const starter = { id: 's1', title: 'Sunset walk (community)', startsAt: '2034-03-19T11:30:00Z', placeName: 'Marine Drive', zone: 'Asia/Kolkata' };
    const en = renderWelcome({ ...base, hinglish: false, plans, starter });
    expect(en).toContain('• 🍜 Food crawl · Sat 18 Mar, 4 pm · Fort · 2 going\nhttps://tablamigo.hookstep.in/app/activity/p1\n');
    expect(en).toContain('at least 2 people join.\nJoin here: https://tablamigo.hookstep.in/app/activity/s1');
    expect(renderWelcome({ ...base, plans, starter })).toContain('Join karo: https://tablamigo.hookstep.in/app/activity/s1');
  });
  it('a plan whose title or place carries a web address is left out (the chat would make it tappable in the team\'s DM)', () => {
    const at = { startsAt: '2034-03-18T10:30:00Z', going: 1, zone: 'Asia/Kolkata' };
    const plans = [{ id: 'bad1', title: 'Tickets at https://evil.example/pay', placeName: 'Fort', ...at }, { id: 'bad2', title: 'Brunch', placeName: 'see www.evil.example', ...at },
      { id: 'bad3', title: 'Pay on evil-pay.com/x', placeName: 'Fort', ...at }, { id: 'ok', title: 'Chai at 7.30', placeName: 'Café No.1, St. Mark\'s Rd', ...at }];
    const text = renderWelcome({ ...base, plans });
    expect(text).not.toMatch(/evil|bad\d/);
    expect(text).toContain('Chai at 7.30');
    expect(text).toContain('https://tablamigo.hookstep.in/app/activity/ok');
  });
  it('a long title or place is clipped, so the cap never cuts a plan link', () => {
    const plans = [{ id: 'p1', title: 'x'.repeat(1500), startsAt: '2034-03-18T10:30:00Z', placeName: 'y'.repeat(1500), going: 0, zone: 'Asia/Kolkata' }];
    const starter = { id: 's1', title: 'z'.repeat(1500), startsAt: '2034-03-19T11:30:00Z', placeName: 'w'.repeat(1500), zone: 'Asia/Kolkata' };
    const text = renderWelcome({ ...base, plans, starter, others: 3 });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('https://tablamigo.hookstep.in/app/activity/p1\n');
    expect(text).toContain('Join karo: https://tablamigo.hookstep.in/app/activity/s1\n');
  });
  it('the push preview (first 140 characters) says it is the team, and the whole DM stays under 2,000 characters', () => {
    const long = 'x'.repeat(700);
    const plans = [1, 2, 3].map(i => ({ emoji: '✨', title: long + i, startsAt: '2034-03-18T10:30:00Z', placeName: long, going: 2, zone: 'Asia/Kolkata' }));
    const text = renderWelcome({ ...base, name: 'A'.repeat(40), plans, others: 3 });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain('Pehla plan banao');               // plan lines are dropped, the rest stays
    expect(text.slice(0, 140)).toContain('team');
    expect(renderWelcome({ ...base, hinglish: false, name: 'B'.repeat(40) }).slice(0, 140)).toContain('team');
  });
});

describe('sending the welcome', () => {
  it('off does nothing, and quiet hours (22:30 in India) send nothing', async () => {
    expect(await processHostWelcomes(NOW, { mode: 'off', emailLike: '%' + MAIL })).toEqual({ mode: 'off', sent: 0, failed: 0, planned: 0, quiet: 0 });
    const night = await processHostWelcomes(NIGHT, { mode: 'on', emailLike: '%' + MAIL });
    expect(night).toMatchObject({ sent: 0, planned: 0 });
    expect(night.quiet).toBeGreaterThanOrEqual(3);
    expect(await sql`select 1 from host_welcomes w join users u on u.id = w.user_id where u.email like ${'%' + MAIL}`).toEqual([]);
  });

  it('dry logs who would get one, once per user, and writes nothing', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const dryLog = new Set<string>();
    expect(await processHostWelcomes(NOW, { mode: 'dry', emailLike: '%' + MAIL, dryLog })).toMatchObject({ sent: 0, planned: 3 });
    expect(await processHostWelcomes(NOW, { mode: 'dry', emailLike: '%' + MAIL, dryLog })).toMatchObject({ sent: 0, planned: 0 });
    const lines = log.mock.calls.map(c => String(c[0])).filter(l => l.startsWith('host welcome (dry)'));
    log.mockRestore();
    expect(lines).toEqual([
      `host welcome (dry): user=${id.ravi} city=Mumbai plans=2 starter=yes others=2 chars=${RAVI.length}`,
      `host welcome (dry): user=${id.tom} city=Leh plans=0 starter=no others=0 chars=${TOM.length}`,
      `host welcome (dry): user=${id.meera} city=Goa plans=0 starter=no others=0 chars=${MEERA.length}`,
    ]);
    expect(await sql`select 1 from host_welcomes w join users u on u.id = w.user_id where u.email like ${'%' + MAIL}`).toEqual([]);
    expect(await dmWithHost(id.ravi)).toBeUndefined();
  });

  it('"N going" counts real people only: a demo persona and a store review account on a real plan add nothing', async () => {
    const [{ seats }] = await sql`select count(*)::int as seats from activity_members where activity_id = ${coffee} and rsvp_status = 'going'`;
    expect(seats).toBe(3);                                   // sam, the demo persona, the review account
    const w = await Host.buildWelcome({ id: id.ravi, name: 'Ravi Kumar', gender: 'man', homeCountry: 'IN', city: 'Mumbai', ...BANDRA }, NOW);
    expect(w.text).toContain('• ☕ Coffee in Bandra · Fri 17 Mar, 11 am · Bandra Bandstand · 1 going\n');
    expect(w.text).toContain('• 🍜 Street food crawl · Thu 16 Mar, 7 pm · Mohammed Ali Road · 2 going\n');
    expect(w.text).toBe(RAVI);
  });

  it('on: exactly one DM each, accepted (never a message request), with the exact text and a push titled as the team', async () => {
    pushes.length = 0;
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await processHostWelcomes(NOW, { mode: 'on', emailLike: '%' + MAIL });
    log.mockRestore();
    expect(r).toEqual({ mode: 'on', sent: 3, failed: 0, planned: 0, quiet: 0 });

    const rows = await sql`select u.email, w.status, w.chat_id, w.message_id, w.meta from host_welcomes w join users u on u.id = w.user_id where u.email like ${'%' + MAIL} order by u.email`;
    expect(rows.map(x => [x.email, x.status])).toEqual([['meera' + MAIL, 'sent'], ['ravi' + MAIL, 'sent'], ['tom' + MAIL, 'sent']]);
    expect(rows.find(x => x.email === 'ravi' + MAIL)!.meta).toMatchObject({ city: 'Mumbai', cityKey: 'mumbai-in', scope: 'near', plans: 2, others: 2 });

    for (const [tag, text] of [['ravi', RAVI], ['tom', TOM], ['meera', MEERA]] as const) {
      const chat = await dmWithHost(id[tag]);
      expect(chat, tag).toBeTruthy();
      const msgs = await sql`select sender_id, kind, body from messages where chat_id = ${chat!}`;
      expect(msgs).toEqual([{ senderId: hostId, kind: 'text', body: text }]);
      const members = await sql`select user_id, request_status from chat_members where chat_id = ${chat!} order by (user_id = ${hostId}) desc`;
      expect(members).toEqual([{ userId: hostId, requestStatus: 'accepted' }, { userId: id[tag], requestStatus: 'accepted' }]);
    }
    const toRavi = pushes.find(p => p.to.includes(id.ravi))!;
    expect(toRavi).toEqual({ to: [id.ravi], title: 'Tablamigo Host (Team)', body: RAVI.slice(0, 140), data: { chatId: await dmWithHost(id.ravi) } });
    // The team's messages are not a person's activity.
    expect(await sql`select 1 from analytics_events where user_id = ${hostId} and event_name = 'message_sent'`).toEqual([]);

    // Nobody else got one.
    const skipped = ['deleted', 'banned', 'demo', 'review', 'minor', 'blocksHost', 'blockedByHost', 'declined', 'old', 'fresh', 'notOnboarded', 'nowhere', 'priya', 'neha', 'arjun'];
    expect(await sql`select user_id from host_welcomes where user_id in ${sql(skipped.map(t => id[t]))}`).toEqual([]);
    expect((await sql`select count(*)::int as n from messages where chat_id = ${(await dmWithHost(id.declined))!}`)[0].n).toBe(0);

    // In the app it is a plain chat from "Tablamigo Host (Team)", not a request to accept.
    const list = (await as(id.ravi)('GET', '/chats')).json().chats;
    expect(list.find((c: any) => c.id === rows.find(x => x.email === 'ravi' + MAIL)!.chatId)).toMatchObject({ kind: 'dm', title: 'Tablamigo Host (Team)', isRequest: false });
  });

  it('a second run sends nothing, and two runs at once send one welcome', async () => {
    expect(await processHostWelcomes(NOW, { mode: 'on', emailLike: '%' + MAIL })).toMatchObject({ sent: 0, failed: 0 });
    await person('twin', { at: PUNE, created: ago(H) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const both = await Promise.all([processHostWelcomes(NOW, { mode: 'on', emailLike: '%' + MAIL }), processHostWelcomes(NOW, { mode: 'on', emailLike: '%' + MAIL })]);
    log.mockRestore();
    expect(both[0].sent + both[1].sent).toBe(1);
    expect((await sql`select count(*)::int as n from messages where chat_id = ${(await dmWithHost(id.twin))!}`)[0].n).toBe(1);
  });
});

describe('the admin Host inbox', () => {
  let admin: ReturnType<typeof as>;
  let raviChat: string;
  beforeAll(async () => {
    admin = as(await person('boss', { role: 'admin', created: ago(400 * DAY) }));
    raviChat = (await dmWithHost(id.ravi))!;
  });

  it('lists the Host\'s DMs with what the team hasn\'t read, and reading clears it', async () => {
    // Ravi answers: that accepts the request.
    expect((await as(id.ravi)('POST', `/chats/${raviChat}/messages`, { body: 'Thanks! Any meetups this weekend?' })).statusCode).toBe(200);
    const r = (await admin('GET', '/admin/host/chats')).json();
    expect(r.host).toEqual({ id: hostId, name: 'Tablamigo Host (Team)' });
    expect(r.stats.welcomes.sent).toBeGreaterThanOrEqual(4);
    const c = r.chats.find((x: any) => x.id === raviChat);
    expect(c).toMatchObject({ requestStatus: 'accepted', unread: 1, user: { id: id.ravi, name: 'Ravi Kumar' }, lastMessage: { body: 'Thanks! Any meetups this weekend?', fromHost: false } });
    const thread = (await admin('GET', `/admin/host/chats/${raviChat}/messages`)).json();
    expect(thread.messages.map((m: any) => [m.fromHost, m.body.slice(0, 20)])).toEqual([[true, RAVI.slice(0, 20)], [false, 'Thanks! Any meetups ']]);
    expect((await admin('GET', '/admin/host/chats')).json().chats.find((x: any) => x.id === raviChat).unread).toBe(0);
  });

  it('a reply goes out as the Host and records the admin who wrote it', async () => {
    const [admin_] = await sql`select id from users where email = ${'boss' + MAIL}`;
    pushes.length = 0;
    const r = await admin('POST', `/admin/host/chats/${raviChat}/messages`, { body: 'Hi Ravi! Saturday café meetup at Kala Ghoda is open, join from Explore.' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ senderId: hostId, kind: 'text', senderName: 'Tablamigo Host (Team)' });
    expect(pushes).toEqual([expect.objectContaining({ to: [id.ravi], title: 'Tablamigo Host (Team)' })]);
    const [ev] = await sql`select properties from analytics_events where user_id = ${admin_.id} and event_name = 'admin_host_reply'`;
    expect(ev.properties).toMatchObject({ chatId: raviChat, messageId: r.json().id, toUserId: id.ravi });
    // Not into a request that was declined.
    const declined = (await admin('POST', `/admin/host/chats/${(await dmWithHost(id.declined))!}/messages`, { body: 'Hello?' }));
    expect(declined.statusCode).toBe(400);
    expect(declined.json().error).toBe('request_declined');
  });

  it('a reply to a DM still left pending by an older welcome accepts it, so it is not a message request', async () => {
    const early = (await dmWithHost(id.tom))!;
    await sql`update chat_members set request_status = 'pending' where chat_id = ${early} and user_id = ${id.tom}`;
    expect((await as(id.tom)('GET', '/chats')).json().chats.find((c: any) => c.id === early).isRequest).toBe(true);
    expect((await admin('POST', `/admin/host/chats/${early}/messages`, { body: 'Here is the profile link.' })).statusCode).toBe(200);
    expect((await sql`select request_status from chat_members where chat_id = ${early} and user_id = ${id.tom}`)[0].requestStatus).toBe('accepted');
    expect((await as(id.tom)('GET', '/chats')).json().chats.find((c: any) => c.id === early).isRequest).toBe(false);
  });

  it('a person who writes to the Host first: the team reading and answering accepts the Host\'s side, clears unread and shows "Seen"', async () => {
    const asker = await person('asker', { at: PUNE, created: ago(400 * DAY) });   // an old account: no welcome
    const user = as(asker);
    const open = await user('POST', `/dm/${hostId}`);                              // Message on the Host's profile
    expect(open.statusCode).toBe(200);
    const chat = open.json().chatId as string;
    const hostSide = async () => (await sql`select request_status, last_read_message_id::text as read_id from chat_members where chat_id = ${chat} and user_id = ${hostId}`)[0];
    expect((await hostSide()).requestStatus).toBe('pending');
    const first = await user('POST', `/chats/${chat}/messages`, { body: 'Hi, is this really the Tablamigo team?' });
    expect(first.statusCode).toBe(200);
    const unread = async () => (await admin('GET', '/admin/host/chats')).json().chats.find((x: any) => x.id === chat).unread;
    expect(await unread()).toBe(1);

    // Reading it accepts the Host's side and moves the Host's read position: unread clears and the person sees "Seen".
    const thread = (await admin('GET', `/admin/host/chats/${chat}/messages`)).json();
    expect(thread.messages.map((m: any) => [m.fromHost, m.body])).toEqual([[false, 'Hi, is this really the Tablamigo team?']]);
    expect(await hostSide()).toEqual({ requestStatus: 'accepted', readId: first.json().id });
    expect(await unread()).toBe(0);
    expect((await user('GET', `/chats/${chat}/messages`)).json().reads).toEqual({ [hostId]: first.json().id });

    // A second message answered straight away, without opening the thread first: the reply moves the read position past it.
    const second = await user('POST', `/chats/${chat}/messages`, { body: 'And how do I post a plan?' });
    expect(await unread()).toBe(1);
    const reply = await admin('POST', `/admin/host/chats/${chat}/messages`, { body: 'Yes, this is the team. Tap Create on the Explore tab.' });
    expect(reply.statusCode).toBe(200);
    expect(BigInt((await hostSide()).readId)).toBeGreaterThan(BigInt(second.json().id));
    expect(await unread()).toBe(0);
    expect((await user('GET', `/chats/${chat}/messages`)).json().reads).toEqual({ [hostId]: reply.json().id });
  });

  it('a new user who wrote to the Host before the welcome: the welcome goes into that chat and accepts the Host\'s side', async () => {
    const early = await person('early', { at: PUNE, created: ago(H) });
    const open = await as(early)('POST', `/dm/${hostId}`);
    expect(open.statusCode).toBe(200);
    const chat = open.json().chatId as string;
    await as(early)('POST', `/chats/${chat}/messages`, { body: 'Hello team' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const r = await processHostWelcomes(NOW, { mode: 'on', emailLike: 'early' + MAIL });
    log.mockRestore();
    expect(r).toMatchObject({ sent: 1, failed: 0 });
    const msgs = await sql`select id::text, sender_id from messages where chat_id = ${chat} order by id`;
    expect(msgs.map(m => m.senderId)).toEqual([early, hostId]);
    expect((await sql`select request_status, last_read_message_id::text as read_id from chat_members where chat_id = ${chat} and user_id = ${hostId}`)[0])
      .toEqual({ requestStatus: 'accepted', readId: msgs[1].id });
    expect((await sql`select request_status from chat_members where chat_id = ${chat} and user_id = ${early}`)[0].requestStatus).toBe('accepted');
  });

  it('previews the exact welcome a user would get, and lists starter plans', async () => {
    vi.spyOn(clock, 'now').mockReturnValue(NOW);
    const p = (await admin('GET', `/admin/host/preview?userId=${id.ravi}`)).json();
    vi.mocked(clock.now).mockRestore();
    expect(p).toMatchObject({ due: false, welcome: { status: 'sent' }, text: RAVI });
    const s = (await admin('GET', '/admin/starter-plans')).json();
    expect(s.mode).toBe('off');
    expect(Array.isArray(s.plans)).toBe(true);
  });

  it('nobody can act as the Host: no impersonation, no admin rights, no sign-in code', async () => {
    const imp = await admin('POST', `/admin/users/${hostId}/impersonate`);
    expect(imp.statusCode).toBe(403);
    expect(imp.json().error).toBe('team_account');
    expect((await as(hostId)('GET', '/admin/me')).statusCode).toBe(403);
    const start = await app.inject({ method: 'POST', url: '/admin/auth/start', payload: { email: HOST_EMAIL }, remoteAddress: '10.77.0.1' });
    expect(start.statusCode).toBe(200);
    expect(await sql`select 1 from otp_codes where email = ${HOST_EMAIL}`).toEqual([]);
    // The app's own email sign-in: the same answer as for anyone, and no code stored, so there is nothing to guess.
    const appStart = await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email: HOST_EMAIL }, remoteAddress: '10.77.0.2' });
    expect(appStart.statusCode).toBe(200);
    expect(appStart.json()).toEqual({ ok: true, resent: true, resendIn: 30 });   // what anyone gets for a fresh code
    expect(await sql`select 1 from otp_codes where email = ${HOST_EMAIL}`).toEqual([]);
    // Even with a right code (one stored before this fix), signInByEmail refuses the team account.
    const tokens = async () => (await sql`select count(*)::int as n from refresh_tokens where user_id = ${hostId}`)[0].n;
    const tokensBefore = await tokens();
    await sql`insert into otp_codes (email, code_hash, expires_at) values (${HOST_EMAIL}, ${sha256('123456')}, now() + interval '10 minutes')`;
    const verify = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email: HOST_EMAIL, code: '123456' }, remoteAddress: '10.77.0.2' });
    await sql`delete from otp_codes where email = ${HOST_EMAIL}`;
    expect(verify.statusCode).toBe(403);
    expect(verify.json().error).toBe('team_account');
    expect(await tokens()).toBe(tokensBefore);
    // And a token for it, however it was made, opens nothing: role-only checks (routes/activities.ts) never see it.
    for (const [method, url] of [['GET', '/me'], ['GET', '/chats'], ['POST', `/activities/${coffee}/advance-recurrence`]]) {
      const r = await as(hostId)(method, url);
      expect([url, r.statusCode, r.json().error]).toEqual([url, 403, 'team_account']);
    }
  });
});

describe('nobody can look like the Host', () => {
  let me: ReturnType<typeof as>;
  beforeAll(async () => { me = as(await person('copycat', { name: 'Kiran', at: PUNE, created: ago(400 * DAY) })); });

  it('a person can\'t take a name that reads like the team account\'s', async () => {
    for (const name of ['Tablamigo Host (Team)', 'tablamigo', 'Tabla-migo Support', 'Tabla Migo', 'Tab1amigo', 'Tablämigo', 'Таblаmigo Host', 'Ｔａｂｌａｍｉｇｏ', 'Kiran (Team)', 'Kiran [team]', 'Official Help Desk', 'Kiran official',
      // I or 1 for l (and i for l, so "Tablamlgo"), rn for m, script ɡ and ɑ, small capitals, stroke letters, maths letters,
      // a zero-width space, and "0fficia1".
      'TabIamigo Host', 'Tablam1go Host', 'Tablarnigo Host', 'Tablamiɡo Host', 'Tablamlgo', 'Tab|am!go', 'Tɑblɑmigo', 'ᴛᴀʙʟᴀᴍɪɢᴏ', 'Tabłamigo',
      '𝐓𝐚𝐛𝐥𝐚𝐦𝐢𝐠𝐨', 'Tablami9o', 'Tablar nigo', 'Kiran (Tearn)', 'Kiran (te\u200bam)', '0fficia1 Support']) {
      const r = await me('PATCH', '/me', { name });
      expect([name, r.statusCode, r.json().error]).toEqual([name, 400, 'team_name']);
    }
    expect((await sql`select name from users where id = ${id.copycat}`)[0].name).toBe('Kiran');
    // Ordinary names that share letters with it stay fine, including ones the I/l and rn folds touch.
    for (const name of ['Kiran Mehta', 'Teamwork Tom', 'Kiran (team lead)', 'Officially Kiran', 'Tabla Mia', 'Amigo', 'Tamil', 'Milo', 'Tabla Amigo',
      'Lila Iyer', 'Kamil', 'Arnav', 'Bernard', 'Ilona', 'Amit Lal', 'Таня']) {
      expect([name, (await me('PATCH', '/me', { name })).statusCode]).toEqual([name, 200]);
    }
  });

  it('a person can\'t use the Host\'s avatar or any other image of the site as a photo', async () => {
    const [h] = await sql`select photo_url from users where id = ${hostId}`;
    for (const photoUrl of [h.photoUrl, 'https://tablamigo.hookstep.in/icon-192.png?v=2', 'http://TABLAMIGO.hookstep.in/icon-512.png', 'https://tablamigo.hookstep.in./favicon.png']) {
      const r = await me('PATCH', '/me', { photoUrl });
      expect([photoUrl, r.statusCode, r.json().error]).toEqual([photoUrl, 400, 'team_photo']);
      const p = await me('POST', '/me/photos', { url: photoUrl });
      expect([photoUrl, p.statusCode, p.json().error]).toEqual([photoUrl, 400, 'team_photo']);
    }
    expect(await sql`select 1 from user_photos where user_id = ${id.copycat}`).toEqual([]);
    const own = (await me('POST', '/uploads/image', { kind: 'avatar', contentType: 'image/jpeg' })).json().publicUrl;
    expect((await me('PATCH', '/me', { photoUrl: own })).statusCode).toBe(200);
  });

  it('a name already on the account is left alone, so the app re-sending a profile still saves the rest', async () => {
    await sql`update users set name = 'Tablamigo fan' where id = ${id.copycat}`;
    const r = await me('PATCH', '/me', { name: 'Tablamigo fan', bio: 'Chai and long walks' });
    expect(r.statusCode).toBe(200);
    expect((await sql`select name, bio from users where id = ${id.copycat}`)[0]).toEqual({ name: 'Tablamigo fan', bio: 'Chai and long walks' });
  });
});
