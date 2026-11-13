// End-to-end API test against the local docker Postgres. Uses the review-login
// path (fixed code for listed emails) so no email is sent.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
process.env.REVIEW_EMAILS = 'alice@test.tablamigo,bob@test.tablamigo,carl@test.tablamigo,dave@test.tablamigo,erin@test.tablamigo,fay@test.tablamigo';
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { attachRealtime } = await import('./lib/realtime.js');
const { config } = await import('./lib/config.js');
const fs = await import('node:fs');
const path = await import('node:path');

let app: Awaited<ReturnType<typeof build>>;
const BKK = { lat: 13.7466, lng: 100.5346 };

// Suites past the first pass their own ip: /auth/email/start allows 5 per 10 minutes per ip.
async function login(email: string, remoteAddress = '127.0.0.1') {
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
}

beforeAll(async () => {
  app = await build();
  // Run broadcasts for real: a BigInt message id once crashed every join after the DB commit.
  attachRealtime(app.server);
  await sql`delete from users where email like '%@test.tablamigo'`; });
afterAll(async () => { await sql`delete from users where email like '%@test.tablamigo'`; await app.close(); await sql.end(); });

describe('tablamigo api', () => {
  it('rejects bad codes and unauthenticated calls', async () => {
    await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email: 'alice@test.tablamigo' } });
    const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email: 'alice@test.tablamigo', code: '000000' } });
    expect(r.json().error).toBe('wrong_code');
    expect((await app.inject({ method: 'GET', url: '/me' })).statusCode).toBe(401);
  });

  it('runs the core flow: onboard, create, join, chat, trips, block, delete', async () => {
    const alice = await login('alice@test.tablamigo');
    const bob = await login('bob@test.tablamigo');

    // under-18 is refused, then onboarding completes
    expect((await alice('PATCH', '/me', { birthdate: '2012-01-01' })).json().error).toBe('under_18');
    // A month-first entry (US habit in day-month-year boxes) and a day that month doesn't have are 400s, not Postgres 500s.
    for (const birthdate of ['1977-24-03', '1977-02-30', '1977-00-10']) {
      const r = await alice('PATCH', '/me', { birthdate });
      expect([r.statusCode, r.json().error]).toEqual([400, 'invalid_birthdate']);
    }
    expect((await alice('PATCH', '/me', { name: 'Alice', birthdate: '1994-05-02', gender: 'woman', homeCountry: 'gb', interests: ['food', 'coffee'] })).json().onboarded).toBe(true);
    await bob('PATCH', '/me', { name: 'Bob', birthdate: '1992-02-02', gender: 'man', homeCountry: 'us', interests: ['food'] });
    await alice('POST', '/me/location', BKK); await bob('POST', '/me/location', BKK);

    // create -> appears nearby with host + going count
    const startsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    const created = (await alice('POST', '/activities', { title: 'Test noodle night', emoji: '🍜', category: 'food', placeName: 'Yaowarat', lat: BKK.lat, lng: BKK.lng, startsAt, maxPeople: 2 })).json();
    expect(created.chatId).toBeTruthy();
    const near = (await bob('GET', `/activities?lat=${BKK.lat}&lng=${BKK.lng}`)).json().activities;
    const found = near.find((a: any) => a.id === created.id);
    expect(found.going).toBe(1); expect(found.host.name).toBe('Alice'); expect(found.joined).toBe(false);

    // join -> chat membership + system message; capacity enforced
    expect((await bob('POST', `/activities/${created.id}/join`)).json().chatId).toBe(created.chatId);
    const carl = await login('carl@test.tablamigo');
    await carl('PATCH', '/me', { name: 'Carl', birthdate: '1990-01-01', gender: 'man', homeCountry: 'de' });
    expect((await carl('POST', `/activities/${created.id}/join`)).json().error).toBe('full');

    // chat: send, list with unread, non-member refused
    const sent = (await bob('POST', `/chats/${created.chatId}/messages`, { body: 'Hi Alice!' })).json();
    expect(sent.body).toBe('Hi Alice!');
    const aliceChats = (await alice('GET', '/chats')).json().chats;
    expect(aliceChats.find((c: any) => c.id === created.chatId).unread).toBeGreaterThan(0);
    expect((await carl('GET', `/chats/${created.chatId}/messages`)).statusCode).toBe(403);

    // women-only: a man cannot host or see it
    expect((await bob('POST', '/activities', { title: 'Women walk', category: 'explore', placeName: 'Lumpini', lat: BKK.lat, lng: BKK.lng, startsAt, womenOnly: true })).json().error).toBe('women_only_host');
    const wo = (await alice('POST', '/activities', { title: 'Women sunset walk', category: 'explore', placeName: 'Lumpini', lat: BKK.lat, lng: BKK.lng, startsAt, womenOnly: true })).json();
    const bobSees = (await bob('GET', `/activities?lat=${BKK.lat}&lng=${BKK.lng}`)).json().activities.map((a: any) => a.id);
    expect(bobSees).not.toContain(wo.id);

    // free-tier limit: third activity in a day needs Plus
    expect((await alice('POST', '/activities', { title: 'Third one', category: 'other', placeName: 'Some cafe', lat: BKK.lat, lng: BKK.lng, startsAt })).statusCode).toBe(402);

    // trips overlap
    const t1 = (await alice('POST', '/trips', { city: 'Bali', countryCode: 'id', startDate: '2026-12-01', endDate: '2026-12-10' })).json();
    // dates must round-trip as plain YYYY-MM-DD (a JS Date shifted them a day on UTC+ servers)
    expect([t1.startDate, t1.endDate]).toEqual(['2026-12-01', '2026-12-10']);
    await bob('POST', '/trips', { city: 'Bali', countryCode: 'ID', startDate: '2026-12-05', endDate: '2026-12-12' });
    const ov = (await alice('GET', `/trips/${t1.id}/overlaps`)).json();
    expect(ov.total).toBe(1); expect(ov.travelers[0].name).toBe('Bob');

    // nearby travellers: distances are coarsened
    const tr = (await alice('GET', `/travelers/nearby?lat=${BKK.lat}&lng=${BKK.lng}`)).json();
    expect(tr.travelers.every((t: any) => t.distanceM % 500 === 0)).toBe(true);

    // block hides the other side's activities and profile
    await bob('POST', `/blocks/${(await alice('GET', '/me')).json().id}`);
    const afterBlock = (await bob('GET', `/activities?lat=${BKK.lat}&lng=${BKK.lng}`)).json().activities.map((a: any) => a.id);
    expect(afterBlock).not.toContain(created.id);

    // report + account deletion (Play requirement)
    expect((await carl('POST', '/reports', { targetType: 'user', targetId: 'x', reason: 'spam' })).statusCode).toBe(200);
    expect((await carl('DELETE', '/me')).statusCode).toBe(200);
    expect((await carl('GET', '/me')).statusCode).toBe(401);
  });
});

describe('chat polls, live location, moderation', () => {
  let dave: Awaited<ReturnType<typeof login>>, erin: typeof dave, fay: typeof dave, chatId: string, dmId: string;
  beforeAll(async () => {
    [dave, erin, fay] = await Promise.all(['dave', 'erin', 'fay'].map(n => login(`${n}@test.tablamigo`, '10.0.0.2')));
    for (const [u, name] of [[dave, 'Dave'], [erin, 'Erin'], [fay, 'Fay']] as const) {
      await u('PATCH', '/me', { name, birthdate: '1993-03-03', gender: 'unspecified', homeCountry: 'nl' });
      await u('POST', '/me/location', BKK);
    }
    const startsAt = new Date(Date.now() + 3 * 3600_000).toISOString();
    const act = (await dave('POST', '/activities', { title: 'Test poll night', category: 'drinks', placeName: 'Soi 11', lat: BKK.lat, lng: BKK.lng, startsAt })).json();
    chatId = act.chatId;
    await erin('POST', `/activities/${act.id}/join`);
    dmId = (await dave('POST', `/dm/${(await erin('GET', '/me')).json().id}`)).json().chatId;
  });

  it('creates a poll, votes, changes the vote; non-members and DMs are refused', async () => {
    const { config } = await import('./lib/config.js'); config.openaiKey = '';
    const p = await dave('POST', `/chats/${chatId}/polls`, { question: 'Where first?', options: ['Rooftop', 'Street food', 'Both'] });
    expect(p.statusCode).toBe(200);
    const poll = p.json();
    expect(poll.kind).toBe('poll'); expect(poll.poll).toMatchObject({ question: 'Where first?', counts: [0, 0, 0], myVote: null });

    const v1 = (await erin('POST', `/chats/${chatId}/polls/${poll.id}/vote`, { option: 1 })).json();
    expect(v1.poll).toMatchObject({ counts: [0, 1, 0], myVote: 1 });
    await dave('POST', `/chats/${chatId}/polls/${poll.id}/vote`, { option: 1 });
    const v2 = (await erin('POST', `/chats/${chatId}/polls/${poll.id}/vote`, { option: 0 })).json();
    expect(v2.poll).toMatchObject({ counts: [1, 1, 0], myVote: 0 });
    expect((await erin('POST', `/chats/${chatId}/polls/${poll.id}/vote`, { option: 3 })).json().error).toBe('invalid_input');

    const listed = (await dave('GET', `/chats/${chatId}/messages`)).json().messages.find((m: any) => m.id === poll.id);
    expect(listed.poll).toMatchObject({ counts: [1, 1, 0], myVote: 1 });

    const nm = await fay('POST', `/chats/${chatId}/polls/${poll.id}/vote`, { option: 0 });
    expect(nm.statusCode).toBe(403); expect(nm.json().error).toBe('not_a_member');
    expect((await dave('POST', `/chats/${dmId}/polls`, { question: 'Dinner?', options: ['Yes', 'No'] })).json().error).toBe('group_only');
    expect((await dave('POST', `/chats/${chatId}/polls`, { question: 'One option?', options: ['Only'] })).json().error).toBe('invalid_input');
  });

  it('shares live location; only the sender updates it, and only before it ends', async () => {
    const s = await dave('POST', `/chats/${dmId}/locations`, { ...BKK, minutes: 15 });
    expect(s.statusCode).toBe(200);
    const share = s.json();
    expect(share.kind).toBe('location');
    expect(new Date(share.location.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

    const up = (await dave('PATCH', `/chats/${dmId}/locations/${share.id}`, { lat: 13.75, lng: 100.54 })).json();
    expect(up.location).toMatchObject({ lat: 13.75, lng: 100.54 });
    const seen = (await erin('GET', `/chats/${dmId}/messages`)).json().messages.find((m: any) => m.id === share.id);
    expect(seen.location.lat).toBeCloseTo(13.75, 5);

    const other = await erin('PATCH', `/chats/${dmId}/locations/${share.id}`, { lat: 1, lng: 1 });
    expect(other.statusCode).toBe(403); expect(other.json().error).toBe('not_sender');
    expect((await fay('PATCH', `/chats/${dmId}/locations/${share.id}`, { lat: 1, lng: 1 })).json().error).toBe('not_a_member');
    expect((await dave('POST', `/chats/${dmId}/locations`, { ...BKK, minutes: 30 })).json().error).toBe('invalid_input');

    await sql`update chat_locations set expires_at = now() - interval '1 minute' where message_id = ${share.id}`;
    expect((await dave('PATCH', `/chats/${dmId}/locations/${share.id}`, BKK)).json().error).toBe('location_ended');

    // stopping early ends it for everyone
    const g = (await erin('POST', `/chats/${chatId}/locations`, { ...BKK, minutes: 60 })).json();
    const stop = (await erin('POST', `/chats/${chatId}/locations/${g.id}/stop`)).json();
    expect(stop).toEqual({ id: g.id, location: { lat: 0, lng: 0, expiresAt: expect.any(String), updatedAt: expect.any(String), ended: true } });   // an ended share has no position (live-location-privacy.test.ts)
    expect(new Date(stop.location.expiresAt).getTime()).toBeLessThanOrEqual(Date.now());
    expect((await erin('PATCH', `/chats/${chatId}/locations/${g.id}`, BKK)).json().error).toBe('location_ended');
  });

  it('moderates group messages and polls, and fails open', async () => {
    const { config } = await import('./lib/config.js');
    config.openaiKey = '';
    expect((await erin('POST', `/chats/${chatId}/messages`, { body: 'No key, still sent' })).statusCode).toBe(200);

    config.openaiKey = 'sk-test';
    const reply = (categories: object) => async () => new Response(JSON.stringify({ results: [{ flagged: true, categories }] }));
    const flagged = vi.spyOn(globalThis, 'fetch').mockImplementation(reply({ harassment: true }));
    const b = await erin('POST', `/chats/${chatId}/messages`, { body: 'something nasty' });
    expect(b.statusCode).toBe(400); expect(b.json().error).toBe('message_blocked');
    expect((await erin('POST', `/chats/${chatId}/polls`, { question: 'Nasty?', options: ['a', 'b'] })).json().error).toBe('message_blocked');
    expect((await erin('POST', `/chats/${dmId}/messages`, { body: 'DMs are not screened' })).statusCode).toBe(200);
    expect(flagged).toHaveBeenCalledTimes(2);

    flagged.mockImplementation(reply({ violence: true }));
    expect((await erin('POST', `/chats/${chatId}/messages`, { body: 'Mild, unlisted category' })).statusCode).toBe(200);
    flagged.mockRejectedValue(new Error('timeout'));
    expect((await erin('POST', `/chats/${chatId}/messages`, { body: 'API down, still sent' })).statusCode).toBe(200);
    flagged.mockRestore(); config.openaiKey = '';
  });
});

describe('profile and social', () => {
  const D = '@profile.tablamigo';
  type Call = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;
  const u: Record<string, { id: string; call: Call }> = {};
  const near = (who: string, qs = '') => u[who].call('GET', `/travelers?lat=${BKK.lat}&lng=${BKK.lng}${qs}`);
  const ids = async (who: string, qs = '') => (await near(who, qs)).json().travelers.map((t: any) => t.id);

  beforeAll(async () => {
    const { signAccess } = await import('./lib/auth.js');
    await sql`delete from users where email like ${'%' + D}`;
    // Ages on 2026-09-28: Pia 23, Quin 36, Ravi 51, Sol 30.
    for (const [name, birth, gender] of [['Pia', '2003-06-01', 'woman'], ['Quin', '1990-06-01', 'man'], ['Ravi', '1975-06-01', 'man'], ['Sol', '1996-01-01', 'nonbinary']]) {
      const [r] = await sql`insert into users (email, name, birthdate, gender, home_country, onboarded, location, location_at)
        values (${name.toLowerCase() + D}, ${name}, ${birth}, ${gender}, 'PT', true, ST_SetSRID(ST_MakePoint(${BKK.lng}, ${BKK.lat}), 4326)::geography, now()) returning id`;
      const tok = signAccess(r.id);
      u[name] = { id: r.id, call: (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } }) };
    }
  });
  afterAll(async () => {
    const { deleteUserFiles } = await import('./lib/storage.js');
    for (const x of Object.values(u)) await deleteUserFiles(x.id);
    await sql`delete from users where id = any(${Object.values(u).map(x => x.id)}::uuid[])`;
  });

  it('snooze hides you from travelers until it ends or you undo it', async () => {
    expect(await ids('Quin')).toContain(u.Pia.id);
    expect((await u.Pia.call('POST', '/me/snooze', { duration: 'forever' })).statusCode).toBe(400);
    await u.Pia.call('POST', '/me/snooze', { duration: '24h' });
    const me = (await u.Pia.call('GET', '/me')).json();
    expect(me.snoozed).toBe(true);
    expect(Math.abs(new Date(me.snoozedUntil).getTime() - Date.now() - 86400_000)).toBeLessThan(60_000);
    expect(await ids('Quin')).not.toContain(u.Pia.id);
    expect(await ids('Pia')).toContain(u.Quin.id); // still sees others
    expect((await u.Pia.call('GET', '/chats')).statusCode).toBe(200);
    await u.Pia.call('POST', '/me/snooze', { duration: 'indefinite' });
    const inf = (await u.Pia.call('GET', '/me')).json();
    expect([inf.snoozed, inf.snoozedUntil]).toEqual([true, null]);
    expect(await ids('Quin')).not.toContain(u.Pia.id);
    await sql`update users set snoozed_until = now() - interval '1 minute' where id = ${u.Pia.id}`; // expired
    expect(await ids('Quin')).toContain(u.Pia.id);
    await u.Pia.call('POST', '/me/snooze', { duration: '1w' });
    await u.Pia.call('DELETE', '/me/snooze');
    expect((await u.Pia.call('GET', '/me')).json().snoozed).toBe(false);
    expect(await ids('Quin')).toContain(u.Pia.id);
  });

  it('countries visited: allowlisted ISO codes, deduped, shown to others', async () => {
    const { COUNTRY_CODES } = await import('./routes/me.js');
    const fs = await import('node:fs');
    const app_ = fs.readFileSync(new URL('../../mobile/src/lib/countries.ts', import.meta.url), 'utf8');
    expect([...COUNTRY_CODES].sort()).toEqual([...app_.matchAll(/\["([A-Z]{2})",/g)].map(m => m[1]).sort());
    expect((await u.Pia.call('PATCH', '/me', { countriesVisited: ['pt', 'XK', 'jp', 'PT'] })).statusCode).toBe(200);
    expect((await u.Quin.call('GET', `/users/${u.Pia.id}`)).json().countriesVisited).toEqual(['PT', 'XK', 'JP']);
    for (const bad of [['ZZ'], ['DD'], ['PRT'], ['EU']]) expect((await u.Pia.call('PATCH', '/me', { countriesVisited: bad })).json().error).toBe('invalid_input');
    expect((await u.Pia.call('GET', '/me')).json().countriesVisited).toEqual(['PT', 'XK', 'JP']);
    await u.Pia.call('PATCH', '/me', { countriesVisited: [] });
    expect((await u.Pia.call('GET', '/me')).json().countriesVisited).toEqual([]);
  });

  it('age filter narrows travelers and validates its range', async () => {
    const mine = async (qs: string) => (await ids('Sol', qs)).filter((id: string) => [u.Pia.id, u.Quin.id, u.Ravi.id].includes(id));
    expect(await mine('')).toHaveLength(3);
    expect(await mine('&min_age=18&max_age=25')).toEqual([u.Pia.id]);
    expect(await mine('&min_age=26&max_age=35')).toEqual([]);
    expect(await mine('&min_age=36&max_age=45')).toEqual([u.Quin.id]);
    expect(await mine('&min_age=46')).toEqual([u.Ravi.id]);
    expect(await mine('&min_age=37&max_age=50')).toEqual([]);
    expect(await mine('&max_age=36&radiusKm=5')).toEqual(expect.arrayContaining([u.Pia.id, u.Quin.id]));
    expect((await near('Sol', '&min_age=17')).statusCode).toBe(400);
    expect((await near('Sol', '&max_age=100')).statusCode).toBe(400);
    expect((await near('Sol', '&min_age=40&max_age=30')).json().error).toBe('bad_ages');
  });

  it('profile views: one row per viewer a day, skips self and blocks, gated by Plus', async () => {
    const views = () => sql`select viewer_id, viewed_at from profile_views where viewed_id = ${u.Pia.id}`;
    await u.Quin.call('GET', `/users/${u.Pia.id}`); await u.Quin.call('GET', `/users/${u.Pia.id}`);
    await u.Ravi.call('GET', `/users/${u.Pia.id}`); await u.Pia.call('GET', `/users/${u.Pia.id}`);
    await u.Pia.call('POST', `/blocks/${u.Sol.id}`);
    expect((await u.Sol.call('GET', `/users/${u.Pia.id}`)).statusCode).toBe(400);
    expect((await u.Pia.call('GET', `/users/${u.Sol.id}`)).json().blockedByMe).toBe(true);
    expect((await sql`select 1 from profile_views where viewer_id = ${u.Pia.id} or viewer_id = ${u.Sol.id}`)).toHaveLength(0);
    expect((await views()).map(r => r.viewerId).sort()).toEqual([u.Quin.id, u.Ravi.id].sort());

    // repeat views inside 24 h keep the first time; after 24 h it moves
    await sql`update profile_views set viewed_at = now() - interval '1 hour' where viewer_id = ${u.Quin.id}`;
    await u.Quin.call('GET', `/users/${u.Pia.id}`);
    const hourAgo = (await views()).find(r => r.viewerId === u.Quin.id)!.viewedAt;
    expect(Date.now() - new Date(hourAgo).getTime()).toBeGreaterThan(50 * 60_000);
    await sql`update profile_views set viewed_at = now() - interval '2 days' where viewer_id = ${u.Quin.id}`;
    await u.Quin.call('GET', `/users/${u.Pia.id}`);
    expect(Date.now() - new Date((await views()).find(r => r.viewerId === u.Quin.id)!.viewedAt).getTime()).toBeLessThan(60_000);

    // snoozed viewers leave no trace
    await u.Ravi.call('POST', '/me/snooze', { duration: '24h' });
    await u.Ravi.call('GET', `/users/${u.Quin.id}`);
    expect(await sql`select 1 from profile_views where viewer_id = ${u.Ravi.id} and viewed_id = ${u.Quin.id}`).toHaveLength(0);
    await u.Ravi.call('DELETE', '/me/snooze');

    const free = (await u.Pia.call('GET', '/me/viewers')).json();
    expect([free.count, free.locked, free.viewers]).toEqual([2, true, []]);
    await sql`update users set plus_until = now() + interval '1 day' where id = ${u.Pia.id}`;
    const plus = (await u.Pia.call('GET', '/me/viewers')).json();
    expect(plus.locked).toBe(false);
    expect(plus.viewers.map((v: any) => v.name)).toEqual(['Quin', 'Ravi']);
    // older than 30 days drops off; a block hides them too
    await sql`update profile_views set viewed_at = now() - interval '31 days' where viewer_id = ${u.Ravi.id}`;
    expect((await u.Pia.call('GET', '/me/viewers')).json().count).toBe(1);
    await u.Quin.call('POST', `/blocks/${u.Pia.id}`);
    expect((await u.Pia.call('GET', '/me/viewers')).json().count).toBe(0);
    await u.Quin.call('DELETE', `/blocks/${u.Pia.id}`);
    await sql`update users set plus_until = null where id = ${u.Pia.id}`;
  });

  it('thumbs-up: members of a started plan, once per pair per plan', async () => {
    const plan = async (startsIn: string, members: string[]) => {
      const [a] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at)
        values (${u.Pia.id}, 'Vouch test dinner', 'food', 'Soi 38', ST_SetSRID(ST_MakePoint(${BKK.lng}, ${BKK.lat}), 4326)::geography, now() + ${startsIn}::interval) returning id`;
      for (const m of members) await sql`insert into activity_members (activity_id, user_id) values (${a.id}, ${u[m].id})`;
      return a.id as string;
    };
    const past = await plan('-2 hours', ['Pia', 'Quin', 'Sol']), future = await plan('2 hours', ['Pia', 'Quin']);
    const vouch = (from: string, activityId: string, to: string) => u[from].call('POST', '/vouches', { activityId, userId: u[to].id });
    const count = async (who: string) => (await u.Ravi.call('GET', `/users/${u[who].id}`)).json().vouches;

    expect((await vouch('Quin', future, 'Pia')).json().error).toBe('plan_not_started');
    expect((await vouch('Ravi', past, 'Pia')).json().error).toBe('not_in_plan');
    expect((await vouch('Quin', past, 'Ravi')).json().error).toBe('not_in_plan');
    expect((await vouch('Quin', past, 'Quin')).statusCode).toBe(403);
    expect((await vouch('Sol', past, 'Pia')).json().error).toBe('blocked'); // Pia blocked Sol earlier
    expect((await vouch('Quin', past, 'Pia')).statusCode).toBe(200);
    expect((await vouch('Quin', past, 'Pia')).statusCode).toBe(200);
    expect(await count('Pia')).toBe(1);
    await vouch('Pia', past, 'Quin');
    expect(await count('Quin')).toBe(1);
    expect((await u.Quin.call('GET', `/vouches/${past}`)).json().given).toEqual([u.Pia.id]);
    expect((await u.Quin.call('GET', `/vouches/${future}`)).json().given).toEqual([]);
    expect((await u.Pia.call('GET', '/me')).json().vouches).toBe(1);
    await sql`update activities set status = 'cancelled' where id = ${past}`;
    expect((await vouch('Pia', past, 'Sol')).statusCode).toBe(404);
  });

  it('verification: selfie checked automatically, validation, admins only see and override, deletion clears it', async () => {
    const start = (await u.Pia.call('GET', '/verify?v=2')).json();
    expect(start.status).toBeNull();
    expect(['turn_head', 'look_up']).toContain(start.pose);
    const fixture = (f: string) => fs.readFileSync(path.resolve('src/test-fixtures/faces', f));
    const upload = async (who: string, body: Buffer) => {
      const p = (await u[who].call('POST', '/verify/upload', { contentType: 'image/jpeg' })).json();
      expect(p.key).toMatch(new RegExp(`^avatar/${u[who].id}/`));
      await app.inject({ method: 'PUT', url: new URL(p.uploadUrl).pathname, payload: body, headers: { 'content-type': 'image/jpeg' } });
      return p.key as string;
    };
    const decided = async (who: string) => {
      for (let i = 0; i < 100; i++) {
        const v = (await u[who].call('GET', '/verify?v=2')).json();
        if (v.status !== 'pending') return v;
        await new Promise(r => setTimeout(r, 100));
      }
      throw new Error('still pending');
    };
    const piaKey = await upload('Pia', fixture('same-person-turned.jpg')), quinKey = await upload('Quin', fixture('other-person-turned.jpg'));
    expect((await u.Pia.call('POST', '/verify', { key: piaKey, pose: 'turn_head' })).json().error).toBe('photo_needed');
    for (const who of ['Pia', 'Quin']) {
      const key = await upload(who, fixture('profile.jpg'));
      await u[who].call('PATCH', '/me', { photoUrl: `${config.publicUrl}/dev-files/${key}` });
    }
    expect((await u.Pia.call('POST', '/verify', { key: quinKey, pose: 'turn_head' })).json().error).toBe('bad_photo');
    expect((await u.Pia.call('POST', '/verify', { key: piaKey, pose: 'backflip' })).statusCode).toBe(400);
    // one request at a time: a pending one blocks another (inserted directly so no check runs)
    const [held] = await sql`insert into verification_requests (user_id, photo_key, pose) values (${u.Pia.id}, ${piaKey}, 'turn_head') returning id`;
    expect((await u.Pia.call('POST', '/verify', { key: piaKey, pose: 'turn_head' })).json().error).toBe('verification_pending');
    expect((await u.Pia.call('GET', '/me')).json().verification).toBe('pending');
    await sql`delete from verification_requests where id = ${held.id}`;

    // Pia matches her profile photo in the asked pose: approved with no one involved
    expect((await u.Pia.call('POST', '/verify', { key: piaKey, pose: 'turn_head' })).json().status).toBe('pending');
    expect(await decided('Pia')).toMatchObject({ verified: true, status: 'approved' });
    const pia = (await u.Pia.call('GET', '/me')).json();
    expect([pia.verified, pia.verification]).toEqual([true, 'approved']);
    expect((await u.Quin.call('GET', `/users/${u.Pia.id}`)).json().verified).toBe(true);
    expect((await u.Pia.call('POST', '/verify', { key: piaKey, pose: 'turn_head' })).json().error).toBe('already_verified');

    // Quin's selfie is someone else: rejected with a reason, free to try again
    await u.Quin.call('POST', '/verify', { key: quinKey, pose: 'turn_head' });
    expect(await decided('Quin')).toMatchObject({ verified: false, status: 'rejected', reason: 'no_match' });

    // the admin log is read-only for outcomes; overrides need an admin
    const [qr] = await sql`select id from verification_requests where user_id = ${u.Quin.id}`;
    expect((await u.Quin.call('GET', '/admin/verifications')).statusCode).toBe(403);
    expect((await u.Quin.call('POST', `/admin/verifications/${qr.id}/approve`)).statusCode).toBe(403);
    await sql`update users set role = 'admin' where id = ${u.Ravi.id}`;
    const log = (await u.Ravi.call('GET', '/admin/verifications')).json().requests;
    const quinRow = log.find((r: any) => r.id === qr.id);
    expect(quinRow).toMatchObject({ status: 'rejected', reason: 'no_match', pose: 'turn_head' });
    expect(quinRow.selfieUrl).toContain(quinKey); expect(quinRow.photoKey).toBeUndefined();
    expect(typeof quinRow.scores.similarity).toBe('number');
    expect((await u.Quin.call('POST', '/verify', { key: quinKey, pose: 'turn_head' })).json().status).toBe('pending');
    await decided('Quin');

    // account deletion removes the requests and the selfie files
    const file = path.resolve('.dev-files', quinKey);
    expect(fs.existsSync(file)).toBe(true);
    expect((await u.Quin.call('DELETE', '/me')).statusCode).toBe(200);
    expect(await sql`select 1 from verification_requests where user_id = ${u.Quin.id}`).toHaveLength(0);
    expect(await sql`select 1 from vouches where voucher_id = ${u.Quin.id} or vouched_id = ${u.Quin.id}`).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
  });
});
