// Ads only for free accounts (owner, 2 Nov 2026). The Android app shows its one banner, and the "Remove ads · Get Plus" link under
// it, only when GET /me says plus: false and allFree is not on (apps/mobile/src/lib/ads-config.ts showsAds, whose unit test in
// apps/mobile/e2e-web/ads.test.mjs takes these same answers). This drives the real GET /me for every way of having Plus, then
// checks the link's paywall_viewed event. `showsAds` below is that rule, restated: the API's tests can't load the app's code.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { issueTokens } = await import('../../lib/auth.js');
const { recomputePlus } = await import('../../lib/play.js');
const showsAds = (m: any) => !!m && typeof m === 'object' && m.plus === false && m.allFree !== true;
const REMOVE_ADS_HREF = '/paywall?reason=remove_ads';   // apps/mobile/src/lib/ads-config.ts REMOVE_ADS_LINK.href

const D = '@removeads.tablamigo';
let app: Awaited<ReturnType<typeof build>>;
let ipN = 0;
type P = { id: string; call: (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response> };

async function person(local: string): Promise<P> {
  const [u] = await sql`insert into users (email) values (${local + D}) returning id`;
  const { accessToken } = await issueTokens(u.id);
  const remoteAddress = `10.79.${Math.floor(++ipN / 250) % 250}.${(ipN % 250) + 1}`;
  return { id: u.id, call: (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${accessToken}` }, remoteAddress }) };
}
const me = async (p: P) => { const r = await p.call('GET', '/me'); expect(r.statusCode).toBe(200); return r.json(); };
const sub = (p: P, status: string, expires: string) => sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at)
  values (${'test-removeads-' + p.id + status}, ${p.id}, 'google', 'tablamigo_plus', ${status}, ${expires}::timestamptz)`;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await app.close();
  await sql.end();
});

describe('who gets the ad (and the link under it)', () => {
  it('a free account does', async () => {
    const free = await person('free');
    expect(showsAds(await me(free))).toBe(true);
  });

  it('never a paying or comped account: subscription, renewal in grace, cancelled but paid up, Trip Pass bought or redeemed, comp', async () => {
    const cases: [string, (p: P) => Promise<unknown>][] = [
      ['subscriber', p => sub(p, 'SUBSCRIPTION_STATE_ACTIVE', new Date(Date.now() + 30 * 86400_000).toISOString())],
      ['grace', p => sub(p, 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', new Date(Date.now() + 3 * 86400_000).toISOString())],
      ['cancelled', p => sub(p, 'SUBSCRIPTION_STATE_CANCELED', new Date(Date.now() + 10 * 86400_000).toISOString())],
      ['pass', p => sql`insert into passes (purchase_token, user_id, product_id, expires_at) values (${'test-removeads-pass-' + p.id}, ${p.id}, 'tablamigo_trip_pass', now() + interval '14 days')`],
      ['comp', p => sql`update users set comp_until = now() + interval '7 days' where id = ${p.id}`],
    ];
    for (const [name, give] of cases) {
      const p = await person(name);
      await give(p);
      await recomputePlus(p.id);
      const m = await me(p);
      expect(m.plus, name).toBe(true);
      expect(showsAds(m), name).toBe(false);
    }
    const wallet = await person('wallet');
    await sql`update users set trip_passes_available = 1 where id = ${wallet.id}`;
    expect((await wallet.call('POST', '/me/trip-pass/redeem', {})).statusCode).toBe(200);
    expect(showsAds(await me(wallet))).toBe(false);
  });

  it('Plus that has ended is a free account again', async () => {
    const lapsed = await person('lapsed');
    await sub(lapsed, 'SUBSCRIPTION_STATE_EXPIRED', new Date(Date.now() - 86400_000).toISOString());
    await recomputePlus(lapsed.id);
    expect(showsAds(await me(lapsed))).toBe(true);
  });

  it('nobody while everything is free', async () => {
    const free = await person('allfree');
    const was = config.allFree;
    (config as any).allFree = true;
    try { expect(showsAds(await me(free))).toBe(false); } finally { (config as any).allFree = was; }
  });

  it('nobody before /me answers, or when it fails', async () => {
    expect(showsAds(undefined)).toBe(false);
    const anon = await app.inject({ method: 'GET', url: '/me' });
    expect(anon.statusCode).toBe(401);
    expect(showsAds(anon.json())).toBe(false);
  });
});

describe('the link opens the paywall with reason remove_ads, recorded like any paywall view', () => {
  it('remove_ads is stored as sent', async () => {
    const p = await person('tapper');
    const reason = new URL(REMOVE_ADS_HREF, 'https://x').searchParams.get('reason');
    expect(reason).toBe('remove_ads');
    const r = await p.call('POST', '/analytics/events', { event: 'paywall_viewed', properties: { reason, surface: 'native' } });
    expect(r.statusCode).toBe(200);
    const [row] = await sql`select properties from analytics_events where user_id = ${p.id} and event_name = 'paywall_viewed'`;
    expect(row.properties).toEqual({ reason: 'remove_ads', surface: 'native' });
  });

  it('a made-up, oversized or non-string reason is stored as other, in a batch too; no reason and other events are kept as sent', async () => {
    const p = await person('prober');
    const junk = ['__proto__', 'constructor', '<img src=x onerror=alert(1)>', 'x'.repeat(900), 42, { nested: 'remove_ads' }];
    const r = await p.call('POST', '/analytics/events', { events: [
      ...junk.map(reason => ({ event: 'paywall_viewed', properties: { reason, surface: 'web' } })),
      { event: 'paywall_viewed', properties: { surface: 'web' } },
      { event: 'plan_joined', properties: { reason: 'anything' } },
    ] });
    expect(r.statusCode).toBe(200);
    const rows = await sql`select event_name, properties from analytics_events where user_id = ${p.id} order by id`;
    expect(rows.filter(x => x.eventName === 'paywall_viewed').map(x => x.properties.reason)).toEqual([...junk.map(() => 'other'), undefined]);
    expect(rows.find(x => x.eventName === 'plan_joined')!.properties).toEqual({ reason: 'anything' });
  });

  it('the body limits still apply before any of this (a 1 KB properties cap)', async () => {
    const p = await person('big');
    const r = await p.call('POST', '/analytics/events', { event: 'paywall_viewed', properties: { reason: 'x'.repeat(2000) } });
    expect(r.statusCode).toBe(400);
  });
});
