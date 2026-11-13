// One key for a city chat: the city's cityKey ('bangkok-th'), whichever way a person gets in (the city guide page, a
// trip, "the chat where I am") and whichever key the guide page is given (slug or cityKey). Chats that still sit under an
// old guide slug ('delhi') are adopted by the next join and folded in by migration 055 (lib/city-chats.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';

const PEOPLE = ['ck_maya', 'ck_david', 'ck_nina', 'ck_oscar'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@ck.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { cityKey } = await import('./lib/geo.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<Awaited<ReturnType<typeof app.inject>>>;

let ip = 3300;
async function login(name: string, gender: 'woman' | 'man'): Promise<Api> {
  const email = `${name}@ck.tablamigo`;
  const remoteAddress = `10.96.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1996-06-06', gender, homeCountry: 'IN' });
  return call;
}
const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@ck.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};
const KEYS = ['bangkok', 'bangkok:women', 'bangkok-th', 'bangkok-th:women', 'delhi', 'delhi:women', 'delhi-in', 'delhi-in:women'];
const wipe = () => sql`delete from chats where kind = 'city' and city_key in ${sql(KEYS)}`;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@ck.tablamigo'`;
  await wipe();
  await sql`insert into geo_cache (cell, city, country) values ('13.75,100.55', 'Bangkok', 'TH') on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = now()`;
  u.ck_maya = await login('ck_maya', 'woman');
  u.ck_david = await login('ck_david', 'man');
  u.ck_nina = await login('ck_nina', 'woman');
  u.ck_oscar = await login('ck_oscar', 'man');
  // Plus: the free city-chat window is not what is tested here.
  await sql`update users set plus_until = now() + interval '30 days' where email like '%@ck.tablamigo'`;
});

afterAll(async () => {
  await wipe();
  await sql`delete from users where email like '%@ck.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('city chat keys', () => {
  it('every city guide carries the chat key lib/geo.ts cityKey() builds for it', async () => {
    const guides = await sql`select slug, city, country_code, chat_key from city_guides`;
    expect(guides.length).toBeGreaterThanOrEqual(8);
    for (const g of guides) expect(g.chatKey, g.slug).toBe(cityKey(g.city, g.countryCode));
    expect(new Set(guides.map(g => g.chatKey)).size).toBe(guides.length);
  });

  it('the guide page (by slug or by cityKey), a trip and "where I am" open the same chat, under the cityKey', async () => {
    const bySlug = (await u.ck_david('POST', '/cities/bangkok/join-chat', {})).json();
    expect(bySlug.title).toBe('Bangkok travelers');
    const byKey = (await u.ck_maya('POST', '/cities/bangkok-th/join-chat', {})).json();
    const here = (await u.ck_nina('POST', '/chats/city-here', { lat: 13.7468, lng: 100.5349 })).json();
    const trip = (await u.ck_oscar('POST', '/trips', { city: 'Bangkok', countryCode: 'TH', startDate: '2026-12-01', endDate: '2026-12-08', lat: 13.7466, lng: 100.5346 })).json();
    const byTrip = (await u.ck_oscar('POST', `/trips/${trip.id}/city-chat`, {})).json();
    expect([byKey.chatId, here.chatId, byTrip.chatId]).toEqual([bySlug.chatId, bySlug.chatId, bySlug.chatId]);
    expect((await sql`select city_key from chats where id = ${bySlug.chatId}`)[0].cityKey).toBe('bangkok-th');
    expect((await sql`select count(*)::int as n from chat_members where chat_id = ${bySlug.chatId}`)[0].n).toBe(4);
    // nothing is created under the guide slug any more
    expect((await sql`select count(*)::int as n from chats where city_key in ('bangkok', 'bangkok:women')`)[0].n).toBe(0);

    // the guide and the guide list point at that chat too, whichever id the page was opened with
    for (const id of ['bangkok', 'bangkok-th']) {
      const g = (await u.ck_david('GET', `/cities/${id}`)).json();
      expect(g.slug, id).toBe('bangkok');
      expect(g.chatId, id).toBe(bySlug.chatId);
    }
    const list = (await u.ck_david('GET', '/cities')).json().cities as any[];
    expect(list.find(c => c.slug === 'bangkok').chatId).toBe(bySlug.chatId);
  });

  it('the women\'s chat is one chat too, and still only for women', async () => {
    const a = (await u.ck_maya('POST', '/cities/bangkok/join-chat', { womenOnly: true })).json();
    const trip = (await u.ck_nina('POST', '/trips', { city: 'Bangkok', countryCode: 'TH', startDate: '2026-12-02', endDate: '2026-12-09', lat: 13.7466, lng: 100.5346 })).json();
    const b = (await u.ck_nina('POST', `/trips/${trip.id}/city-chat`, { womenOnly: true })).json();
    const c = (await u.ck_nina('POST', '/chats/city-here', { lat: 13.7468, lng: 100.5349, womenOnly: true })).json();
    expect(b.chatId).toBe(a.chatId);
    expect(c.chatId).toBe(a.chatId);
    const [row] = await sql`select city_key, women_only from chats where id = ${a.chatId}`;
    expect(row.cityKey).toBe('bangkok-th:women');
    expect(row.womenOnly).toBe(true);
    expect((await u.ck_david('POST', '/cities/bangkok-th/join-chat', { womenOnly: true })).statusCode).toBe(403);
  });

  it('a stray chat under the old guide slug is adopted by the next join, with its members and its id', async () => {
    await wipe();
    const [old] = await sql`insert into chats (kind, city_key, title, women_only, last_message_at) values ('city', 'delhi', 'Delhi travelers', false, now()) returning id`;
    await sql`insert into chat_members (chat_id, user_id) values (${old.id}, ${await idOf('ck_oscar')})`;
    const joined = (await u.ck_david('POST', '/cities/delhi/join-chat', {})).json();
    expect(joined.chatId).toBe(old.id);
    expect((await sql`select city_key from chats where id = ${old.id}`)[0].cityKey).toBe('delhi-in');
    expect((await sql`select count(*)::int as n from chat_members where chat_id = ${old.id}`)[0].n).toBe(2);
    expect((await sql`select count(*)::int as n from chats where city_key = 'delhi'`)[0].n).toBe(0);
  });

  it('migration 055 renames a lone legacy chat, merges one that has a canonical twin, and does nothing the second time', async () => {
    await wipe();
    const text = fs.readFileSync(new URL('./db/migrations/055_city_chat_canonical_keys.sql', import.meta.url), 'utf8');
    const maya = await idOf('ck_maya'), david = await idOf('ck_david'), nina = await idOf('ck_nina'), oscar = await idOf('ck_oscar');
    const mk = async (key: string, women = false) => (await sql`insert into chats (kind, city_key, title, women_only, last_message_at) values ('city', ${key}, ${key}, ${women}, now()) returning id`)[0].id as string;
    const say = async (chat: string, who: string, body: string, ago: string) =>
      (await sql`insert into messages (chat_id, sender_id, kind, body, created_at) values (${chat}, ${who}, 'text', ${body}, now() - ${ago}::interval) returning id`)[0].id;

    // Delhi (general): a legacy chat and a canonical one, both with people and messages; Maya is in both.
    const legacy = await mk('delhi'), canon = await mk('delhi-in');
    for (const [chat, who] of [[legacy, maya], [legacy, david], [canon, maya], [canon, nina]] as const) await sql`insert into chat_members (chat_id, user_id) values (${chat}, ${who})`;
    const m1 = await say(legacy, david, 'Hauz Khas tonight?', '2 hours'), m2 = await say(canon, nina, 'Count me in', '1 hour');
    await sql`insert into notifications (user_id, kind, chat_id, body) values (${maya}, 'join', ${legacy}, 'someone wrote in Delhi travelers')`;
    // Delhi (women): only a legacy chat, with one member.
    const womenLegacy = await mk('delhi:women', true);
    await sql`insert into chat_members (chat_id, user_id) values (${womenLegacy}, ${nina})`;

    await sql.unsafe(text);
    expect((await sql`select count(*)::int as n from chats where city_key in ('delhi', 'delhi:women')`)[0].n).toBe(0);

    // merged into the canonical chat: the union of members (Maya once), both messages, the notification, no shell left
    expect((await sql`select user_id from chat_members where chat_id = ${canon} order by user_id`).map(r => r.userId).sort()).toEqual([maya, david, nina].sort());
    expect((await sql`select id from messages where chat_id = ${canon} order by id`).map(r => r.id)).toEqual([m1, m2]);
    expect((await sql`select count(*)::int as n from notifications where chat_id = ${canon}`)[0].n).toBe(1);
    expect((await sql`select count(*)::int as n from chats where id = ${legacy}`)[0].n).toBe(0);
    // renamed in place: same id, same member, still women-only
    const [w] = await sql`select city_key, women_only from chats where id = ${womenLegacy}`;
    expect(w.cityKey).toBe('delhi-in:women');
    expect(w.womenOnly).toBe(true);
    expect((await sql`select count(*)::int as n from chat_members where chat_id = ${womenLegacy}`)[0].n).toBe(1);

    // again: nothing changes
    const snapshot = async () => JSON.stringify([
      await sql`select id, city_key from chats where city_key like 'delhi%' order by id`,
      await sql`select chat_id, user_id from chat_members where chat_id in (${canon}, ${womenLegacy}) order by chat_id, user_id`,
      await sql`select id, chat_id from messages where chat_id = ${canon} order by id`,
    ]);
    const before = await snapshot();
    await sql.unsafe(text);
    expect(await snapshot()).toBe(before);
    void oscar;
  });
});
