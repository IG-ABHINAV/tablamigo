import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['gm_maya', 'gm_noah', 'gm_admin'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@growth.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'gm_admin@growth.tablamigo';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 1200;
async function login(name: string): Promise<Api> {
  const email = `${name}@growth.tablamigo`;
  const remoteAddress = `10.98.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', {
    name,
    birthdate: '1995-05-15',
    gender: 'woman',
    homeCountry: 'ES',
    interests: ['food', 'nightlife']
  });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@growth.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@growth.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
  // Set locations in Mumbai
  const mayaId = await idOf('gm_maya');
  const noahId = await idOf('gm_noah');
  await sql`update users set location = ST_SetSRID(ST_MakePoint(72.85, 18.9), 4326)::geography, location_at = now() where id = any(${[mayaId, noahId]}::uuid[])`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@growth.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Growth & Monetization (Boost, Incognito, Trip Pass Bundles, Analytics)', () => {
  it('Profile Boost: free user is rejected with 403 plus_required; Plus user can boost and ranks at top of travelers', async () => {
    const mayaId = await idOf('gm_maya');
    const noahId = await idOf('gm_noah');

    // Free user Maya tries to boost -> 403
    const freeRes = await u['gm_maya']('POST', '/me/boost');
    expect(freeRes.statusCode).toBe(403);
    expect(freeRes.json().error).toBe('plus_required');

    // Give Noah Plus
    await sql`update users set plus_until = now() + interval '30 days' where id = ${noahId}`;

    // Noah boosts profile
    const boostRes = await u['gm_noah']('POST', '/me/boost');
    expect(boostRes.statusCode).toBe(200);
    expect(boostRes.json().isBoosted).toBe(true);
    expect(boostRes.json().boostedUntil).toBeTruthy();

    // Check Noah's /me
    const meRes = await u['gm_noah']('GET', '/me');
    expect(meRes.json().isBoosted).toBe(true);
    expect(meRes.json().boostedUntil).toBeTruthy();

    // Maya queries /travelers; Noah should have boosted=true and be first
    const travRes = await u['gm_maya']('GET', '/travelers?lat=18.9&lng=72.85');
    expect(travRes.statusCode).toBe(200);
    const noahEntry = travRes.json().travelers.find((t: any) => t.id === noahId);
    expect(noahEntry).toBeTruthy();
    expect(noahEntry.boosted).toBe(true);
    expect(travRes.json().travelers[0].id).toBe(noahId);

    // Maya views Noah's public profile
    const profRes = await u['gm_maya']('GET', `/users/${noahId}`);
    expect(profRes.statusCode).toBe(200);
    expect(profRes.json().isBoosted).toBe(true);
  });

  it('Incognito Mode: free user rejected with 403; Plus user can enable, and browsing leaves no profile_views record', async () => {
    const mayaId = await idOf('gm_maya');
    const noahId = await idOf('gm_noah');

    // Maya is free, tries to enable incognito -> 403
    const freeRes = await u['gm_maya']('POST', '/me/incognito', { enabled: true });
    expect(freeRes.statusCode).toBe(403);
    expect(freeRes.json().error).toBe('plus_required');

    // Noah (Plus) enables incognito
    const incogRes = await u['gm_noah']('POST', '/me/incognito', { enabled: true });
    expect(incogRes.statusCode).toBe(200);
    expect(incogRes.json().isIncognito).toBe(true);

    const meRes = await u['gm_noah']('GET', '/me');
    expect(meRes.json().isIncognito).toBe(true);

    // Clear any previous profile views between Noah and Maya
    await sql`delete from profile_views where viewer_id = ${noahId} or viewed_id = ${noahId}`;

    // Noah views Maya's profile while incognito
    const viewRes = await u['gm_noah']('GET', `/users/${mayaId}`);
    expect(viewRes.statusCode).toBe(200);

    // Ensure NO profile_views row was inserted
    const views = await sql`select 1 from profile_views where viewer_id = ${noahId} and viewed_id = ${mayaId}`;
    expect(views.length).toBe(0);

    // Noah turns off incognito
    await u['gm_noah']('POST', '/me/incognito', { enabled: false });

    // Noah views Maya's profile again -> now recorded!
    await u['gm_noah']('GET', `/users/${mayaId}`);
    const viewsAfter = await sql`select 1 from profile_views where viewer_id = ${noahId} and viewed_id = ${mayaId}`;
    expect(viewsAfter.length).toBe(1);
  });

  it('Trip Pass Bundles: can hold multiple passes and redeem 14-day passes sequentially', async () => {
    const mayaId = await idOf('gm_maya');

    // Currently 0 passes available
    const meBefore = await u['gm_maya']('GET', '/me');
    expect(meBefore.json().tripPassesAvailable).toBe(0);

    // Trying to redeem with 0 available -> 400
    const failRedeem = await u['gm_maya']('POST', '/me/trip-pass/redeem');
    expect(failRedeem.statusCode).toBe(400);
    expect(failRedeem.json().error).toBe('no_trip_passes_available');

    // Bundles are not on sale: the endpoint that handed out passes without payment is gone (410) and adds nothing.
    const bundleRes = await u['gm_maya']('POST', '/me/trip-pass/bundle', { count: 3 });
    expect(bundleRes.statusCode).toBe(410);
    expect((await u['gm_maya']('GET', '/me')).json().tripPassesAvailable).toBe(0);

    // Passes credited to the wallet the way a verified purchase would.
    await sql`update users set trip_passes_available = 3 where id = ${mayaId}`;

    // Redeem 1 pass -> gives 14 days of Plus and 2 passes left
    const redeemRes = await u['gm_maya']('POST', '/me/trip-pass/redeem');
    expect(redeemRes.statusCode).toBe(200);
    expect(redeemRes.json().tripPassesAvailable).toBe(2);
    expect(new Date(redeemRes.json().plusUntil).getTime()).toBeGreaterThan(Date.now() + 13 * 86400 * 1000);

    const meAfter = await u['gm_maya']('GET', '/me');
    expect(meAfter.json().tripPassesAvailable).toBe(2);
    expect(meAfter.json().plus).toBe(true);
  });

  it('Analytics Events & Funnels: records user activation events and admin can read funnel summary', async () => {
    const mayaId = await idOf('gm_maya');

    // Post individual and batch events
    const singleRes = await u['gm_maya']('POST', '/analytics/events', {
      event: 'plan_joined',
      properties: { city: 'Mumbai', category: 'food' }
    });
    expect(singleRes.statusCode).toBe(200);
    expect(singleRes.json().recorded).toBe(1);

    const batchRes = await u['gm_maya']('POST', '/analytics/events', {
      events: [
        { event: 'safety_shared', properties: { mode: 'whatsapp' } },
        { event: 'paywall_viewed', properties: { feature: 'boost' } }
      ]
    });
    expect(batchRes.statusCode).toBe(200);
    expect(batchRes.json().recorded).toBe(2);

    // Admin checks analytics summary
    const adminRes = await u['gm_admin']('GET', '/admin/analytics');
    expect(adminRes.statusCode).toBe(200);
    const summary = adminRes.json().summary;
    expect(Array.isArray(summary)).toBe(true);
    const planJoined = summary.find((s: any) => s.eventName === 'plan_joined');
    expect(planJoined).toBeTruthy();
    expect(planJoined.total).toBeGreaterThanOrEqual(1);
  });

  it('exploit: anonymous analytics batches are capped at 50 events and stored in one insert', async () => {
    const ev = (n: number) => Array.from({ length: n }, (_, i) => ({ event: 'cap_probe_event', properties: { i } }));
    const before = (await sql`select count(*)::int as n from analytics_events where event_name = 'cap_probe_event'`)[0].n;
    // One request used to insert any number of rows, one at a time, with no sign-in.
    const tooMany = await app.inject({ method: 'POST', url: '/analytics/events', payload: { events: ev(51) } });
    expect(tooMany.statusCode).toBe(400);
    const huge = await app.inject({ method: 'POST', url: '/analytics/events', payload: { events: ev(5000) } });
    expect(huge.statusCode).toBe(413);   // over the 64 KB body limit of this endpoint, so refused before it is read
    expect((await sql`select count(*)::int as n from analytics_events where event_name = 'cap_probe_event'`)[0].n).toBe(before);
    const ok = await app.inject({ method: 'POST', url: '/analytics/event', payload: { events: ev(50) } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().recorded).toBe(50);
    expect((await sql`select count(*)::int as n from analytics_events where event_name = 'cap_probe_event' and user_id is null`)[0].n).toBe(before + 50);
    await sql`delete from analytics_events where event_name = 'cap_probe_event'`;
  });

  it('exploit: anonymous analytics events are size-bounded (properties, name, body) and rate limited', async () => {
    const post = (payload: unknown, remoteAddress = '10.150.0.1') => app.inject({ method: 'POST', url: '/analytics/events', payload: payload as any, remoteAddress });
    const rows = () => sql`select count(*)::int as n from analytics_events where event_name = 'size_probe_event'`.then(r => r[0].n as number);
    const before = await rows();
    // Before: one event could carry any properties, up to the 1 MB body limit, and every request stored all of it.
    const bad = [
      { event: 'size_probe_event', properties: { blob: 'x'.repeat(5000) } },
      { event: 'size_probe_event', properties: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) },
      { event: 'size_probe_event', properties: { nested: JSON.parse('['.repeat(300) + ']'.repeat(300)) as unknown, big: 'y'.repeat(2000) } },
      { event: 'size_probe_event', properties: { ['k'.repeat(41)]: 1 } },
      { event: 'e'.repeat(65), properties: {} },
      { event: 'size_probe_event', timestamp: 't'.repeat(41) },
      { events: [{ event: 'size_probe_event' }, { event: 'size_probe_event', properties: { blob: 'x'.repeat(5000) } }] },   // one bad event refuses the batch
    ];
    for (const [i, payload] of bad.entries()) {
      const r = await post(payload);
      expect(r.statusCode, `case ${i}`).toBe(400);
    }
    expect(await rows()).toBe(before);

    // A body over 64 KB is refused before it is parsed, whatever the events in it say.
    const big = await post({ event: 'size_probe_event', junk: 'z'.repeat(70_000) });
    expect(big.statusCode).toBe(413);
    expect(big.json().error).toBe('too_large');
    expect(await rows()).toBe(before);

    // The largest legal request still works: 50 events of about 1 KB each.
    const kb = { event: 'size_probe_event', properties: { note: 'n'.repeat(1000) } };
    const full = await post({ events: Array.from({ length: 50 }, () => kb) });
    expect(full.statusCode).toBe(200);
    expect(full.json().recorded).toBe(50);
    expect(await rows()).toBe(before + 50);
    await sql`delete from analytics_events where event_name = 'size_probe_event'`;

    // One client gets 60 requests a minute on this endpoint (the global limit is 300 for everything).
    const codes: number[] = [];
    for (let i = 0; i < 62; i++) codes.push((await post({ event: 'rate_probe_event' }, '10.150.0.2')).statusCode);
    expect(codes.slice(0, 60).every(c => c === 200)).toBe(true);
    expect(codes.slice(60)).toEqual([429, 429]);
    await sql`delete from analytics_events where event_name = 'rate_probe_event'`;
  });
});
