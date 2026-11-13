import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['pass_traveler'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@pass.tablamigo`).join(',');
process.env.REVIEW_CODE = '777777';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 2100;
async function login(name: string): Promise<Api> {
  const email = `${name}@pass.tablamigo`;
  const remoteAddress = `10.99.11.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '777777' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1996-06-06', gender: 'woman', homeCountry: 'IN' });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@pass.tablamigo'`;
  u.pass_traveler = await login('pass_traveler');
});

afterAll(async () => {
  await sql`delete from users where email like '%@pass.tablamigo'`;
  await app.close();
});

const DAY = 86400_000;
const passesOf = async () => (await sql`select trip_passes_available as n, plus_until from users where email = 'pass_traveler@pass.tablamigo'`)[0];

describe('Backlog 30: Trip Pass wallet (bundles switched off)', () => {
  it('GET /me/trip-passes shows no bundle catalogue: bundles are not on sale', async () => {
    const res = await u.pass_traveler('GET', '/me/trip-passes');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(0);
    expect(body.bundles).toEqual([]);
    expect(body.bundlesAvailable).toBe(false);
    expect(body.wallet).toEqual([]);
    expect(body.redemptions).toEqual([]);
  });

  it('exploit: POST /me/trip-pass/bundle no longer hands out passes (it gave 1-10 with no payment)', async () => {
    for (const payload of [{}, { count: 10 }, { count: 3, priceCents: 69900 }, { count: 10, source: 'admin_comp', priceCents: 0, orderId: 'order_fake' }]) {
      const res = await u.pass_traveler('POST', '/me/trip-pass/bundle', payload);
      expect(res.statusCode).toBe(410);
      expect(res.json().error).toBe('trip_pass_bundles_unavailable');
    }
    expect((await passesOf()).n).toBe(0);
    const id = (await u.pass_traveler('GET', '/me')).json().id;
    expect((await sql`select count(*)::int as n from trip_pass_wallet where user_id = ${id}`)[0].n).toBe(0);
    expect((await u.pass_traveler('GET', '/me')).json().plus).toBe(false);
  });

  it('rejects redemption when available balance is 0', async () => {
    const res = await u.pass_traveler('POST', '/me/trip-pass/redeem', {});
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('no_trip_passes_available');
  });

  it('redeems a held pass through passes + recomputePlus, so a later billing event keeps the days', async () => {
    // Two passes credited to the wallet, as a verified purchase would (no route does this today).
    const id = (await u.pass_traveler('GET', '/me')).json().id;
    const [w] = await sql`insert into trip_pass_wallet (user_id, source, passes_added, passes_remaining, price_cents)
      values (${id}, 'purchase_bundle', 2, 2, 59800) returning id`;
    await sql`update users set trip_passes_available = 2 where id = ${id}`;

    const res = await u.pass_traveler('POST', '/me/trip-pass/redeem', {});
    expect(res.statusCode).toBe(200);
    expect(res.json().tripPassesAvailable).toBe(1);
    const until = new Date(res.json().plusUntil).getTime();
    expect(until).toBeGreaterThan(Date.now() + 13.9 * DAY);
    expect(until).toBeLessThan(Date.now() + 14.1 * DAY);
    expect((await u.pass_traveler('GET', '/me')).json().plus).toBe(true);

    // The 14 days are a pass row, not a hand-written plus_until.
    const [p] = await sql`select purchase_token, expires_at from passes where user_id = ${id}`;
    expect(p.purchaseToken).toMatch(/^wallet:/);
    expect(new Date(p.expiresAt).getTime()).toBe(until);

    // Before, the next recompute (any Play/Razorpay event, an admin comp) erased redeemed days. Now it keeps them.
    const { recomputePlus } = await import('./lib/play.js');
    await recomputePlus(id);
    expect(new Date((await passesOf()).plusUntil).getTime()).toBe(until);

    const state = (await u.pass_traveler('GET', '/me/trip-passes')).json();
    expect(state.available).toBe(1);
    expect(state.wallet.find((x: any) => x.id === w.id).passesRemaining).toBe(1);
    expect(state.redemptions).toHaveLength(1);
    expect(state.redemptions[0].daysGranted).toBe(14);
  });

  it('links a pass to a planned trip and stacks another 14 days', async () => {
    const trip = (await u.pass_traveler('POST', '/trips', { city: 'Goa', countryCode: 'IN', startDate: '2026-11-10', endDate: '2026-11-20' })).json();
    const before = new Date((await passesOf()).plusUntil).getTime();
    const res = await u.pass_traveler('POST', '/me/trip-pass/redeem', { tripId: trip.id });
    expect(res.statusCode).toBe(200);
    expect(res.json().tripPassesAvailable).toBe(0);
    expect(Math.round((new Date(res.json().plusUntil).getTime() - before) / DAY)).toBe(14);
    const linked = (await u.pass_traveler('GET', '/me/trip-passes')).json().redemptions.find((r: any) => r.tripId === trip.id);
    expect(linked.city).toBe('Goa');
    expect(linked.countryCode).toBe('IN');
  });

  it('exploit: two redeems at once spend one pass once', async () => {
    const id = (await u.pass_traveler('GET', '/me')).json().id;
    await sql`update users set trip_passes_available = 1 where id = ${id}`;
    const before = (await sql`select count(*)::int as n from passes where user_id = ${id}`)[0].n;
    const results = await Promise.all(Array.from({ length: 5 }, () => u.pass_traveler('POST', '/me/trip-pass/redeem', {})));
    expect(results.filter(r => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter(r => r.statusCode === 400)).toHaveLength(4);
    expect((await sql`select count(*)::int as n from passes where user_id = ${id}`)[0].n).toBe(before + 1);
    expect((await passesOf()).n).toBe(0);
  });

  it('rejects redemption for a nonexistent trip id', async () => {
    const res = await u.pass_traveler('POST', '/me/trip-pass/redeem', {
      tripId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.statusCode).toBe(404);
  });
});
