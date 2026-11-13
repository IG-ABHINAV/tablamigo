// Share links to a plan (lib/share-links.ts, routes/shares.ts): random tokens, a public read-only page that is not a
// live location, links that expire, and links their owner can turn off.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';

const PEOPLE = ['sl_host', 'sl_guest', 'sl_other'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@sl.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config } = await import('./lib/config.js');
const { newShareToken, shareExpiry, SHARE_AFTER_START_MS, SHARE_MIN_MS, SHARE_MAX_MS } = await import('./lib/share-links.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<Awaited<ReturnType<typeof app.inject>>>;

let ip = 2700;
async function login(name: string, gender: 'woman' | 'man'): Promise<Api> {
  const email = `${name}@sl.tablamigo`;
  const remoteAddress = `10.95.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1996-06-06', gender, homeCountry: 'IN' });
  return call;
}
const view = (token: string) => app.inject({ method: 'GET', url: `/safe/${token}` });

const u: Record<string, Api> = {};
let near: string, far: string;
const DAY = 86400_000;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@sl.tablamigo'`;
  await sql`insert into geo_cache (cell, city, country) values ('18.9,72.85', 'Mumbai', 'IN') on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = now()`;
  u.sl_host = await login('sl_host', 'woman');
  u.sl_guest = await login('sl_guest', 'woman');
  u.sl_other = await login('sl_other', 'man');
  // Plus, so the free limit of two new plans a day doesn't get in the way of the third plan below.
  await sql`update users set plus_until = now() + interval '30 days' where email = 'sl_host@sl.tablamigo'`;
  const plan = { category: 'explore', placeName: 'Colaba Causeway', lat: 18.9218, lng: 72.8347, maxPeople: 6 };
  near = (await u.sl_host('POST', '/activities', { ...plan, title: 'Colaba walk', startsAt: new Date(Date.now() + DAY).toISOString() })).json().id;
  far = (await u.sl_host('POST', '/activities', { ...plan, title: 'Colaba walk, in three weeks', startsAt: new Date(Date.now() + 25 * DAY).toISOString() })).json().id;
  expect((await u.sl_guest('POST', `/activities/${near}/join`)).statusCode).toBe(200);
});

afterAll(async () => {
  await sql`delete from users where email like '%@sl.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('share link tokens', () => {
  it('are 24 bytes from crypto.randomBytes, as 32 characters of base64url, and never repeat', () => {
    const spy = vi.spyOn(crypto, 'randomBytes');
    const t = newShareToken();
    expect(spy).toHaveBeenCalledWith(24);
    spy.mockRestore();
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(Buffer.from(t, 'base64url')).toHaveLength(24);
    expect(new Set(Array.from({ length: 2000 }, newShareToken)).size).toBe(2000);
  });

  it('a share made through the API carries one, and its link is the web app page, not /safe on the site', async () => {
    const r = await u.sl_host('POST', `/activities/${near}/share`, { note: 'Home by 11' });
    expect(r.statusCode).toBe(200);
    const { token, shareUrl } = r.json();
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(shareUrl).toBe(`${config.siteUrl}/app/safe/${token}`);
  });

  it('only a member or the host of an active plan can make one', async () => {
    expect((await u.sl_other('POST', `/activities/${near}/share`, {})).statusCode).toBe(403);
    expect((await u.sl_guest('POST', `/activities/${near}/share`, {})).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: `/activities/${near}/share`, payload: {} })).statusCode).toBe(401);
  });
});

describe('what the page shows', () => {
  it('is public, a snapshot of the plan, and has no email or phone in it', async () => {
    const { token } = (await u.sl_host('POST', `/activities/${near}/share`, { note: 'Home by 11' })).json();
    const r = await view(token);
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.plan).toMatchObject({ title: 'Colaba walk', placeName: 'Colaba Causeway', liveStatus: 'upcoming' });
    expect(body.sharer).toMatchObject({ name: 'sl_host', note: 'Home by 11' });
    expect(body.attendees.map((a: any) => a.name).sort()).toEqual(['sl_guest', 'sl_host']);
    expect(body.expiresAt).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/@sl\.tablamigo|phone|email/i);
  });

  it('a link that is malformed, unknown, or for a plan someone cancelled gives the same 404 or no attendees', async () => {
    for (const t of ['abc', 'x'.repeat(100), 'not a token', 'A'.repeat(32)]) {
      const r = await view(encodeURIComponent(t));
      expect(r.statusCode, t).toBe(404);
      expect(r.json().error).toBe('link_expired_or_invalid');
    }
    const p = (await u.sl_host('POST', '/activities', { category: 'food', placeName: 'Leopold', lat: 18.9218, lng: 72.8347, maxPeople: 4, title: 'Dinner', startsAt: new Date(Date.now() + 2 * DAY).toISOString() })).json().id;
    const { token } = (await u.sl_host('POST', `/activities/${p}/share`, {})).json();
    expect((await u.sl_host('POST', `/activities/${p}/cancel`)).statusCode).toBe(200);
    const body = (await view(token)).json();
    expect(body.plan.liveStatus).toBe('cancelled');
    expect(body.attendees).toEqual([]);
  });
});

describe('expiry', () => {
  it('a link works until 24 hours after the plan starts, at least 6 hours from now, and never more than 14 days', () => {
    const now = new Date('2026-10-04T10:00:00Z');
    const at = (ms: number) => new Date(now.getTime() + ms);
    expect(shareExpiry(at(DAY), now)).toEqual(at(DAY + SHARE_AFTER_START_MS));             // tomorrow's plan
    expect(shareExpiry(at(-5 * 3600_000), now)).toEqual(at(-5 * 3600_000 + SHARE_AFTER_START_MS));   // started 5 h ago: still 19 h
    expect(shareExpiry(at(-3 * DAY), now)).toEqual(at(SHARE_MIN_MS));                      // long over: the 6 hour minimum
    expect(shareExpiry(at(40 * DAY), now)).toEqual(at(SHARE_MAX_MS));                      // far away: capped at 14 days
    expect(SHARE_MAX_MS).toBe(14 * DAY);
  });

  it('the API sets the expiry from the plan, and a link past it is gone', async () => {
    const soon = (await u.sl_host('POST', `/activities/${near}/share`, {})).json();
    const [{ startsAt }] = await sql`select starts_at from activities where id = ${near}`;
    expect(new Date(soon.expiresAt).getTime()).toBe(new Date(startsAt).getTime() + SHARE_AFTER_START_MS);
    const later = (await u.sl_host('POST', `/activities/${far}/share`, {})).json();
    const wait = new Date(later.expiresAt).getTime() - Date.now();
    expect(wait).toBeGreaterThan(SHARE_MAX_MS - 60_000);
    expect(wait).toBeLessThanOrEqual(SHARE_MAX_MS);

    expect((await view(soon.token)).statusCode).toBe(200);
    await sql`update plan_shares set expires_at = now() - interval '1 second' where token = ${soon.token}`;
    const gone = await view(soon.token);
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error).toBe('link_expired_or_invalid');
    // and it is no longer in the owner's list of links that work
    const listed = (await u.sl_host('GET', `/activities/${near}/shares`)).json().shares as any[];
    expect(listed.map(s => s.id)).not.toContain((await sql`select id from plan_shares where token = ${soon.token}`)[0].id);
  });

  it('a banned sharer\'s links stop working', async () => {
    const { token } = (await u.sl_guest('POST', `/activities/${near}/share`, {})).json();
    expect((await view(token)).statusCode).toBe(200);
    await sql`update users set banned_at = now() where email = 'sl_guest@sl.tablamigo'`;
    expect((await view(token)).statusCode).toBe(404);
    await sql`update users set banned_at = null where email = 'sl_guest@sl.tablamigo'`;
  });
});

describe('turning a link off', () => {
  it('only the person who made a link can turn it off, and it is gone for everyone right away', async () => {
    const mine = (await u.sl_host('POST', `/activities/${near}/share`, {})).json();
    const theirs = (await u.sl_guest('POST', `/activities/${near}/share`, {})).json();
    expect((await app.inject({ method: 'DELETE', url: `/safe/${mine.token}` })).statusCode).toBe(401);
    expect((await u.sl_other('DELETE', `/safe/${mine.token}`)).statusCode).toBe(404);
    expect((await u.sl_guest('DELETE', `/safe/${mine.token}`)).statusCode).toBe(404);   // even a member of the same plan
    expect((await view(mine.token)).statusCode).toBe(200);

    const off = await u.sl_host('DELETE', `/safe/${mine.token}`);
    expect(off.statusCode).toBe(200);
    expect(off.json()).toEqual({ ok: true, revoked: true });
    expect((await view(mine.token)).statusCode).toBe(404);
    expect((await u.sl_host('DELETE', `/safe/${mine.token}`)).statusCode).toBe(404);      // already gone
    expect((await view(theirs.token)).statusCode).toBe(200);                            // someone else's link is untouched
  });

  it('every link to a plan can be turned off at once, and the list shows only the caller\'s working links', async () => {
    await u.sl_host('DELETE', `/activities/${near}/shares`);
    const a = (await u.sl_host('POST', `/activities/${near}/share`, { note: 'one' })).json();
    const b = (await u.sl_host('POST', `/activities/${near}/share`, { note: 'two' })).json();
    const guest = (await u.sl_guest('POST', `/activities/${near}/share`, {})).json();
    const list = (await u.sl_host('GET', `/activities/${near}/shares`)).json().shares as any[];
    expect(list.map(s => s.note).sort()).toEqual(['one', 'two']);
    for (const s of list) expect(Object.keys(s).sort()).toEqual(['createdAt', 'expiresAt', 'id', 'note']);   // the list never carries a token

    const off = await u.sl_host('DELETE', `/activities/${near}/shares`);
    expect(off.json()).toEqual({ ok: true, revoked: 2 });
    for (const t of [a.token, b.token]) expect((await view(t)).statusCode).toBe(404);
    expect((await view(guest.token)).statusCode).toBe(200);
    expect(((await u.sl_host('GET', `/activities/${near}/shares`)).json().shares as any[])).toHaveLength(0);
  });
});
