// Exploits from the 3 Oct 2026 audit (audit-2026-10-03/PUNCHLIST.md) that have no feature test file of their own.
// Each test does what an attacker (or a free account) did before the fix and checks it now fails closed.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Response as InjectResponse } from 'light-my-request';

// Pushes are recorded instead of sent, so "who got a notification" can be checked.
const pushes: { to: string[]; title: string }[] = [];
vi.mock('./lib/push.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib/push.js')>()),
  notify: (to: string[], p: { title: string }) => { if (to.length) pushes.push({ to: [...to], title: p.title }); return Promise.resolve(); },
}));

const PEOPLE = ['s_ana', 's_ben', 's_cam', 's_dee', 's_eve', 's_fin', 's_gus'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@sec1003.tablamigo`).join(',');
process.env.REVIEW_CODE = '515151';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config } = await import('./lib/config.js');
const { recomputePlus } = await import('./lib/play.js');
const { REFERRAL } = await import('./lib/plus.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<InjectResponse>;
const u: Record<string, Api> = {};
const id: Record<string, string> = {};
const DAY = 86400_000;
const day = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

let ip = 60;
async function login(name: string, gender = 'woman'): Promise<Api> {
  const email = `${name}@sec1003.tablamigo`;
  const remoteAddress = `10.103.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '515151' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1994-03-03', gender, homeCountry: 'IN', travelStyle: ['foodie'], interests: ['food'] });
  id[name] = (await call('GET', '/me')).json().id;
  return call;
}
const plus = (name: string, on = true) => sql`update users set plus_until = ${on ? sql`now() + interval '30 days'` : null} where id = ${id[name]}`;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@sec1003.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p, p === 's_ben' ? 'man' : 'woman');
});
afterAll(async () => {
  config.openaiKey = '';
  await sql`delete from users where email like '%@sec1003.tablamigo'`;
  await app.close();
  await sql.end();
  vi.unstubAllGlobals();
});

describe('travel buddy requests', () => {
  let anaTrip: string;
  beforeAll(async () => {
    anaTrip = (await u.s_ana('POST', '/trips', { city: 'Hue', countryCode: 'VN', startDate: day(20), endDate: day(26) })).json().id;
    for (const p of ['s_ben', 's_cam', 's_dee', 's_eve', 's_fin']) await u[p]('POST', '/trips', { city: 'Hue', countryCode: 'VN', startDate: day(21), endDate: day(25) });
  });

  it('exploit: a flagged intro note is refused and never stored or delivered (the moderation call was not awaited)', async () => {
    config.openaiKey = 'test-key';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (!String(url).startsWith('https://api.openai.com/')) throw new Error(`unexpected fetch ${url}`);
      return new Response(JSON.stringify({ results: [{ categories: { harassment: true } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    try {
      const r = await u.s_ana('POST', `/trips/${anaTrip}/buddy-requests`, { recipientId: id.s_cam, introNote: 'something abusive' });
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('message_blocked');
    } finally { config.openaiKey = ''; vi.unstubAllGlobals(); }
    expect((await sql`select count(*)::int as n from travel_buddy_requests where sender_id = ${id.s_ana} and recipient_id = ${id.s_cam}`)[0].n).toBe(0);
    expect((await sql`select count(*)::int as n from notifications where user_id = ${id.s_cam} and kind = 'buddy_request'`)[0].n).toBe(0);
  });

  it('exploit: an intro note to a stranger cannot carry a phone number or handle (free account)', async () => {
    for (const introNote of ['call me 98765 43210', 'insta: ana.travels_22', 'mail me at ana@gmail.com']) {
      const r = await u.s_ana('POST', `/trips/${anaTrip}/buddy-requests`, { recipientId: id.s_cam, introNote });
      expect(r.statusCode, introNote).toBe(403);
      expect(r.json().error).toBe('contact_shield');
    }
    expect((await u.s_ana('POST', `/trips/${anaTrip}/buddy-requests`, { recipientId: id.s_cam, introNote: 'Same dates in Hue, coffee?' })).statusCode).toBe(200);
  });

  it('exploit: suggested companions and buddy lists keep the free 3-traveller preview', async () => {
    // Five people overlap Ana's Hue trip. /trips/:id/overlaps shows a free account 3 of them; these lists showed all 5.
    expect((await u.s_ana('GET', `/trips/${anaTrip}/overlaps`)).json().travelers).toHaveLength(3);
    const c = (await u.s_ana('GET', `/trips/${anaTrip}/buddies`)).json();
    expect(c.companions).toHaveLength(3);
    expect(c).toMatchObject({ total: 5, locked: true, hiddenCount: 2 });
    const b = (await u.s_ana('GET', '/travelers/buddies')).json();
    expect(b.buddies).toHaveLength(3);
    expect(b).toMatchObject({ total: 5, locked: true, hiddenCount: 2 });
    await plus('s_ana');
    expect((await u.s_ana('GET', `/trips/${anaTrip}/buddies`)).json().companions).toHaveLength(5);
    expect((await u.s_ana('GET', '/travelers/buddies')).json().buddies).toHaveLength(5);
    await plus('s_ana', false);
  });
});

describe('trip circles', () => {
  const trips: Record<string, string> = {};
  let chatId: string;
  beforeAll(async () => {
    for (const p of ['s_ana', 's_ben', 's_cam', 's_dee', 's_eve', 's_fin']) {
      trips[p] = (await u[p]('POST', '/trips', { city: 'Valletta', countryCode: 'MT', startDate: day(40), endDate: day(45) })).json().id;
      chatId = (await u[p]('POST', `/trips/${trips[p]}/group-chat`)).json().chatId;
    }
    trips.s_gus = (await u.s_gus('POST', '/trips', { city: 'Mdina', countryCode: 'MT', startDate: day(40), endDate: day(45) })).json().id;
    await u.s_gus('POST', `/trips/${trips.s_gus}/group-chat`);
  });

  it('exploit: live location is refused in a trip circle (strangers with a trip to the same city that month)', async () => {
    const r = await u.s_ana('POST', `/chats/${chatId}/locations`, { lat: 35.9, lng: 14.51, minutes: 15 });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('no_location_in_trip_chat');
    expect((await sql`select count(*)::int as n from messages where chat_id = ${chatId} and kind = 'location'`)[0].n).toBe(0);
  });

  it('exploit: the member directory drops blocked and snoozed people and keeps the free preview', async () => {
    const names = async () => ((await u.s_ana('GET', `/trips/${trips.s_ana}/circle-directory`)).json().members as any[]).map(m => m.id);
    await plus('s_ana');
    expect(await names()).toHaveLength(6);
    await u.s_ben('POST', `/blocks/${id.s_ana}`);
    await sql`update users set snoozed_until = now() + interval '1 day' where id = ${id.s_cam}`;
    const seen = await names();
    expect(seen).not.toContain(id.s_ben);
    expect(seen).not.toContain(id.s_cam);
    expect(seen).toHaveLength(4);
    await plus('s_ana', false);
    const free = (await u.s_ana('GET', `/trips/${trips.s_ana}/circle-directory`)).json();
    expect(free.members).toHaveLength(3);
    expect(free).toMatchObject({ locked: true, hiddenCount: 1 });
    await u.s_ben('DELETE', `/blocks/${id.s_ana}`);
    await sql`update users set snoozed_until = null where id = ${id.s_cam}`;
  });

  it('exploit: the circle preview (faces and count on the trip screen) follows the directory rules: no blocked or snoozed people, 3 faces for a free account', async () => {
    const preview = async (who: string) => (await u[who]('GET', `/trips/${trips[who]}/group-chat`)).json();
    // Six people are in the circle. Before, anyone with a trip there that month got 6 faces with names, whoever they had blocked.
    const free = await preview('s_ana');
    expect(free.memberCount).toBe(6);
    expect(free.members).toHaveLength(3);
    await plus('s_ana');
    expect((await preview('s_ana')).members).toHaveLength(6);

    await u.s_ben('POST', `/blocks/${id.s_ana}`);
    await sql`update users set snoozed_until = now() + interval '1 day' where id = ${id.s_cam}`;
    const seen = await preview('s_ana');
    expect(seen.memberCount).toBe(4);
    expect(seen.members.map((m: any) => m.id).sort()).toEqual([id.s_ana, id.s_dee, id.s_eve, id.s_fin].sort());
    // The block works both ways: Ben doesn't see Ana either.
    expect((await preview('s_ben')).members.map((m: any) => m.id)).not.toContain(id.s_ana);
    await plus('s_ana', false);
    expect((await preview('s_ana')).members).toHaveLength(3);
    await u.s_ben('DELETE', `/blocks/${id.s_ana}`);
    await sql`update users set snoozed_until = null where id = ${id.s_cam}`;
  });

  it('exploit: only members of a circle can vote on its proposals, and a vote counts once', async () => {
    const p = (await u.s_ana('POST', `/trips/${trips.s_ana}/circle-proposals`, { title: 'Harbour ferry ride', category: 'culture', proposedDate: day(41) })).json().proposal;
    // Gus is in the Mdina circle: his trip id plus a Valletta proposal id used to count his vote.
    const outsider = await u.s_gus('POST', `/trips/${trips.s_gus}/circle-proposals/${p.id}/vote`);
    expect(outsider.statusCode).toBe(404);
    // A trip that isn't yours doesn't work either.
    expect((await u.s_gus('POST', `/trips/${trips.s_dee}/circle-proposals/${p.id}/vote`)).statusCode).toBe(404);
    // Someone who left the circle can't vote.
    await u.s_fin('DELETE', `/trips/${trips.s_fin}/group-chat`);
    expect((await u.s_fin('POST', `/trips/${trips.s_fin}/circle-proposals/${p.id}/vote`)).statusCode).toBe(403);
    // Many taps at once: the vote toggles atomically, never two entries for one person.
    await Promise.all(Array.from({ length: 6 }, () => u.s_dee('POST', `/trips/${trips.s_dee}/circle-proposals/${p.id}/vote`)));
    const [row] = await sql`select votes from trip_circle_proposals where id = ${p.id}`;
    expect(row.votes.filter((v: string) => v === id.s_dee).length).toBeLessThanOrEqual(1);
    expect(row.votes).not.toContain(id.s_gus);
    expect(row.votes).not.toContain(id.s_fin);
  });
});

describe('declined DM requests', () => {
  it('exploit: a declined request stays declined when the sender reopens it, and the decliner gets no pushes', async () => {
    const chatId = (await u.s_eve('POST', `/dm/${id.s_fin}`)).json().chatId;
    await u.s_eve('POST', `/chats/${chatId}/messages`, { body: 'hi there' });
    expect((await u.s_fin('POST', `/chats/${chatId}/decline-request`, {})).json().status).toBe('declined');
    pushes.length = 0;

    // Reopening used to reset the request to pending (the old dm_key upsert).
    await u.s_eve('POST', `/dm/${id.s_fin}`);
    const [m] = await sql`select request_status from chat_members where chat_id = ${chatId} and user_id = ${id.s_fin}`;
    expect(m.requestStatus).toBe('declined');
    await plus('s_eve');   // Plus senders have no "wait for a reply" limit
    for (let i = 0; i < 3; i++) expect((await u.s_eve('POST', `/chats/${chatId}/messages`, { body: `still there? ${i}` })).statusCode).toBe(200);
    await plus('s_eve', false);
    expect(pushes.flatMap(p => p.to)).not.toContain(id.s_fin);
    expect((await u.s_fin('GET', '/chats')).json().chats.map((c: any) => c.id)).not.toContain(chatId);

    // Fin can still open it herself later, which accepts it on her side.
    await u.s_fin('POST', `/dm/${id.s_eve}`);
    const [m2] = await sql`select request_status from chat_members where chat_id = ${chatId} and user_id = ${id.s_fin}`;
    expect(m2.requestStatus).toBe('accepted');
    pushes.length = 0;
    await u.s_fin('POST', `/chats/${chatId}/messages`, { body: 'oh hi' });
    expect((await u.s_eve('POST', `/chats/${chatId}/messages`, { body: 'hello again' })).statusCode).toBe(200);
    expect(pushes.flatMap(p => p.to)).toContain(id.s_fin);
  });
});

describe('referral rewards', () => {
  it('exploit: referral days go through comp_until + recomputePlus, so a billing event no longer erases them', async () => {
    const code = (await u.s_gus('GET', '/me/referral')).json().referralCode;
    const r = await u.s_dee('POST', '/me/referral/redeem', { code });
    expect(r.statusCode).toBe(200);
    expect(r.json().referrerRewarded).toBe(true);
    for (const who of ['s_dee', 's_gus']) {
      const [x] = await sql`select plus_until, comp_until from users where id = ${id[who]}`;
      expect(new Date(x.compUntil).getTime()).toBeGreaterThan(Date.now() + 6.9 * DAY);
      // Before, plus_until was written by hand and the next recomputePlus (any Play/Razorpay event) set it back to null.
      await recomputePlus(id[who]);
      const [y] = await sql`select plus_until from users where id = ${id[who]}`;
      expect(new Date(y.plusUntil).getTime()).toBe(new Date(x.compUntil).getTime());
    }
    expect((await u.s_dee('POST', '/me/referral/redeem', { code })).json().error).toBe('already_referred');
  });

  it(`exploit: old accounts can't redeem, and a referrer earns at most ${REFERRAL.maxRewards} rewards`, async () => {
    const code = (await u.s_ana('GET', '/me/referral')).json().referralCode;
    await sql`update users set created_at = now() - interval '60 days' where id = ${id.s_eve}`;
    const old = await u.s_eve('POST', '/me/referral/redeem', { code });
    expect(old.statusCode).toBe(400);
    expect(old.json().error).toBe('referral_new_accounts_only');

    // Ana already has the maximum number of sign-ups: the next one still gets the welcome gift, Ana gets nothing more.
    const fakes = await sql`insert into users (email, referred_by) select 'fake' || g || '@sec1003.tablamigo', ${id.s_ana}::uuid
      from generate_series(1, ${REFERRAL.maxRewards}) g returning id`;
    expect(fakes).toHaveLength(REFERRAL.maxRewards);
    const before = (await sql`select comp_until from users where id = ${id.s_ana}`)[0].compUntil;
    const r = await u.s_fin('POST', '/me/referral/redeem', { code });
    expect(r.statusCode).toBe(200);
    expect(r.json().referrerRewarded).toBe(false);
    expect((await sql`select comp_until from users where id = ${id.s_ana}`)[0].compUntil).toEqual(before);
    expect((await u.s_fin('GET', '/me')).json().plus).toBe(true);
    // The referral screen counts what was earned, not every sign-up: it showed 11 x 7 days when 10 x 7 were paid out.
    const summary = (await u.s_ana('GET', '/me/referral')).json();
    expect(summary).toMatchObject({ rewardDays: REFERRAL.rewardDays, maxRewards: REFERRAL.maxRewards, totalReferred: REFERRAL.maxRewards + 1, daysEarned: REFERRAL.maxRewards * REFERRAL.rewardDays });
  });
});

describe('SOS numbers', () => {
  const PHUKET = { lat: 7.8804, lng: 98.3923 };   // geo cell '7.9,98.4'
  let planId: string;
  beforeAll(async () => {
    await sql`delete from geo_cache where cell = '7.9,98.4'`;
    // Nominatim answers with nothing while the plan is posted, so the plan's cell is not in the cache.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })));
    try {
      const r = await u.s_gus('POST', '/activities', { title: 'Old Town walk', category: 'culture', placeName: 'Thalang Road', ...PHUKET,
        startsAt: new Date(Date.now() + 3 * 3600_000).toISOString() });
      expect(r.statusCode).toBe(200);
      planId = r.json().id;
    } finally { vi.unstubAllGlobals(); }
  });
  afterAll(async () => { await sql`delete from geo_cache where cell = '7.9,98.4'`; });

  it('exploit: an SOS never waits on a slow reverse-geocode (it waited up to 4 s) and falls back to 112', async () => {
    let lookups = 0;
    // A Nominatim that never answers, until the 4 s timeout aborts the request.
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      lookups++;
      return new Promise<Response>((_, no) => init?.signal?.addEventListener('abort', () => no(new Error('aborted'))));
    }));
    try {
      for (const [url, body] of [[`/activities/${planId}/sos`, {}], ['/safety/sos/dispatch', { activityId: planId }], ['/safety/sos/dispatch', PHUKET]] as const) {
        const t0 = Date.now();
        const r = await u.s_gus('POST', url, body);
        expect(r.statusCode, url).toBe(200);
        expect(Date.now() - t0, url).toBeLessThan(1500);
        expect(r.json().emergencyNumbers, url).toEqual({ police: '112', ambulance: '112', general: '112' });
      }
      // The miss starts a lookup in the background, so the next SOS there has local numbers.
      await new Promise(r => setTimeout(r, 300));
      expect(lookups).toBeGreaterThan(0);
    } finally { vi.unstubAllGlobals(); }

    // A cached cell gives the plan's local numbers, however old the entry (a cell's country doesn't change).
    await sql`insert into geo_cache (cell, city, country, cached_at) values ('7.9,98.4', 'Phuket', 'TH', now() - interval '90 days')
      on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = excluded.cached_at`;
    expect((await u.s_gus('POST', `/activities/${planId}/sos`, {})).json().emergencyNumbers.police).toBe('191');
    expect((await u.s_gus('POST', '/safety/sos/dispatch', PHUKET)).json().emergencyNumbers.police).toBe('191');
  });
});
