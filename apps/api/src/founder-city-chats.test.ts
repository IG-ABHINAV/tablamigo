// scripts/seed-founder-city-chats.ts: the founder's real account is in each popular city's canonical chat with one pinned welcome,
// every key a person can arrive under (typed in a trip, a GPS point, the guide page) opens that one chat through
// city_chat_aliases, and the script adds nothing the second time, never touches a women's chat, and sends nothing. A muted member
// gets no push for a chat message.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const PEOPLE = ['fs_founder', 'fs_maya', 'fs_david', 'fs_nina'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@fs.tablamigo`).join(',');
process.env.REVIEW_CODE = '135790';
const { notify } = vi.hoisted(() => ({ notify: vi.fn() }));
vi.mock('./lib/push.js', async orig => ({ ...(await orig<any>()), notify }));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { cityKey } = await import('./lib/geo.js');
const { seedFounderCityChats, welcomeFor, CITIES } = await import('./scripts/seed-founder-city-chats.js');
type Entry = import('./scripts/seed-founder-city-chats.js').Entry;

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<Awaited<ReturnType<typeof app.inject>>>;

let ip = 3700;
async function login(name: string, gender: 'woman' | 'man'): Promise<Api> {
  const email = `${name}@fs.tablamigo`;
  const remoteAddress = `10.95.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '135790' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1990-01-01', gender, homeCountry: 'IN' });
  return call;
}
const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@fs.tablamigo'}`)[0].id as string;

// Points a long way from any real city (so their geo_cache cells are ours), and what Nominatim "says" for each one.
const TEST_CITIES: Entry[] = [
  { city: 'Seedville', key: 'seedville-zz', aliases: ['seedtown-zz'], points: [
    { label: 'centre', lat: 61.0, lng: -149.0 }, { label: 'heights', lat: 62.0, lng: -150.0 }, { label: 'nowhere', lat: 66.0, lng: -154.0 }] },
  { city: 'Tokyo', key: 'tokyo-jp', aliases: [], points: [{ label: 'centre', lat: 63.0, lng: -151.0 }, { label: 'Shibuya', lat: 64.0, lng: -152.0 }] },
];
const NOMINATIM: Record<number, object> = {
  61: { city: 'Seedville', country_code: 'zz' }, 62: { city: 'Seedville Heights', country_code: 'zz' },
  63: { city: 'Suginami', country_code: 'jp' }, 64: { city: 'Shibuya', country_code: 'jp' },
};
const CELLS = ['61,-149', '62,-150', '66,-154', '63,-151', '64,-152'];
const ALIASES = ['seedville-heights-zz', 'seedtown-zz', 'suginami-jp', 'shibuya-jp'];
const KEYS = ['seedville-zz', 'seedville-heights-zz', 'seedtown-zz', 'tokyo-jp', 'suginami-jp', 'shibuya-jp'].flatMap(k => [k, k + ':women']);
const wipe = async () => {
  await sql`delete from chats where kind = 'city' and city_key in ${sql(KEYS)}`;
  await sql`delete from geo_cache where cell in ${sql(CELLS)}`;
  await sql`delete from city_chat_aliases where alias_key in ${sql(ALIASES)}`;
};
const counts = async () => {
  const [c] = await sql`select (select count(*)::int from chats where city_key in ${sql(KEYS)}) as chats,
    (select count(*)::int from messages m join chats c on c.id = m.chat_id where c.city_key in ${sql(KEYS)}) as messages,
    (select count(*)::int from chat_members cm join chats c on c.id = cm.chat_id where c.city_key in ${sql(KEYS)}) as members,
    (select count(*)::int from city_chat_aliases where alias_key in ${sql(ALIASES)}) as aliases`;
  return c;
};
const chatOf = async (key: string) => (await sql`select id, title, women_only, pinned_message_id from chats where city_key = ${key}`)[0];

const u: Record<string, Api> = {};
let founderId: string;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@fs.tablamigo'`;
  await wipe();
  u.fs_founder = await login('fs_founder', 'man');
  u.fs_maya = await login('fs_maya', 'woman');
  u.fs_david = await login('fs_david', 'man');
  u.fs_nina = await login('fs_nina', 'man');
  founderId = await idOf('fs_founder');
  await sql`update users set plus_until = now() + interval '30 days' where email like '%@fs.tablamigo'`;
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify({ address: NOMINATIM[Math.round(Number(/lat=(-?[\d.]+)/.exec(url)![1]))] ?? {} }), { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await wipe();
  await sql`delete from users where email like '%@fs.tablamigo'`;
  await app.close();
  await sql.end();
});

// Rows the seed script could write for this file: notices to or from its accounts, or about its city chats.
const mine = sql`(select id from users where email like '%@fs.tablamigo')`;
const ours = sql`where user_id in ${mine} or actor_id in ${mine} or chat_id in (select id from chats where kind = 'city' and city_key in ${sql(KEYS)})`;
const run = (commit: boolean) => seedFounderCityChats({ email: 'fs_founder@fs.tablamigo', commit, cities: TEST_CITIES });

describe('the list of cities', () => {
  it('every canonical key is the plain-name cityKey, or the guide chat_key for a guide city', async () => {
    const guides = new Map((await sql`select city, chat_key from city_guides`).map(g => [g.chatKey as string, g.city as string]));
    for (const c of CITIES) {
      const ascii = c.city.normalize('NFD').replace(/\p{M}/gu, '');
      const cc = c.key.split('-').pop()!.toUpperCase();
      if (guides.has(c.key)) expect(c.city, c.key).toBe(guides.get(c.key));
      else expect(c.key, c.city).toBe(cityKey(ascii, cc));
    }
    for (const g of guides.keys()) if (['goa-in', 'bali-id', 'delhi-in', 'bangalore-in'].includes(g)) expect(CITIES.some(c => c.key === g), g).toBe(true);
  });

  it('no city repeats a key, an alias is never a canonical key, and every point is a real coordinate', () => {
    const keys = CITIES.map(c => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    const typed = CITIES.flatMap(c => c.aliases);
    expect(new Set(typed).size).toBe(typed.length);
    for (const a of typed) { expect(keys).not.toContain(a); expect(a).not.toContain(':'); }
    for (const c of CITIES) for (const p of c.points) { expect(Math.abs(p.lat)).toBeLessThanOrEqual(90); expect(Math.abs(p.lng)).toBeLessThanOrEqual(180); }
    expect(CITIES.find(c => c.key === 'tokyo-jp')!.points.map(p => p.label)).toEqual(['centre', 'Shibuya', 'Shinjuku', 'Asakusa']);
  });
});

describe('founder welcome in city chats', () => {
  it('a dry run reports keys and aliases and writes no chat, member, message or alias', async () => {
    const before = await counts();
    const { results } = await run(false);
    expect(results.map(r => [r.key, r.chat, r.welcome, r.aliases.map(a => `${a.key}:${a.status}`), r.points.filter(p => p.skipped).map(p => p.label)])).toEqual([
      ['seedville-zz', 'would-create', 'would-post', ['seedville-heights-zz:would-add', 'seedtown-zz:would-add'], ['nowhere']],
      ['tokyo-jp', 'would-create', 'would-post', ['suginami-jp:would-add', 'shibuya-jp:would-add'], []],
    ]);
    expect(await counts()).toEqual(before);
    expect(before).toEqual({ chats: 0, messages: 0, members: 0, aliases: 0 });
    expect(notify).not.toHaveBeenCalled();
  });

  it('refuses to write when the founder account does not exist', async () => {
    await expect(seedFounderCityChats({ email: 'nobody@fs.tablamigo', commit: true, cities: TEST_CITIES })).rejects.toThrow(/No active account/);
    expect(await counts()).toEqual({ chats: 0, messages: 0, members: 0, aliases: 0 });
  });

  it('folds a chat that already sits under an alias key into the canonical one, women\'s chat included', async () => {
    const [{ id: old }] = await sql`insert into chats (kind, city_key, title, last_message_at) values ('city', 'seedville-heights-zz', 'Seedville Heights travelers', now()) returning id`;
    const [{ id: oldW }] = await sql`insert into chats (kind, city_key, title, women_only, last_message_at) values ('city', 'seedville-heights-zz:women', 'Heights Women Nomads', true, now()) returning id`;
    const maya = await idOf('fs_maya'), david = await idOf('fs_david');
    await sql`insert into chat_members (chat_id, user_id) values (${old}, ${david}), (${oldW}, ${maya})`;
    await sql`insert into messages (chat_id, sender_id, body) values (${old}, ${david}, 'anyone for a walk?'), (${oldW}, ${maya}, 'anyone for chai?')`;
    const { results } = await seedFounderCityChats({ email: 'fs_founder@fs.tablamigo', commit: true, cities: [TEST_CITIES[0]] });
    expect(results[0].folded).toBe(2);
    expect((await sql`select 1 from chats where city_key in ('seedville-heights-zz', 'seedville-heights-zz:women')`).length).toBe(0);
    const general = await chatOf('seedville-zz');
    expect(general.id).toBe(old);   // no canonical chat existed yet: the old one was renamed, not copied
    expect((await sql`select sender_id from messages where chat_id = ${general.id} order by id`).map(m => m.senderId)).toEqual([david, founderId]);
    expect((await sql`select user_id from chat_members where chat_id = ${general.id}`).map(m => m.userId).sort()).toEqual([david, founderId].sort());
    const women = await chatOf('seedville-zz:women');
    expect(women).toMatchObject({ id: oldW, womenOnly: true });
    expect((await sql`select body from messages where chat_id = ${oldW}`).map(m => m.body)).toEqual(['anyone for chai?']);
  });

  it('creates one pinned welcome from the founder, muted, and the aliases, and sends nothing', async () => {
    notify.mockClear();
    // Scoped to this file's accounts and city chats: global counts moved whenever another file ran in parallel (flaky on main).
    const [{ n: notifs }] = await sql`select count(*)::int as n from notifications ${ours}`;
    const [{ n: events }] = await sql`select count(*)::int as n from analytics_events where event_name = 'message_sent' and user_id in ${mine}`;
    const { results } = await run(true);
    expect(results.map(r => [r.key, r.chat, r.welcome, r.aliases.map(a => `${a.key}:${a.status}`)])).toEqual([
      ['seedville-zz', 'existing', 'already-there', ['seedville-heights-zz:exists', 'seedtown-zz:exists']],   // the fold run above did it
      ['tokyo-jp', 'created', 'posted', ['suginami-jp:added', 'shibuya-jp:added']],
    ]);
    expect(await sql`select alias_key, canonical_key from city_chat_aliases where alias_key in ${sql(ALIASES)} order by alias_key`).toEqual([
      { aliasKey: 'seedtown-zz', canonicalKey: 'seedville-zz' }, { aliasKey: 'seedville-heights-zz', canonicalKey: 'seedville-zz' },
      { aliasKey: 'shibuya-jp', canonicalKey: 'tokyo-jp' }, { aliasKey: 'suginami-jp', canonicalKey: 'tokyo-jp' },
    ]);

    const tokyo = await chatOf('tokyo-jp');
    expect(tokyo).toMatchObject({ title: 'Tokyo travelers', womenOnly: false });
    const msgs = await sql`select id, sender_id, kind, body from messages where chat_id = ${tokyo.id}`;
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ senderId: founderId, kind: 'text', body: welcomeFor('Tokyo') });
    expect(msgs[0].body).toContain('Hi, I\'m Jatinder, I built Tablamigo 👋 This is the chat for travellers in Tokyo.');
    expect(tokyo.pinnedMessageId).toBe(msgs[0].id);
    expect(await sql`select user_id, muted from chat_members where chat_id = ${tokyo.id}`).toEqual([{ userId: founderId, muted: true }]);

    // The script pushes nothing, writes no inbox row and no "message_sent" event.
    expect(notify).not.toHaveBeenCalled();
    expect((await sql`select count(*)::int as n from notifications ${ours}`)[0].n).toBe(notifs);
    expect((await sql`select count(*)::int as n from analytics_events where event_name = 'message_sent' and user_id in ${mine}`)[0].n).toBe(events);
  });

  it('a person in Shibuya (GPS) and a person with a trip typed "Tokyo" land in the same chat and both see the pinned welcome', async () => {
    const tokyo = await chatOf('tokyo-jp');
    const gps = (await u.fs_david('POST', '/chats/city-here', { lat: 64.001, lng: -152.001 })).json();   // Nominatim: Shibuya
    const centre = (await u.fs_nina('POST', '/chats/city-here', { lat: 63.001, lng: -151.001 })).json();   // Nominatim: Suginami
    const trip = (await u.fs_maya('POST', '/trips', { city: 'Tokyo', countryCode: 'JP', startDate: '2026-12-01', endDate: '2026-12-08' })).json();
    const typed = (await u.fs_maya('POST', `/trips/${trip.id}/city-chat`, {})).json();
    const shibuyaTrip = (await u.fs_nina('POST', '/trips', { city: 'Shibuya', countryCode: 'JP', startDate: '2026-12-01', endDate: '2026-12-08' })).json();
    const typedWard = (await u.fs_nina('POST', `/trips/${shibuyaTrip.id}/city-chat`, {})).json();
    expect([gps.chatId, centre.chatId, typed.chatId, typedWard.chatId]).toEqual([tokyo.id, tokyo.id, tokyo.id, tokyo.id]);
    expect(gps.city).toBe('Shibuya');   // what the caller is told is still the place name; the chat is Tokyo's

    for (const person of [u.fs_david, u.fs_maya]) {
      const read = (await person('GET', `/chats/${tokyo.id}/messages`)).json();
      expect(read.messages.map((m: any) => m.body)).toEqual([welcomeFor('Tokyo')]);
      expect(read.chat.pinnedMessage).toMatchObject({ body: welcomeFor('Tokyo'), senderName: 'fs_founder' });
    }
    // Nobody's visit renamed it, and no chat was made under the other keys.
    expect((await chatOf('tokyo-jp')).title).toBe('Tokyo travelers');
    expect((await sql`select 1 from chats where city_key in ('shibuya-jp', 'suginami-jp', 'shibuya-jp:women')`).length).toBe(0);
  });

  it('a trip typed "Bengaluru" opens the Bangalore guide\'s chat', async () => {
    const trip = (await u.fs_david('POST', '/trips', { city: 'Bengaluru', countryCode: 'IN', startDate: '2026-12-01', endDate: '2026-12-08' })).json();
    const typed = (await u.fs_david('POST', `/trips/${trip.id}/city-chat`, {})).json();
    const guide = (await u.fs_nina('POST', '/cities/bangalore/join-chat', {})).json();
    expect(typed.chatId).toBe(guide.chatId);
    expect((await sql`select city_key from chats where id = ${typed.chatId}`)[0].cityKey).toBe('bangalore-in');
    expect((await sql`select 1 from chats where city_key = 'bengaluru-in'`).length).toBe(0);
  });

  it('a second run adds nothing', async () => {
    const before = await counts();
    const [pin] = await sql`select pinned_message_id from chats where city_key = 'tokyo-jp'`;
    const { results } = await run(true);
    expect(results.map(r => [r.chat, r.welcome, r.folded, r.aliases.map(a => a.status)])).toEqual([
      ['existing', 'already-there', 0, ['exists', 'exists']], ['existing', 'already-there', 0, ['exists', 'exists']],
    ]);
    expect(await counts()).toEqual(before);
    expect((await sql`select pinned_message_id from chats where city_key = 'tokyo-jp'`)[0]).toEqual(pin);
    expect(notify).not.toHaveBeenCalled();
  });

  it('puts him back to muted, and leaves a pin somebody else set alone', async () => {
    const chat = await chatOf('tokyo-jp');
    await sql`update chat_members set muted = false where chat_id = ${chat.id} and user_id = ${founderId}`;
    const [other] = await sql`insert into messages (chat_id, sender_id, body) values (${chat.id}, ${await idOf('fs_david')}, 'meet at the station?') returning id`;
    await sql`delete from messages where chat_id = ${chat.id} and sender_id = ${founderId}`;   // welcome gone: it is posted again
    await sql`update chats set pinned_message_id = ${other.id} where id = ${chat.id}`;
    const { results } = await run(true);
    expect(results.find(r => r.key === 'tokyo-jp')).toMatchObject({ chat: 'existing', welcome: 'pinned-elsewhere' });
    expect((await sql`select muted from chat_members where chat_id = ${chat.id} and user_id = ${founderId}`)[0].muted).toBe(true);
    expect((await chatOf('tokyo-jp')).pinnedMessageId).toBe(other.id);
    expect((await sql`select count(*)::int as n from messages where chat_id = ${chat.id} and sender_id = ${founderId}`)[0].n).toBe(1);
  });

  it('never touches a women-only chat', async () => {
    const women = await chatOf('seedville-zz:women');
    const snapshot = async () => ({
      chat: (await sql`select title, women_only, pinned_message_id, last_message_at from chats where id = ${women.id}`)[0],
      members: await sql`select user_id, muted from chat_members where chat_id = ${women.id}`,
      messages: await sql`select id, sender_id, body from messages where chat_id = ${women.id}`,
    });
    const before = await snapshot();
    await run(true);
    await run(true);
    expect(await snapshot()).toEqual(before);
    expect(before.members.some(m => m.userId === founderId)).toBe(false);
    expect((await chatOf('seedville-zz')).womenOnly).toBe(false);
    expect((await chatOf('tokyo-jp:women'))).toBeUndefined();
  });
});

describe('a muted member gets no push for a chat message', () => {
  it('the founder, muted, is left out, and an unmuted member is not', async () => {
    const chat = await chatOf('tokyo-jp');
    const [maya, david] = [await idOf('fs_maya'), await idOf('fs_david')];
    notify.mockClear();
    expect((await u.fs_david('POST', `/chats/${chat.id}/messages`, { body: 'Anyone up for ramen tonight?' })).statusCode).toBe(200);
    expect(notify).toHaveBeenCalledTimes(1);
    const [to, payload] = notify.mock.calls[0] as [string[], { body: string; data: { chatId: string } }];
    expect(to).toContain(maya);
    expect(to).not.toContain(founderId);
    expect(to).not.toContain(david);   // the sender, as before
    expect(payload).toMatchObject({ body: expect.stringContaining('Anyone up for ramen tonight?'), data: { chatId: chat.id } });

    // Unmuting brings the push back: it is the mute that kept him out.
    await sql`update chat_members set muted = false where chat_id = ${chat.id} and user_id = ${founderId}`;
    notify.mockClear();
    await u.fs_david('POST', `/chats/${chat.id}/messages`, { body: 'Or sushi?' });
    expect((notify.mock.calls[0] as [string[]])[0]).toContain(founderId);
  });
});
