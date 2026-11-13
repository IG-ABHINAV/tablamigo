// Closing plans to new joiners, and how Plus is derived from subscriptions, Trip Passes and comps.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
process.env.REVIEW_EMAILS = 'dana@plans.tablamigo,eli@plans.tablamigo,fay@plans.tablamigo';
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { recomputePlus, voidPass } = await import('./lib/play.js');

let app: Awaited<ReturnType<typeof build>>;
const BKK = { lat: 13.7466, lng: 100.5346 };

async function login(email: string) {
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email } });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' } });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
}
const plusUntil = async (email: string) => (await sql`select plus_until from users where email = ${email}`)[0].plusUntil as Date | null;

beforeAll(async () => { app = await build(); await sql`delete from users where email like '%@plans.tablamigo'`; });
afterAll(async () => { await sql`delete from users where email like '%@plans.tablamigo'`; await app.close(); await sql.end(); });

describe('plans and passes', () => {
  it('host closes a plan: hidden from explore, new joins refused, members keep access, reopen works', async () => {
    const dana = await login('dana@plans.tablamigo'), eli = await login('eli@plans.tablamigo'), fay = await login('fay@plans.tablamigo');
    for (const [u, name] of [[dana, 'Dana'], [eli, 'Eli'], [fay, 'Fay']] as const) {
      await u('PATCH', '/me', { name, birthdate: '1993-03-03', gender: 'woman', homeCountry: 'ca' });
      await u('POST', '/me/location', BKK);
    }
    const startsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    const a = (await dana('POST', '/activities', { title: 'Closed test sunset', emoji: '🌅', category: 'explore', placeName: 'Wat Arun', ...BKK, startsAt })).json();
    await eli('POST', `/activities/${a.id}/join`);

    expect((await eli('POST', `/activities/${a.id}/close`, { closed: true })).statusCode).toBe(403);
    expect((await dana('POST', `/activities/${a.id}/close`, { closed: true })).json().closed).toBe(true);
    const list = async (u: typeof dana) => (await u('GET', `/activities?lat=${BKK.lat}&lng=${BKK.lng}`)).json().activities.map((x: any) => x.id);
    expect(await list(fay)).not.toContain(a.id);
    expect(await list(eli)).toContain(a.id);
    expect((await fay('POST', `/activities/${a.id}/join`)).json().error).toBe('plan_closed');
    expect((await eli('POST', `/activities/${a.id}/join`)).json().ok).toBe(true);
    expect((await fay('GET', `/activities/${a.id}`)).json().closed).toBe(true);

    const msgs = (await dana('GET', `/chats/${a.chatId}/messages`)).json().messages.map((m: any) => m.body);
    expect(msgs).toContain('The host closed this plan to new people.');
    // closing twice doesn't post a second system message
    await dana('POST', `/activities/${a.id}/close`, { closed: true });
    const again = (await dana('GET', `/chats/${a.chatId}/messages`)).json().messages.filter((m: any) => m.body === 'The host closed this plan to new people.');
    expect(again.length).toBe(1);

    await dana('POST', `/activities/${a.id}/close`, { closed: false });
    expect((await fay('POST', `/activities/${a.id}/join`)).json().ok).toBe(true);
  });

  it('web uploads: raw image stored under the user, wrong type and empty body refused', async () => {
    const ip = '10.9.9.9'; // own rate-limit bucket: sign-in codes are capped per IP
    await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email: 'dana@plans.tablamigo' }, remoteAddress: ip });
    const tok = (await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email: 'dana@plans.tablamigo', code: '424242' }, remoteAddress: ip })).json().accessToken;
    const [u] = await sql`select id from users where email = 'dana@plans.tablamigo'`;
    const up = (ct: string, body: Buffer | string, kind = 'chat') => app.inject({ method: 'POST', url: `/uploads/image/direct?kind=${kind}`, payload: body, headers: { 'content-type': ct, authorization: `Bearer ${tok}` } });
    const ok = await up('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().key).toMatch(new RegExp(`^chat/${u.id}/[0-9a-f]{16}\\.jpg$`));
    expect((await up('text/plain', 'hello')).statusCode).toBe(400);
    expect((await up('image/png', Buffer.alloc(0))).statusCode).toBe(400);
  });

  it('a women-only plan is a 404 for men, even by direct link', async () => {
    const ip = '10.9.9.8';
    const tokenFor = async (email: string) => {
      await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress: ip });
      return (await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress: ip })).json().accessToken as string;
    };
    const [dana, eli] = [await tokenFor('dana@plans.tablamigo'), await tokenFor('eli@plans.tablamigo')];
    await app.inject({ method: 'PATCH', url: '/me', payload: { gender: 'man' }, headers: { authorization: `Bearer ${eli}` } });
    const startsAt = new Date(Date.now() + 5 * 3600_000).toISOString();
    const a = (await app.inject({ method: 'POST', url: '/activities', payload: { title: 'Women only brunch', emoji: '🥞', category: 'food', placeName: 'Cafe', lat: 13.7466, lng: 100.5346, startsAt, womenOnly: true }, headers: { authorization: `Bearer ${dana}` } })).json();
    expect((await app.inject({ method: 'GET', url: `/activities/${a.id}`, headers: { authorization: `Bearer ${eli}` } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/activities/${a.id}`, headers: { authorization: `Bearer ${dana}` } })).statusCode).toBe(200);
    await app.inject({ method: 'PATCH', url: '/me', payload: { gender: 'woman' }, headers: { authorization: `Bearer ${eli}` } });
  });

  it('malformed JSON is a 400, not a server error', async () => {
    const r = await app.inject({ method: 'POST', url: '/auth/email/start', payload: '{"email":', headers: { 'content-type': 'application/json' } });
    expect(r.statusCode).toBe(400); expect(r.json().error).toBe('invalid_input');
  });

  it('a partial profile save keeps interests and languages', async () => {
    const dana = await login('dana@plans.tablamigo');
    await dana('PATCH', '/me', { interests: ['food', 'coffee'], languages: ['English'] });
    await dana('PATCH', '/me', { bio: 'Hi there' });
    await dana('PATCH', '/me', { countriesVisited: ['TH', 'JP'] });
    const me = (await dana('GET', '/me')).json();
    expect(me.interests).toEqual(['food', 'coffee']); expect(me.languages).toEqual(['English']); expect(me.bio).toBe('Hi there');
  });

  it('plus_until is the latest of live subs, unvoided passes and comps', async () => {
    const [u] = await sql`select id from users where email = 'dana@plans.tablamigo'`;
    const day = 86400_000, now = Date.now();
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at)
      values ('sub-tok-plans-1', ${u.id}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', ${new Date(now + 5 * day)})`;
    await recomputePlus(u.id);
    expect((await plusUntil('dana@plans.tablamigo'))!.getTime()).toBeCloseTo(now + 5 * day, -4);

    await sql`insert into passes (purchase_token, user_id, product_id, expires_at) values ('pass-tok-plans-1', ${u.id}, 'tablamigo_trip_pass', ${new Date(now + 14 * day)})`;
    await recomputePlus(u.id);
    expect((await plusUntil('dana@plans.tablamigo'))!.getTime()).toBeCloseTo(now + 14 * day, -4);

    // a subscription renewal no longer wipes the pass
    await sql`update subscriptions set expires_at = ${new Date(now + 7 * day)} where purchase_token = 'sub-tok-plans-1'`;
    await recomputePlus(u.id);
    expect((await plusUntil('dana@plans.tablamigo'))!.getTime()).toBeCloseTo(now + 14 * day, -4);

    // refunded pass (via RTDN) falls back to the sub
    const data = Buffer.from(JSON.stringify({ voidedPurchaseNotification: { purchaseToken: 'pass-tok-plans-1', productType: 2 } })).toString('base64');
    expect((await app.inject({ method: 'POST', url: '/billing/google/rtdn', payload: { message: { data } } })).statusCode).toBe(200);
    expect((await plusUntil('dana@plans.tablamigo'))!.getTime()).toBeCloseTo(now + 7 * day, -4);
    expect(await voidPass('pass-tok-plans-1')).toBe(false);

    // expired sub + comp: comp wins; nothing live: null
    await sql`update subscriptions set status = 'SUBSCRIPTION_STATE_EXPIRED' where purchase_token = 'sub-tok-plans-1'`;
    await sql`update users set comp_until = ${new Date(now + 30 * day)} where id = ${u.id}`;
    await recomputePlus(u.id);
    expect((await plusUntil('dana@plans.tablamigo'))!.getTime()).toBeCloseTo(now + 30 * day, -4);
    await sql`update users set comp_until = null where id = ${u.id}`;
    await recomputePlus(u.id);
    expect(await plusUntil('dana@plans.tablamigo')).toBeNull();
  });
});
