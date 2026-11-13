// In-app inbox: who gets a notice, what a free account may see, and read state.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
process.env.REVIEW_EMAILS = 'hana@inbox.tablamigo,ivan@inbox.tablamigo,jo@inbox.tablamigo,kai@inbox.tablamigo';
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { recomputePlus } = await import('./lib/play.js');
const { addNotice } = await import('./lib/inbox.js');

let app: Awaited<ReturnType<typeof build>>;
const BKK = { lat: 13.7466, lng: 100.5346 };

async function login(email: string) {
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email } });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' } });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
}
type Client = Awaited<ReturnType<typeof login>>;
const id = async (email: string) => (await sql`select id from users where email = ${email}`)[0].id as string;
const inbox = async (u: Client) => (await u('GET', '/inbox')).json().notifications as any[];
const unread = async (u: Client) => (await u('GET', '/inbox/unread')).json().count as number;

let hana: Client, ivan: Client, jo: Client, kai: Client;
beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@inbox.tablamigo'`;
  [hana, ivan, jo, kai] = [await login('hana@inbox.tablamigo'), await login('ivan@inbox.tablamigo'), await login('jo@inbox.tablamigo'), await login('kai@inbox.tablamigo')];
  for (const [u, name] of [[hana, 'Hana'], [ivan, 'Ivan'], [jo, 'Jo'], [kai, 'Kai']] as const) {
    await u('PATCH', '/me', { name, birthdate: '1991-04-04', gender: 'woman', homeCountry: 'jp' });
    await u('POST', '/me/location', BKK);
  }
});
afterAll(async () => { await sql`delete from users where email like '%@inbox.tablamigo'`; await app.close(); await sql.end(); });

describe('inbox', () => {
  it('join, thumbs-up and cancel notify the right people; unread count and read', async () => {
    const started = new Date(Date.now() - 10 * 60_000).toISOString(), later = new Date(Date.now() + 3 * 3600_000).toISOString();
    const a = (await hana('POST', '/activities', { title: 'Inbox tapas night', category: 'food', placeName: 'Soi 11', ...BKK, startsAt: started })).json();
    const b = (await hana('POST', '/activities', { title: 'Inbox river walk', category: 'explore', placeName: 'Chao Phraya', ...BKK, startsAt: later })).json();
    await ivan('POST', `/activities/${a.id}/join`);
    // joining twice doesn't notify twice
    await ivan('POST', `/activities/${a.id}/join`);

    const [n] = await inbox(hana);
    expect(n).toMatchObject({ kind: 'join', body: 'Ivan joined Inbox tapas night', actorName: 'Ivan', activityTitle: 'Inbox tapas night', chatId: a.chatId, readAt: null, locked: false });
    expect(await unread(hana)).toBe(1);
    expect(await inbox(ivan)).toEqual([]);

    expect((await ivan('POST', '/vouches', { activityId: a.id, userId: await id('hana@inbox.tablamigo') })).json().ok).toBe(true);
    await ivan('POST', '/vouches', { activityId: a.id, userId: await id('hana@inbox.tablamigo') });
    expect((await inbox(hana))[0]).toMatchObject({ kind: 'vouch', body: 'Ivan gave you a thumbs-up for Inbox tapas night' });
    expect(await unread(hana)).toBe(2);

    expect((await hana('POST', '/inbox/read')).json().ok).toBe(true);
    expect(await unread(hana)).toBe(0);
    expect((await inbox(hana)).every(x => x.readAt)).toBe(true);

    // cancel: members hear about it, the host doesn't
    await ivan('POST', `/activities/${b.id}/join`); await jo('POST', `/activities/${b.id}/join`);
    await hana('POST', '/inbox/read');
    await hana('POST', `/activities/${b.id}/cancel`);
    const [c] = await inbox(ivan);
    expect(c).toMatchObject({ kind: 'cancelled', body: 'Inbox river walk was cancelled by the host', activityId: b.id });
    expect((await inbox(jo))[0].kind).toBe('cancelled');
    expect(await unread(hana)).toBe(0);

    // read with ids only marks those
    await addNotice([await id('ivan@inbox.tablamigo')], { kind: 'verified', body: 'Extra' });
    expect(await unread(ivan)).toBe(2);
    await ivan('POST', '/inbox/read', { ids: [c.id] });
    expect(await unread(ivan)).toBe(1);
  });

  it('profile views: once a day, anonymous for free accounts, revealed with Plus', async () => {
    const hanaId = await id('hana@inbox.tablamigo');
    await hana('POST', '/inbox/read');
    await ivan('GET', `/users/${hanaId}`); await ivan('GET', `/users/${hanaId}`);
    const views = (await inbox(hana)).filter(x => x.kind === 'profile_view');
    expect(views.length).toBe(1);
    expect(views[0]).toMatchObject({ body: 'Someone viewed your profile', locked: true, actorId: null, actorName: null, actorPhotoUrl: null });
    expect(await unread(hana)).toBe(1);

    await sql`update users set comp_until = now() + interval '30 days' where id = ${hanaId}`;
    await recomputePlus(hanaId);
    const [v] = (await inbox(hana)).filter(x => x.kind === 'profile_view');
    expect(v).toMatchObject({ body: 'Ivan viewed your profile', locked: false, actorName: 'Ivan', actorId: await id('ivan@inbox.tablamigo') });
    await sql`update users set comp_until = null where id = ${hanaId}`;
    await recomputePlus(hanaId);
  });

  it('blocked pairs get no notices, and old ones disappear', async () => {
    const [hanaId, joId, ivanId] = [await id('hana@inbox.tablamigo'), await id('jo@inbox.tablamigo'), await id('ivan@inbox.tablamigo')];
    await hana('POST', '/inbox/read');
    await jo('GET', `/users/${hanaId}`);
    expect(await unread(hana)).toBe(1);
    await hana('POST', `/blocks/${joId}`);
    expect(await unread(hana)).toBe(0);
    expect((await sql`select 1 from notifications where user_id = ${hanaId} and actor_id = ${joId}`).length).toBeGreaterThan(0);
    expect((await inbox(hana)).some(x => x.actorId === joId)).toBe(false);

    // either direction, straight through the helper
    const before = (await sql`select count(*)::int as n from notifications where user_id in ${sql([hanaId, joId, ivanId])}`)[0].n;
    await addNotice([hanaId], { kind: 'join', actorId: joId, body: 'Jo joined' });
    await jo('POST', `/blocks/${ivanId}`);
    await addNotice([ivanId], { kind: 'vouch', actorId: joId, body: n => `${n} gave you a thumbs-up` });
    await addNotice([joId], { kind: 'vouch', actorId: ivanId, body: 'nope' });
    expect((await sql`select count(*)::int as n from notifications where user_id in ${sql([hanaId, joId, ivanId])}`)[0].n).toBe(before);
    // a bad id is logged, never thrown
    await expect(addNotice(['not-a-uuid'], { kind: 'verified', body: 'x' })).resolves.toBeUndefined();
  });

  it('verification approval and rejection land in the inbox', async () => {
    const [hanaId, ivanId] = [await id('hana@inbox.tablamigo'), await id('ivan@inbox.tablamigo')];
    await sql`update users set role = 'admin' where email = 'kai@inbox.tablamigo'`;
    const [ra] = await sql`insert into verification_requests (user_id, photo_key, pose) values (${hanaId}, 'avatar/x/0000000000000000.jpg', 'thumbs_up') returning id`;
    const [rr] = await sql`insert into verification_requests (user_id, photo_key, pose) values (${ivanId}, 'avatar/y/0000000000000000.jpg', 'touch_ear') returning id`;
    expect((await hana('POST', `/admin/verifications/${ra.id}/approve`)).statusCode).toBe(403);
    expect((await kai('POST', `/admin/verifications/${ra.id}/approve`)).json().status).toBe('approved');
    expect((await kai('POST', `/admin/verifications/${rr.id}/reject`)).json().status).toBe('rejected');
    expect((await inbox(hana))[0]).toMatchObject({ kind: 'verified', body: "You're verified ✅", actorId: null, readAt: null });
    expect((await inbox(ivan))[0]).toMatchObject({ kind: 'verify_rejected', body: "Your verification photo didn't pass. You can try again." });
  });
});
