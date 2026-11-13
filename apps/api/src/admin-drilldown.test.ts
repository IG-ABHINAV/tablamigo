// Admin Overview drill-downs (every number opens the list it counts), the Trips and plan-detail endpoints, deleted accounts in
// the user drawer and journey, the verification week summary, and email rows linked to their account.
// Fixtures live under @drill.tablamigo / @drillmail.tablamigo and are scoped with q= so other test files' rows never count.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
process.env.REVIEW_EMAILS = ['boss', 'pleb', 'gone'].map(n => `${n}@drill.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'boss@drill.tablamigo';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { lifespan, deletedAdvice } = await import('./routes/admin.js');
const { getHost } = await import('./lib/host.js');

let app: Awaited<ReturnType<typeof build>>;
const D = '@drillmail.tablamigo';
let ip = 0;
async function client(email: string) {
  const remoteAddress = `10.89.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
}
async function user(name: string, extra: Record<string, unknown> = {}) {
  const [u] = await sql`insert into users ${sql({ email: `${name}${D}`, name, birthdate: '1993-04-04', gender: 'woman', homeCountry: 'PT', onboarded: true, lastSeenAt: new Date(Date.now() - 10 * 86400_000), ...extra } as any)} returning id`;
  return u.id as string;
}
const iso = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
const ids = (rows: { id?: string; userId?: string }[]) => rows.map(r => r.id ?? r.userId);
const clean = async () => {
  await sql`delete from email_log where to_email like ${'%' + D} or to_email like '%@drill.tablamigo'`;
  await sql`delete from users where email like ${'%' + D} or email like '%@drill.tablamigo'`;
};

let admin: Awaited<ReturnType<typeof client>>;
const U: Record<string, string> = {};
beforeAll(async () => {
  app = await build();
  await clean();
  admin = await client('boss@drill.tablamigo');
  U.fresh = await user('fresh', { lastSeenAt: new Date() });
  U.old = await user('old', { createdAt: new Date(Date.now() - 40 * 86400_000), lastSeenAt: new Date(Date.now() - 20 * 86400_000), verified: true });
  U.noprofile = await user('noprofile', { onboarded: false });
  U.team = (await getHost())!.id;   // the one Tablamigo Host team account (made by a migration; a second one is refused)
  U.gone = await user('gonedb', { deletedAt: new Date() });
  U.comp = await user('comp', { compUntil: new Date(Date.now() + 5 * 86400_000), plusUntil: new Date(Date.now() + 5 * 86400_000) });
});
afterAll(async () => { await clean(); await app.close(); await sql.end(); });

describe('users list: the filters the Overview links to', () => {
  const list = async (qs: string) => {
    const r = await admin('GET', `/admin/users?q=${encodeURIComponent(D)}&limit=200&${qs}`);
    expect(r.statusCode).toBe(200);
    return ids(r.json().users);
  };
  it('people: not the team account, not deleted', async () => {
    const got = await list('filter=people');
    expect(got).toEqual(expect.arrayContaining([U.fresh, U.old, U.noprofile, U.comp]));
    expect(got).not.toContain(U.gone);
    const byId = async (f: string) => (await admin('GET', `/admin/users?filter=${f}&q=${U.team}`)).json().users.length;
    expect(await byId('all')).toBe(1);
    expect(await byId('people')).toBe(0);
  });
  it('onboarded and verified', async () => {
    expect(await list('filter=onboarded')).not.toContain(U.noprofile);
    expect(await list('filter=verified')).toEqual([U.old]);
  });
  it('signups in 7 and 30 days include accounts deleted since, like the Overview counts', async () => {
    const d7 = await list('filter=signup_7d');
    expect(d7).toContain(U.gone);
    expect(d7).toContain(U.fresh);
    expect(d7).not.toContain(U.old);
    expect(await list('filter=signup_30d')).not.toContain(U.old);
  });
  it('active today / 30 days follow last_seen_at', async () => {
    expect(await list('filter=active_1d')).toEqual([U.fresh]);
    const mau = await list('filter=active_30d');
    expect(mau).toEqual(expect.arrayContaining([U.fresh, U.old]));
  });
  it('Plus by source and a chart day', async () => {
    expect(await list('filter=plus&plus=comp')).toEqual([U.comp]);
    expect(await list('filter=plus&plus=google')).toEqual([]);
    const day = new Date(Date.now() - 40 * 86400_000 + 5.5 * 3600_000).toISOString().slice(0, 10);   // India date
    expect(await list(`day=${day}`)).toContain(U.old);
  });
  it('acquisition source is filtered by the API, so total and pages are the filtered ones', async () => {
    const play = await user('srcplay', { attribution: sql.json({ source: 'Google Play', medium: 'app' }) });
    const meta = await user('srcmeta', { attribution: sql.json({ source: 'Meta / Instagram', medium: 'social' }) });
    const invite = await user('srcinvite', { attribution: sql.json({ source: 'invite', medium: 'app' }) });
    const blank = await user('srcblank', { attribution: sql.json({ source: '' }) });   // no source: shown as Direct, filters as Direct
    const page = async (qs: string) => (await admin('GET', `/admin/users?q=${encodeURIComponent(D)}&${qs}`)).json();
    expect(ids((await page('limit=200&source=Google%20Play')).users)).toEqual([play]);
    expect(ids((await page('limit=200&source=Meta%20%2F%20Instagram')).users)).toEqual([meta]);
    expect(ids((await page('limit=200&source=other')).users)).toEqual([invite]);
    const direct = ids((await page('limit=200&source=Direct')).users);
    expect(direct).toEqual(expect.arrayContaining([U.fresh, U.old, blank]));   // fixtures without attribution are Direct
    expect(direct).not.toContain(play);
    // One per page: the total is the filtered count and page 2 holds the rest (a browser-side filter showed "1–0 of N").
    const p1 = await page('limit=1&offset=0&source=Direct');
    expect(p1.total).toBe(direct.length);
    expect(p1.users).toHaveLength(1);
    expect((await page(`limit=1&offset=${direct.length - 1}&source=Direct`)).users).toHaveLength(1);
    // Combines with the other filters.
    expect(ids((await page('limit=200&filter=active_1d&source=Direct')).users)).toEqual([U.fresh]);
    expect((await admin('GET', '/admin/users?source=Founder')).statusCode).toBe(400);
  });
  it('refuses an unknown filter or a malformed day', async () => {
    expect((await admin('GET', '/admin/users?filter=everything')).statusCode).toBe(400);
    expect((await admin('GET', '/admin/users?day=2026-1-1')).statusCode).toBe(400);
  });
});

describe('plans: posted in 7 days by people, and the plan drawer', () => {
  let recent: string, old: string, team: string;
  beforeAll(async () => {
    const mk = async (host: string, title: string, created: Date, days: number) => (await sql`insert into activities (host_id, title, category, place_name, location, city, starts_at, created_at)
      values (${host}, ${title}, 'food', 'Drill Cafe', 'SRID=4326;POINT(100.53 13.74)', 'Drilltown', ${new Date(Date.now() + days * 86400_000)}, ${created}) returning id`)[0].id as string;
    recent = await mk(U.fresh, 'Drill recent dinner', new Date(), 3);
    old = await mk(U.old, 'Drill old dinner', new Date(Date.now() - 9 * 86400_000), -5);
    team = await mk(U.team, 'Drill team dinner', new Date(), 4);
    await sql`insert into activity_members (activity_id, user_id) values (${recent}, ${U.fresh}), (${recent}, ${U.comp})`;
    await sql`insert into reports (reporter_id, target_type, target_id, reason) values (${U.comp}, 'activity', ${recent}, 'spam')`;
  });
  it('created=7d&host=people lists people-hosted plans posted this week, any status or date', async () => {
    const r = await admin('GET', '/admin/plans?q=Drill&created=7d&host=people&status=all&when=all');
    const got = ids(r.json().plans);
    expect(got).toContain(recent);
    expect(got).not.toContain(old);
    expect(got).not.toContain(team);
  });
  it('host=people leaves the team account out of upcoming plans', async () => {
    const got = ids((await admin('GET', '/admin/plans?q=Drill&host=people')).json().plans);
    expect(got).toEqual([recent]);
  });
  it('GET /admin/plans/:id returns the host, the people in it and the reports on it', async () => {
    const r = await admin('GET', `/admin/plans/${recent}`);
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.plan.hostId).toBe(U.fresh);
    expect(ids(b.members).sort()).toEqual([U.fresh, U.comp].sort());
    expect(b.reports).toHaveLength(1);
    expect(b.reports[0].reporterId).toBe(U.comp);
    expect((await admin('GET', '/admin/plans/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });
  it('is admin only', async () => {
    const pleb = await client('pleb@drill.tablamigo');
    expect((await pleb('GET', `/admin/plans/${recent}`)).statusCode).toBe(403);
    expect((await pleb('GET', '/admin/trips')).statusCode).toBe(403);
  });
});

describe('trips', () => {
  beforeAll(async () => {
    const t = (u: string, a: number, b: number) => sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${u}, 'Drillville', 'ID', 'drillville-id', ${iso(a)}, ${iso(b)})`;
    await t(U.fresh, 10, 15); await t(U.comp, 12, 20); await t(U.old, -30, -25);
  });
  it('upcoming lists current and future trips with how many travellers overlap', async () => {
    const r = await admin('GET', '/admin/trips?q=Drillville');
    expect(r.statusCode).toBe(200);
    const trips = r.json().trips;
    expect(trips.map((t: any) => t.userId)).toEqual([U.fresh, U.comp]);
    expect(trips.map((t: any) => t.overlaps)).toEqual([1, 1]);
  });
  it('past and all', async () => {
    expect((await admin('GET', '/admin/trips?q=Drillville&when=past')).json().trips.map((t: any) => t.userId)).toEqual([U.old]);
    expect((await admin('GET', '/admin/trips?q=Drillville&when=all')).json().trips).toHaveLength(3);
  });
});

describe('a deleted account in the admin', () => {
  let gone: string;
  beforeAll(async () => {
    const me = await client('gone@drill.tablamigo');
    const [u] = await sql`select id from users where email = 'gone@drill.tablamigo'`;
    gone = u.id;
    await sql`update users set onboarded = true, created_at = now() - interval '12 minutes' where id = ${gone}`;
    expect((await me('DELETE', '/me')).statusCode).toBe(200);
  });
  it('cannot be impersonated', async () => {
    const r = await admin('POST', `/admin/users/${gone}/impersonate`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('deleted_account');
  });
  it('the journey says Deleted, how long the account lived, and what to check', async () => {
    const j = (await admin('GET', `/admin/users/${gone}/journey`)).json();
    expect(j.summary.dropoffStage).toBe('Deleted');
    expect(j.summary.recommendation).toMatch(/^Deleted after 12 min, right after finishing onboarding: check the onboarding drop-off/);
    expect(j.user.deletedAt).toBeTruthy();
    expect(j.timeline.filter((t: any) => t.type === 'deleted')).toHaveLength(1);
  });
  it('the user record carries deletedAt for the drawer', async () => {
    expect((await admin('GET', `/admin/users/${gone}`)).json().user.deletedAt).toBeTruthy();
  });
});

describe('verifications week summary and the email log', () => {
  it('counts submitted selfies and the verify nudges sent the same week', async () => {
    await sql`insert into email_log (kind, user_id, to_email, subject, status, sent_at, period_key) values ('activation_verify_1', ${U.fresh}, ${'fresh' + D}, 'One selfie', 'sent', now(), ${'drill-' + Date.now()})`;
    await sql`insert into verification_requests (user_id, photo_key, pose, status) values (${U.fresh}, 'avatar/x/selfie.jpg', 'turn_head', 'pending')`;
    const c = (await admin('GET', '/admin/verifications')).json().last7Days;
    expect(c.nudges).toBeGreaterThanOrEqual(1);
    expect(c.submitted).toBe(c.approved + c.rejected + c.pending);
    expect(c.pending).toBeGreaterThanOrEqual(1);
  });
  it('days=7 drops older mail, and a sign-in code sent before the account existed links to that account', async () => {
    await sql`insert into email_log (kind, user_id, to_email, subject, status, sent_at, created_at, period_key) values
      ('login_code', null, ${'old' + D}, 'Your code', 'sent', now(), now(), ${'drill-a-' + Date.now()}),
      ('welcome', ${U.old}, ${'old' + D}, 'Ancient welcome', 'sent', now() - interval '20 days', now() - interval '20 days', ${'drill-b-' + Date.now()})`;
    const r = (await admin('GET', `/admin/emails?q=${encodeURIComponent('old' + D)}&status=sent&days=7`)).json();
    expect(r.emails.map((e: any) => e.subject)).toEqual(['Your code']);
    expect(r.emails[0].userId).toBe(U.old);
    expect((await admin('GET', '/admin/emails?days=0')).statusCode).toBe(400);
  });
});

describe('lifespan and deletedAdvice', () => {
  const t0 = new Date('2026-11-01T01:10:00+05:30');
  const after = (min: number) => new Date(t0.getTime() + min * 60_000);
  it('formats minutes, hours and days', () => {
    expect(lifespan(t0, after(12))).toBe('12 min');
    expect(lifespan(t0, after(89))).toBe('89 min');
    expect(lifespan(t0, after(5 * 60))).toBe('5 h');
    expect(lifespan(t0, after(3 * 1440))).toBe('3 days');
    expect(lifespan(after(5), t0)).toBe('0 min');
  });
  it('points at onboarding for same-day deletions and at matching for early churn', () => {
    expect(deletedAdvice(t0, after(12), true)).toMatch(/^Deleted after 12 min, right after finishing onboarding: check the onboarding drop-off/);
    expect(deletedAdvice(t0, after(12), false)).toMatch(/before finishing onboarding/);
    expect(deletedAdvice(t0, after(3 * 1440), true)).toMatch(/early churn/);
    expect(deletedAdvice(t0, after(40 * 1440), true)).toMatch(/Nothing to do/);
  });
});
