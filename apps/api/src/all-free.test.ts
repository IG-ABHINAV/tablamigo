// ALL_FREE (lib/config.ts): while on, every account gets Plus limits, no paywall error fires, nothing is sold and nobody is
// ranked or tagged for paying. Switched off, the free tier comes back exactly as before. The billing code stays dormant.
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
const PEOPLE = ['ana', 'ben', 'cas', 'dov', 'eli'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@free.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config, parseAllFree } = await import('./lib/config.js');
const { LIMITS, isPlus, limitsFor, launchOffer } = await import('./lib/plus.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;
const HERE = { lat: 12.9716, lng: 77.5946 }; // Bengaluru

let ip = 0;
async function login(name: string): Promise<Api> {
  const email = `${name}@free.tablamigo`; const remoteAddress = `10.89.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1994-04-04', gender: 'woman', homeCountry: 'in' });
  return call;
}
const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@free.tablamigo'}`)[0].id as string;
const openDm = async (from: Api, to: string) => from('POST', `/dm/${await idOf(to)}`);
const say = (who: Api, chatId: string, body: string) => who('POST', `/chats/${chatId}/messages`, { body });
const reset = async () => {
  await sql`delete from chats where id in (select cm.chat_id from chat_members cm join users u on u.id = cm.user_id where u.email like '%@free.tablamigo')`;
  await sql`delete from dm_starts where user_id in (select id from users where email like '%@free.tablamigo')`;
};

const u: Record<string, Api> = {};
beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@free.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});
afterEach(async () => { config.allFree = false; config.launchPlusUntil = null; await reset(); });
afterAll(async () => { await sql`delete from users where email like '%@free.tablamigo'`; await app.close(); await sql.end(); });

describe('ALL_FREE setting', () => {
  it('is on unless switched off, and refuses a value it does not understand', () => {
    for (const v of [undefined, '', ' ', 'true', 'TRUE', 'on', '1']) expect(parseAllFree(v)).toBe(true);
    for (const v of ['false', 'off', '0', ' False ']) expect(parseAllFree(v)).toBe(false);
    for (const v of ['yes', 'no', 'flase', 'paid']) expect(() => parseAllFree(v)).toThrow(/Invalid ALL_FREE/);
  });
});

describe('with ALL_FREE on', () => {
  it('a free account gets Plus limits, and the app is told everything is free', async () => {
    config.allFree = true;
    const id = await idOf('ana');
    await sql`update users set plus_until = null, comp_until = null where id = ${id}`;
    expect(await isPlus(id)).toBe(true);
    expect(await limitsFor(id)).toBe(LIMITS.plus);
    expect((await u.ana('GET', '/me')).json()).toMatchObject({ plus: true, allFree: true });
    expect((await app.inject({ method: 'GET', url: '/meta' })).json().allFree).toBe(true);
    expect((await u.ana('GET', '/billing/me')).json()).toMatchObject({ plus: true, allFree: true, launchOffer: { active: false, until: null } });
    expect((await u.ana('GET', '/me/viewers')).json()).toMatchObject({ locked: false });
    expect((await u.ana('GET', `/travelers?lat=${HERE.lat}&lng=${HERE.lng}&verified_only=true`)).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/ads/active' })).json().ads).toEqual([]);
  });

  it('no DM limit and no contact shield fire', async () => {
    config.allFree = true;
    const chat = (await openDm(u.ana, 'ben')).json().chatId as string;
    expect((await u.ana('GET', `/chats/${chat}/messages`)).json().chat.gate).toMatchObject({ canSend: true, contacts: true, remaining: null });
    for (const m of ['Hi Ben!', 'In Bengaluru next week?', 'Dosa at Vidyarthi Bhavan?', 'Still there?']) expect((await say(u.ana, chat, m)).statusCode).toBe(200);
    expect((await say(u.ana, chat, 'My number is +91 98765 43210')).statusCode).toBe(200);
    // A second and third new conversation the same day.
    for (const p of ['cas', 'dov']) expect((await openDm(u.ana, p)).statusCode).toBe(200);
  });

  it('sells nothing: web checkout refuses to start, and the launch offer is not granted at sign-up', async () => {
    config.allFree = true;
    config.launchPlusUntil = new Date(Date.now() + 30 * 86400_000);
    expect(launchOffer()).toEqual({ active: false, until: null });
    const r = await u.ana('POST', '/billing/razorpay/pass-order', {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toBe('all_free');
    const email = 'newbie@free.tablamigo';
    await sql`delete from users where email = ${email}`;
    process.env.REVIEW_EMAILS += `,${email}`;
    config.reviewEmails.push(email);
    await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress: '10.89.1.1' });
    expect((await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress: '10.89.1.1' })).statusCode).toBe(200);
    const [n] = await sql`select comp_until, plus_until from users where email = ${email}`;
    expect(n).toMatchObject({ compUntil: null, plusUntil: null });
  });

  it('nobody is ranked first or tagged for having Plus', async () => {
    config.allFree = true;
    const at = (km: number) => ({ lat: HERE.lat + km / 111, lng: HERE.lng });
    await sql`update users set plus_until = null, interests = '{}' where email like '%@free.tablamigo'`;
    for (const [p, km] of [['cas', 1], ['dov', 1.5]] as const) await u[p]('POST', '/me/location', at(km));
    await sql`update users set plus_until = now() + interval '7 days' where email = 'dov@free.tablamigo'`;
    await u.eli('POST', '/me/location', HERE);
    const list = (await u.eli('GET', `/travelers?lat=${HERE.lat}&lng=${HERE.lng}`)).json().travelers.filter((t: any) => ['cas', 'dov'].includes(t.name));
    expect(list.map((t: any) => t.name)).toEqual(['cas', 'dov']);
    expect(list.every((t: any) => t.plus === false)).toBe(true);
  });
  it('the plan list works and does not put Plus hosts first', async () => {
    // GET /activities sorts by plusOf(); a bare `false` there was a Postgres error, so every plan list was a 500.
    config.allFree = true;
    const soon = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
    await sql`update users set plus_until = null where email like '%@free.tablamigo'`;
    await sql`update users set plus_until = now() + interval '7 days' where email = 'dov@free.tablamigo'`;
    const plan = (who: Api, title: string, h: number) => who('POST', '/activities', { title, category: 'food', placeName: 'Cubbon Park', lat: HERE.lat, lng: HERE.lng, startsAt: soon(h) });
    expect((await plan(u.cas, 'free host plan', 2)).statusCode).toBe(200);
    expect((await plan(u.dov, 'plus host plan', 3)).statusCode).toBe(200);
    const r = await u.eli('GET', `/activities?lat=${HERE.lat}&lng=${HERE.lng}&when=week`);
    expect(r.statusCode).toBe(200);
    const mine = r.json().activities.filter((a: any) => ['free host plan', 'plus host plan'].includes(a.title)).map((a: any) => a.title);
    expect(mine).toEqual(['free host plan', 'plus host plan']);   // by start time only
    config.allFree = false;
    const paid = (await u.eli('GET', `/activities?lat=${HERE.lat}&lng=${HERE.lng}&when=week`)).json().activities
      .filter((a: any) => ['free host plan', 'plus host plan'].includes(a.title)).map((a: any) => a.title);
    expect(paid).toEqual(['plus host plan', 'free host plan']);   // Plus first again once paid plans are back
    await sql`delete from activities where title in ('free host plan', 'plus host plan')`;
  });
});

describe('with ALL_FREE off (paid plans back on)', () => {
  it('a free account has the free limits again and the paywalls fire', async () => {
    config.allFree = false;
    const id = await idOf('ana');
    await sql`update users set plus_until = null, comp_until = null where id = ${id}`;
    expect(await isPlus(id)).toBe(false);
    expect(await limitsFor(id)).toBe(LIMITS.free);
    expect((await u.ana('GET', '/me')).json()).toMatchObject({ plus: false, allFree: false });
    expect((await app.inject({ method: 'GET', url: '/meta' })).json().allFree).toBe(false);
    expect((await u.ana('GET', `/travelers?lat=${HERE.lat}&lng=${HERE.lng}&verified_only=true`)).json().error).toBe('plus_required');
    const chat = (await openDm(u.ana, 'ben')).json().chatId as string;
    for (const m of ['one', 'two', 'three']) expect((await say(u.ana, chat, m)).statusCode).toBe(200);
    expect((await say(u.ana, chat, 'four')).json().error).toBe('dm_wait_reply');
    expect((await openDm(u.ana, 'cas')).json().error).toBe('dm_limit');
  });

  it('Plus members are tagged and ranked first again', async () => {
    config.allFree = false;
    const at = (km: number) => ({ lat: HERE.lat + km / 111, lng: HERE.lng });
    await sql`update users set plus_until = null, interests = '{}' where email like '%@free.tablamigo'`;
    for (const [p, km] of [['cas', 1], ['dov', 1.5]] as const) await u[p]('POST', '/me/location', at(km));
    await sql`update users set plus_until = now() + interval '7 days' where email = 'dov@free.tablamigo'`;
    await u.eli('POST', '/me/location', HERE);
    const list = (await u.eli('GET', `/travelers?lat=${HERE.lat}&lng=${HERE.lng}`)).json().travelers.filter((t: any) => ['cas', 'dov'].includes(t.name));
    expect(list.map((t: any) => [t.name, t.plus])).toEqual([['dov', true], ['cas', false]]);
  });
});
