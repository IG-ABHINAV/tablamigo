// Paywall moments: DM limits, the contact shield, the Trip Pass count on a new trip, and Plus-first ranking.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const PEOPLE = ['ann', 'bo', 'cy', 'di', 'ed', 'flo', 'gus', 'hal', 'ivy', 'jo'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@pay.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { LIMITS } = await import('./lib/plus.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;
const HERE = { lat: 38.7223, lng: -9.1393 }; // Lisbon
const iso = (days: number) => { const d = new Date(); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };

let ip = 0;
async function login(name: string): Promise<Api> {
  const email = `${name}@pay.tablamigo`; const remoteAddress = `10.88.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1993-03-03', gender: 'woman', homeCountry: 'pt' });
  return call;
}
const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@pay.tablamigo'}`)[0].id as string;
const setPlus = (name: string, on = true) => sql`update users set plus_until = ${on ? sql`now() + interval '7 days'` : null} where email = ${name + '@pay.tablamigo'}`;
const openDm = async (from: Api, to: string) => from('POST', `/dm/${await idOf(to)}`);
const say = (who: Api, chatId: string, body: string) => who('POST', `/chats/${chatId}/messages`, { body });

const u: Record<string, Api> = {};
beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@pay.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});
afterAll(async () => { await sql`delete from users where email like '%@pay.tablamigo'`; await app.close(); await sql.end(); });

describe('DM limits (free tier)', () => {
  it('a free user starts 1 conversation a day and sends 3 messages until the other replies', async () => {
    expect(LIMITS.free).toMatchObject({ dmStartsPerDay: 1, dmMessagesBeforeReply: 3 });
    const chat = (await openDm(u.ann, 'bo')).json().chatId as string;
    expect((await u.ann('GET', `/chats/${chat}/messages`)).json().chat.gate).toMatchObject({ canSend: true, remaining: 3, open: null, contacts: false });
    for (const m of ['Hi Bo!', 'Are you in Lisbon next week?', 'Fancy a pastel de nata?']) expect((await say(u.ann, chat, m)).statusCode).toBe(200);
    const blocked = await say(u.ann, chat, 'Hello?');
    expect(blocked.statusCode).toBe(402);
    expect(blocked.json()).toMatchObject({ error: 'dm_wait_reply', feature: 'dm', name: 'bo' });
    expect(blocked.json().message).toMatch(/Wait for bo to reply/);
    // live location counts as a message too
    expect((await u.ann('POST', `/chats/${chat}/locations`, { ...HERE, minutes: 15 })).json().error).toBe('dm_wait_reply');

    // A second new conversation the same day: refused before an empty chat is created.
    const second = await openDm(u.ann, 'cy');
    expect(second.statusCode).toBe(402);
    expect(second.json().error).toBe('dm_limit');
    const key = [await idOf('ann'), await idOf('cy')].sort().join(':');
    expect(await sql`select 1 from chats where dm_key = ${key}`).toHaveLength(0);

    // Replying is free and unlimited, for the person replying and then for both.
    for (let i = 0; i < 5; i++) expect((await say(u.bo, chat, `reply ${i}`)).statusCode).toBe(200);
    expect((await u.bo('GET', `/chats/${chat}/messages`)).json().chat.gate).toMatchObject({ canSend: true, open: 'reply', remaining: null });
    expect((await say(u.ann, chat, 'Great, see you there')).statusCode).toBe(200);
    expect((await u.ann('GET', `/chats/${chat}/messages`)).json().chat.gate.open).toBe('reply');
  });

  it('replying to someone who wrote first is free even with the daily start used up', async () => {
    const chat = (await openDm(u.cy, 'ann')).json().chatId as string; // cy's own first start today
    expect((await say(u.cy, chat, 'Hey Ann, saw your plan')).statusCode).toBe(200);
    for (let i = 0; i < 4; i++) expect((await say(u.ann, chat, `answer ${i}`)).statusCode).toBe(200);
    // Opening an existing DM never counts as a new start.
    expect((await openDm(u.ann, 'cy')).statusCode).toBe(200);
  });

  it('the daily start comes back after 24 hours', async () => {
    await sql`update dm_starts set created_at = now() - interval '25 hours' where user_id = ${await idOf('ann')}`;
    const r = await openDm(u.ann, 'hal');
    expect(r.statusCode).toBe(200);
    expect((await say(u.ann, r.json().chatId, 'Hi Hal')).statusCode).toBe(200);
    expect((await openDm(u.ann, 'ivy')).json().error).toBe('dm_limit');
  });

  it('people who share a plan DM freely, and can share contact details', async () => {
    const plan = (await u.di('POST', '/activities', { title: 'Sunset at Miradouro', category: 'explore', placeName: 'Miradouro da Graca', ...HERE, startsAt: new Date(Date.now() + 5 * 3600_000).toISOString() })).json();
    expect((await u.ann('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
    // ann's start for today is used, but di is from her plan
    const chat = (await openDm(u.ann, 'di')).json().chatId as string;
    expect((await u.ann('GET', `/chats/${chat}/messages`)).json().chat.gate).toMatchObject({ open: 'shared_plan', contacts: true });
    for (let i = 0; i < 5; i++) expect((await say(u.ann, chat, `msg ${i}`)).statusCode).toBe(200);
    expect((await say(u.ann, chat, 'my number is 98765 43210')).statusCode).toBe(200);
    // and in the plan group chat anyone can share, Plus or not
    expect((await say(u.ann, plan.chatId, 'whatsapp me on +351 912 345 678')).statusCode).toBe(200);
  });

  it('Plus has no DM limits and no shield', async () => {
    await setPlus('ed');
    for (const to of ['flo', 'gus', 'jo']) {
      const chat = (await openDm(u.ed, to)).json().chatId as string;
      for (let i = 0; i < 5; i++) expect((await say(u.ed, chat, `hello ${i}`)).statusCode).toBe(200);
    }
    const chat = (await openDm(u.ed, 'flo')).json().chatId as string;
    expect((await say(u.ed, chat, 'insta: ed.travels')).statusCode).toBe(200);
    expect((await u.ed('GET', `/chats/${chat}/messages`)).json().chat.gate).toMatchObject({ open: 'plus', contacts: true, remaining: null });
    // Plus lapses: the next new conversation is metered again
    await setPlus('ed', false);
    const r = await openDm(u.ed, 'hal');
    expect(r.statusCode).toBe(200);
    for (let i = 0; i < 3; i++) expect((await say(u.ed, r.json().chatId, `hi ${i}`)).statusCode).toBe(200);
    expect((await say(u.ed, r.json().chatId, 'hi again')).json().error).toBe('dm_wait_reply');
  });
});

describe('contact shield', () => {
  it('holds back contact details from free users in DMs, including a number split across messages', async () => {
    const chat = (await openDm(u.flo, 'gus')).json().chatId as string;
    const r = await say(u.flo, chat, 'text me on nine eight seven six five four three two one zero');
    expect(r.statusCode).toBe(403);
    expect(r.json()).toMatchObject({ error: 'contact_shield', feature: 'contacts', kind: 'phone', message: "For your safety, contact details unlock with Plus or once you've both joined the same plan." });
    expect((await say(u.flo, chat, 'maria at gmail dot com')).json().error).toBe('contact_shield');
    // a blocked message is not stored and does not use up the 3 messages
    expect((await u.flo('GET', `/chats/${chat}/messages`)).json().messages).toHaveLength(0);
    expect((await say(u.flo, chat, 'dinner at 8? 2 people, around ₹1,500 each')).statusCode).toBe(200);
    expect((await say(u.flo, chat, 'my num 98765')).statusCode).toBe(200);
    expect((await say(u.flo, chat, '43210')).json().error).toBe('contact_shield');
    // the free reply is shielded too
    expect((await say(u.gus, chat, 'ig: gus_lisboa')).json()).toMatchObject({ error: 'contact_shield', kind: 'handle' });
    expect((await say(u.gus, chat, 'Sounds good, 8pm works')).statusCode).toBe(200);
  });

  it('city chats: contact details stay out for everyone, Plus included; polls too', async () => {
    await sql`insert into geo_cache (cell, city, country) values ('38.7,-9.15', 'Lisbon', 'PT') on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = now()`;
    const city = (await u.jo('POST', '/chats/city-here', { lat: 38.7, lng: -9.15 })).json().chatId as string;
    await u.ivy('POST', '/chats/city-here', { lat: 38.7, lng: -9.15 });
    const r = await say(u.jo, city, 'anyone for drinks? wa.me/351912345678');
    expect(r.statusCode).toBe(403);
    expect(r.json().message).toMatch(/city chats/);
    expect((await say(u.jo, city, 'Drinks at 9 in Bairro Alto, 4 of us so far')).statusCode).toBe(200);
    expect((await u.jo('POST', `/chats/${city}/polls`, { question: 'Where?', options: ['Bairro Alto', 'insta: jo.lx'] })).json().error).toBe('contact_shield');
    await setPlus('ivy');
    expect((await say(u.ivy, city, 'my insta is @ivy.lisbon')).statusCode).toBe(403);
    await sql`delete from geo_cache where cell = '38.7,-9.15'`;
  });
});

describe('Trip Pass at the moment of intent', () => {
  it('a free user adding a trip hears how many travellers are hidden; Plus members fill the preview', async () => {
    const trip = { city: 'Porto', countryCode: 'PT', startDate: iso(20), endDate: iso(25) };
    for (const p of ['bo', 'cy', 'di', 'ed', 'flo']) expect((await u[p]('POST', '/trips', trip)).statusCode).toBe(200);
    await setPlus('flo');
    const t = (await u.gus('POST', '/trips', trip)).json();
    expect(t).toMatchObject({ city: 'Porto', overlapCount: 5, hiddenCount: 2 });
    const ov = (await u.gus('GET', `/trips/${t.id}/overlaps`)).json();
    expect(ov).toMatchObject({ total: 5, locked: true, hiddenCount: 2 });
    expect(ov.travelers).toHaveLength(3);
    expect(ov.travelers[0]).toMatchObject({ name: 'flo', plus: true });
    // Plus sees everyone and nothing is hidden
    await setPlus('ivy');
    const pt = (await u.ivy('POST', '/trips', trip)).json();
    expect(pt).toMatchObject({ overlapCount: 6, hiddenCount: 0 });
  });
});

describe('Plus members get seen first', () => {
  it('ranks Plus above free at a similar distance, never above someone much closer', async () => {
    await sql`update users set plus_until = null, interests = '{}' where email like '%@pay.tablamigo'`;
    // hal (free) 1 km away, bo (Plus) 1.5 km away, cy (Plus) 12 km away, di (free) 2 km away
    const at = (km: number) => ({ lat: HERE.lat + km / 111, lng: HERE.lng });
    for (const [p, km] of [['hal', 1], ['bo', 1.5], ['cy', 12], ['di', 2]] as const) await u[p]('POST', '/me/location', at(km));
    await setPlus('bo'); await setPlus('cy');
    await u.jo('POST', '/me/location', HERE);
    const names = async (url: string) => (await u.jo('GET', url)).json().travelers.map((t: any) => t.name).filter((n: string) => ['hal', 'bo', 'cy', 'di'].includes(n));
    for (const url of [`/travelers?lat=${HERE.lat}&lng=${HERE.lng}`, `/travelers/nearby?lat=${HERE.lat}&lng=${HERE.lng}`]) expect(await names(url)).toEqual(['bo', 'hal', 'di', 'cy']);
    const bo = (await u.jo('GET', `/travelers?lat=${HERE.lat}&lng=${HERE.lng}`)).json().travelers.find((t: any) => t.name === 'bo');
    expect(bo.plus).toBe(true);
  });
});
