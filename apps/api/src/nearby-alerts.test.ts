// Explore's empty state (12 Nov 2026, lib/nearby-alerts.ts): with no plan within 50 km, GET /activities names the nearest cities
// that have plans and says whether the person asked to hear about new plans near them; "Notify me when someone near me posts"
// is a PATCH /me switch, and a new plan within 50 km reaches the people who switched it on: a push, or the email ladder when
// they have no push token. The test database is shared, so everyone here stands on South Atlantic islands far from other files.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

process.env.REVIEW_EMAILS = 'review@nearby.tablamigo';
const pushes: { to: string[]; title: string; data?: Record<string, string> }[] = [];
vi.mock('./lib/push.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib/push.js')>()),
  notify: (to: string[], p: { title: string; data?: Record<string, string> }) => { if (to.length) pushes.push({ to: [...to], title: p.title, data: p.data }); return Promise.resolve(); },
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { signAccess } = await import('./lib/auth.js');
const { setMailTransport } = await import('./lib/mail.js');
const NA = await import('./lib/nearby-alerts.js');
const L = await import('./lib/ladder.js');

const MAIL = '@nearby.tablamigo';
// Saint Helena (Jamestown) and Ascension, about 1,300 km apart; Gough Island, nothing near it at all.
const JAMESTOWN = { lat: -15.9244, lng: -5.7181 };
const LONGWOOD = { lat: -15.9500, lng: -5.6667 };        // ~6 km from Jamestown
const ASCENSION = { lat: -7.9467, lng: -14.3559 };
const GOUGH = { lat: -40.3167, lng: -9.9333 };
const pt = (p: { lat: number; lng: number }) => sql`ST_SetSRID(ST_MakePoint(${p.lng}, ${p.lat}), 4326)::geography`;

let app: Awaited<ReturnType<typeof build>>;
const mails: { to: string; subject: string; text: string }[] = [];
const id: Record<string, string> = {};

async function person(tag: string, o: { at?: { lat: number; lng: number }; alerts?: boolean; gender?: string; email?: string; snoozed?: boolean } = {}) {
  const [u] = await sql`insert into users (email, name, birthdate, gender, home_country, onboarded, location, location_at, nearby_plan_alerts, snoozed_until)
    values (${o.email ?? tag + MAIL}, ${tag}, '1994-04-04', ${o.gender ?? 'man'}, 'SH', true, ${o.at ? pt(o.at) : null}, ${o.at ? new Date() : null},
      ${o.alerts ?? false}, ${o.snoozed ? sql`'infinity'::timestamptz` : null}) returning id`;
  return (id[tag] = u.id as string);
}
async function plan(key: string, hostTag: string, at: { lat: number; lng: number }, city: string | null, o: { womenOnly?: boolean } = {}) {
  const [a] = await sql`insert into activities (host_id, title, emoji, category, place_name, city, location, starts_at, women_only)
    values (${id[hostTag]}, ${'NA ' + key}, '☕', 'food', ${'Cafe ' + key}, ${city}, ${pt(at)}, now() + interval '2 days', ${o.womenOnly ?? false}) returning id`;
  return (id[key] = a.id as string);
}
const as = (tag: string) => (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${signAccess(id[tag])}` } });
const clean = async () => {
  await sql`delete from notification_log where user_id in (select id from users where email like ${'%' + MAIL})`;
  await sql`delete from activities where host_id in (select id from users where email like ${'%' + MAIL})`;
  await sql`delete from users where email like ${'%' + MAIL}`;
};

beforeAll(async () => {
  app = await build();
  await clean();
  setMailTransport(async m => { mails.push({ to: m.to, subject: m.subject, text: m.text }); return { id: 'test' }; });
  await person('host', { at: JAMESTOWN });
  await person('viewer', { at: GOUGH });
  await person('farHost', { at: ASCENSION });
  await plan('ascension1', 'farHost', ASCENSION, 'Georgetown');
  await plan('ascension2', 'farHost', { lat: ASCENSION.lat + 0.01, lng: ASCENSION.lng }, 'Georgetown');
  await plan('jamestown1', 'host', JAMESTOWN, 'Jamestown');
});
afterAll(async () => { setMailTransport(null); await clean(); await app.close(); });
beforeEach(() => { pushes.length = 0; mails.length = 0; });

describe('nearest cities when nothing is within 50 km', () => {
  it('lists cities with plans, nearest first, with the distance to the nearest plan and the count', async () => {
    const cities = await NA.nearestPlanCities(id.viewer, GOUGH.lat, GOUGH.lng);
    const mine = cities!.filter(c => ['Georgetown', 'Jamestown'].includes(c.city));
    expect(mine.map(c => c.city)).toEqual(['Jamestown', 'Georgetown']);
    expect(mine[1].plans).toBe(2);
    expect(mine[0].distanceKm).toBeGreaterThan(2500);
    expect(mine[0].activityId).toBe(id.jamestown1);
    expect(cities!.length).toBeLessThanOrEqual(NA.NEAREST_CITIES);
  });
  it('is null when a plan is within 50 km', async () => {
    expect(await NA.nearestPlanCities(id.viewer, LONGWOOD.lat, LONGWOOD.lng)).toBeNull();
  });
  it('GET /activities carries nearestCities and the switch only on an empty, unfiltered list', async () => {
    const r = await as('viewer')('GET', `/activities?lat=${GOUGH.lat}&lng=${GOUGH.lng}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().nearestCities.some((c: any) => c.city === 'Jamestown')).toBe(true);
    expect(r.json().nearbyAlerts).toBe(false);
    const filtered = await as('viewer')('GET', `/activities?lat=${GOUGH.lat}&lng=${GOUGH.lng}&category=food`);
    expect(filtered.json().nearestCities).toBeUndefined();
  });
});

describe('Notify me when someone near me posts', () => {
  it('PATCH /me switches it, GET /me and GET /activities read it back', async () => {
    expect((await as('viewer')('PATCH', '/me', { nearbyPlanAlerts: true })).statusCode).toBe(200);
    expect((await as('viewer')('GET', '/me')).json().nearbyPlanAlerts).toBe(true);
    expect((await as('viewer')('GET', `/activities?lat=${GOUGH.lat}&lng=${GOUGH.lng}`)).json().nearbyAlerts).toBe(true);
    await as('viewer')('PATCH', '/me', { nearbyPlanAlerts: false });
    expect((await sql`select nearby_plan_alerts from users where id = ${id.viewer}`)[0].nearbyPlanAlerts).toBe(false);
  });

  it('a new plan reaches people within 50 km who switched it on, once, and nobody else', async () => {
    await person('near', { at: LONGWOOD, alerts: true });
    await sql`insert into push_tokens (user_id, token, platform) values (${id.near}, ${'tok-near-' + id.near}, 'android')`;
    await person('nearOff', { at: LONGWOOD, alerts: false });
    await person('far', { at: ASCENSION, alerts: true });
    await person('snoozed', { at: LONGWOOD, alerts: true, snoozed: true });
    await person('demo', { at: LONGWOOD, alerts: true, email: 'nearby-demo@demo.tablamigo' });
    await person('man', { at: LONGWOOD, alerts: true });
    const p = await plan('fresh', 'host', JAMESTOWN, 'Jamestown');
    expect(await NA.alertNearbyPlan(p)).toBe(2);   // near and man; never switched off, too far, snoozed, a demo address or the host
    const told = (await sql`select user_id from notification_log where kind = 'nearby_plan' and ref = ${p} and channel = 'inapp'`).map(r => r.userId);
    expect(told).toContain(id.near);
    expect(told).toContain(id.man);
    for (const not of [id.nearOff, id.far, id.snoozed, id.demo, id.host]) expect(told).not.toContain(not);
    // Only the person with a token gets a push; it opens the plan and reports the tap to the ladder.
    expect(pushes.map(x => x.to[0])).toEqual([id.near]);
    expect(pushes[0].data).toEqual({ activityId: p, nkind: 'nearby_plan', nref: p });
    expect(pushes[0].title).toContain('New plan near you');
    // Once per plan.
    expect(await NA.alertNearbyPlan(p)).toBe(0);
    await sql`delete from users where id = ${id.demo}`;
  });

  it('women-only plans reach only women; a blocked host reaches nobody; at most 2 a day', async () => {
    await person('woman', { at: LONGWOOD, alerts: true, gender: 'woman' });
    const wo = await plan('womenOnly', 'woman', JAMESTOWN, 'Jamestown', { womenOnly: true });
    await person('woman2', { at: LONGWOOD, alerts: true, gender: 'woman' });
    await NA.alertNearbyPlan(wo);
    const got = (await sql`select user_id from notification_log where kind = 'nearby_plan' and ref = ${wo} and channel = 'inapp'`).map(r => r.userId);
    expect(got).toContain(id.woman2);
    expect(got).not.toContain(id.near);
    expect(got).not.toContain(id.man);

    await sql`insert into blocks (blocker_id, blocked_id) values (${id.man}, ${id.host})`;
    const b = await plan('blocked', 'host', JAMESTOWN, 'Jamestown');
    await NA.alertNearbyPlan(b);
    const gotB = (await sql`select user_id from notification_log where kind = 'nearby_plan' and ref = ${b} and channel = 'inapp'`).map(r => r.userId);
    expect(gotB).not.toContain(id.man);
    // `near` had 'fresh' and now 'blocked': a third plan today is not sent.
    expect(gotB).toContain(id.near);
    const third = await plan('third', 'host', JAMESTOWN, 'Jamestown');
    await NA.alertNearbyPlan(third);
    const gotT = (await sql`select user_id from notification_log where kind = 'nearby_plan' and ref = ${third} and channel = 'inapp'`).map(r => r.userId);
    expect(gotT).not.toContain(id.near);
    expect(gotT).not.toContain(id.woman2);   // women-only and blocked: two already
    expect(gotT).toContain(id.woman);        // her own plan never counted
  });

  it('POST /activities alerts people nearby', async () => {
    await person('poster', { at: JAMESTOWN });
    await person('listener', { at: LONGWOOD, alerts: true });
    const r = await as('poster')('POST', '/activities', { title: 'Coffee by the harbour', emoji: '☕', category: 'food', placeName: 'Harbour cafe',
      lat: JAMESTOWN.lat, lng: JAMESTOWN.lng, startsAt: new Date(Date.now() + 26 * 3600_000).toISOString() });
    expect(r.statusCode).toBe(200);
    await expect.poll(async () => (await sql`select 1 from notification_log where kind = 'nearby_plan' and ref = ${r.json().id} and user_id = ${id.listener} and channel = 'inapp'`).length).toBe(1);
  });

  it('no push token: the ladder emails it, with a link to the plan', async () => {
    const [row] = await sql`select ref from notification_log where kind = 'nearby_plan' and user_id = ${id.listener} and channel = 'push'`;
    expect((await sql`select status from notification_log where kind = 'nearby_plan' and user_id = ${id.listener} and channel = 'push'`)[0].status).toBe('no_token');
    const noon = new Date(); noon.setUTCHours(12, 0, 0, 0); if (noon.getTime() < Date.now()) noon.setUTCDate(noon.getUTCDate() + 1);
    await L.processLadder(noon, { mode: 'on' });
    const m = mails.find(x => x.to === 'listener' + MAIL);
    expect(m?.subject).toContain('New plan near you');
    expect(m?.text).toContain(`/activity/${row.ref}`);
  });

  it('the email is dropped if the person blocked the host after the push', async () => {
    await person('lateBlock', { at: LONGWOOD, alerts: true });
    const p = await plan('lateBlockPlan', 'host', JAMESTOWN, 'Jamestown');
    await NA.alertNearbyPlan(p);
    await sql`insert into blocks (blocker_id, blocked_id) values (${id.lateBlock}, ${id.host})`;
    const noon = new Date(); noon.setUTCHours(12, 0, 0, 0); if (noon.getTime() < Date.now()) noon.setUTCDate(noon.getUTCDate() + 1);
    await L.processLadder(noon, { mode: 'on' });
    expect(mails.find(x => x.to === 'lateBlock' + MAIL)).toBeUndefined();
    expect((await sql`select reason from notification_log where kind = 'nearby_plan' and ref = ${p} and user_id = ${id.lateBlock} and channel = 'inapp'`)[0].reason).toBe('no_longer_valid');
  });

  it('the email and push text', () => {
    const p = { activityId: 'a1', title: 'Sunset walk', emoji: '🌅', placeName: 'Ladder Hill', city: 'Jamestown', distanceKm: 4 };
    expect(NA.nearbyPushText(p)).toEqual({ title: 'New plan near you: 🌅 Sunset walk', body: "Ladder Hill, Jamestown · 4 km away. Tap to see who's going." });
    const e = NA.nearbyPlanEmail(p, { name: 'Ana Lima' }, '00000000-0000-0000-0000-000000000001');
    expect(e.category).toBe('activity');
    expect(JSON.stringify(e.blocks)).toContain('/alerts/off?t=');
  });
});
