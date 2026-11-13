// Admin panel API and customer emails. The mail transport is replaced by a recorder: nothing is sent.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
process.env.REVIEW_EMAILS = ['boss', 'ops', 'nia', 'omar', 'pat', 'quin', 'rae', 'welcome', 'wally'].map(n => `${n}@admin.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'boss@admin.tablamigo';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const { recomputePlus } = await import('./lib/play.js');
const { runEmailJobs, planJoins, weeklyDigest } = await import('./lib/emails/jobs.js');
const { unsubscribeToken, readUnsubscribeToken } = await import('./lib/emails/send.js');

let app: Awaited<ReturnType<typeof build>>;
const DOMAIN = '@admin.tablamigo', MAIL = '@mail.tablamigo';
const BKK = { lat: 13.7466, lng: 100.5346 };
const MONDAY = new Date('2026-10-05T05:00:00Z');   // Monday 10:30 in India: digest time
const iso = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

type Sent = { to: string; subject: string; html: string; text: string; headers?: Record<string, string> };
let sent: Sent[] = [];
let failNext = 0;
const mine = () => sent.filter(m => m.to.endsWith(MAIL) || m.to.endsWith(DOMAIN));
const to = (addr: string) => sent.filter(m => m.to === addr);

let ip = 0;
async function login(email: string) {
  const remoteAddress = `10.88.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  return r;
}
async function client(email: string) {
  const r = await login(email);
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
  const [u] = await sql`select id from users where email = ${email}`;
  return Object.assign(call, { id: u.id as string, refresh: r.json().refreshToken as string });
}
/** A complete profile made straight in the database, so no request bumps last_seen_at behind the test's back. */
async function user(name: string, extra: Record<string, unknown> = {}) {
  const [u] = await sql`insert into users ${sql({ email: `${name.toLowerCase()}${MAIL}`, name, birthdate: '1993-04-04', gender: 'woman', homeCountry: 'PT', onboarded: true, ...extra } as any)} returning id`;
  return u.id as string;
}
const clean = async () => {
  await sql`delete from email_log where to_email like ${'%' + MAIL} or to_email like ${'%' + DOMAIN}`;
  await sql`delete from users where email like ${'%' + MAIL} or email like ${'%' + DOMAIN}`;
};

beforeAll(async () => {
  app = await build();
  await clean();
  setMailTransport(async m => {
    // The job runs over every account in the (shared) database, so only a send to one of this file's own addresses may use up the failure.
    if (failNext > 0 && (m.to.endsWith(MAIL) || m.to.endsWith(DOMAIN))) { failNext--; throw new Error('smtp down'); }
    sent.push(m); return { id: `test-${sent.length}` };
  });
});
beforeEach(() => { sent = []; failNext = 0; });
afterAll(async () => { setMailTransport(null); await clean(); await app.close(); await sql.end(); });

describe('admin guard', () => {
  it('401 without a token, 403 for a normal user, 200 for role=admin and for ADMIN_EMAILS', async () => {
    expect((await app.inject({ method: 'GET', url: '/admin/overview' })).statusCode).toBe(401);
    const nia = await client('nia@admin.tablamigo');
    for (const url of ['/admin/overview', '/admin/users', '/admin/plans', '/admin/reports', '/admin/subscriptions', '/admin/emails', '/admin/verifications'])
      expect((await nia('GET', url)).statusCode, url).toBe(403);
    expect((await nia('POST', `/admin/users/${nia.id}/comp`, { days: 30 })).statusCode).toBe(403);

    const boss = await client('boss@admin.tablamigo');      // in ADMIN_EMAILS, role is still 'user'
    expect((await sql`select role from users where id = ${boss.id}`)[0].role).toBe('user');
    const ov = await boss('GET', '/admin/overview');
    expect(ov.statusCode).toBe(200);
    expect(ov.json().users.total).toBeGreaterThan(0);
    expect(ov.json().daily).toHaveLength(30);
    expect(ov.json().revenue.google.amountsStored).toBe(false);
    expect((await boss('GET', '/admin/verifications')).statusCode).toBe(200);   // existing admin routes use the same guard

    const ops = await client('ops@admin.tablamigo');
    expect((await ops('GET', '/admin/users')).statusCode).toBe(403);
    await sql`update users set role = 'admin' where id = ${ops.id}`;
    for (const url of ['/admin/me', '/admin/users?q=nia', '/admin/plans?when=all&status=all', '/admin/reports?status=all', '/admin/subscriptions', '/admin/emails', '/admin/revenue'])
      expect((await ops('GET', url)).statusCode, url).toBe(200);
    const found = (await ops('GET', '/admin/users?q=nia@admin')).json();
    expect(found.users.map((u: any) => u.email)).toEqual(['nia@admin.tablamigo']);
  });
});

describe('comp Plus', () => {
  it('grant sets comp_until and recomputePlus makes the user Plus; revoke falls back to a pass', async () => {
    const boss = await client('boss@admin.tablamigo');
    const omar = await client('omar@admin.tablamigo');
    expect((await omar('GET', '/me')).json().plus).toBe(false);

    const g = (await boss('POST', `/admin/users/${omar.id}/comp`, { days: 30 })).json();
    expect(new Date(g.plusUntil).getTime()).toBe(new Date(g.compUntil).getTime());
    expect(new Date(g.plusUntil).getTime() - Date.now()).toBeGreaterThan(29.9 * 86400_000);
    expect((await omar('GET', '/me')).json().plus).toBe(true);
    const row = (await boss('GET', `/admin/users?q=omar@admin`)).json().users[0];
    expect(row.plusSource).toBe('comp');

    // A Trip Pass ending sooner than the comp: revoking the comp leaves the pass in charge.
    const passEnd = new Date(Date.now() + 5 * 86400_000);
    await sql`insert into passes (purchase_token, user_id, product_id, expires_at) values (${'test-comp-pass-' + omar.id}, ${omar.id}, 'tablamigo_trip_pass', ${passEnd})`;
    await recomputePlus(omar.id);
    const r = (await boss('DELETE', `/admin/users/${omar.id}/comp`)).json();
    expect(r.compUntil).toBeNull();
    expect(Math.abs(new Date(r.plusUntil).getTime() - passEnd.getTime())).toBeLessThan(1000);
    expect((await boss('GET', `/admin/users?q=omar@admin`)).json().users[0].plusSource).toBe('pass');

    await sql`delete from passes where user_id = ${omar.id}`;
    await recomputePlus(omar.id);
    expect((await omar('GET', '/me')).json().plus).toBe(false);
    expect((await boss('POST', `/admin/users/${omar.id}/comp`, { days: 0 })).statusCode).toBe(400);
  });
});

describe('wallet passes', () => {
  it('a pass redeemed from the Trip Pass wallet is labelled wallet, never shown as a purchase', async () => {
    const boss = await client('boss@admin.tablamigo');
    const wally = await client('wally@admin.tablamigo');
    await sql`update users set trip_passes_available = 1 where id = ${wally.id}`;
    expect((await wally('POST', '/me/trip-pass/redeem', {})).statusCode).toBe(200);
    expect((await wally('GET', '/me')).json().plus).toBe(true);

    expect((await boss('GET', '/admin/users?q=wally@admin')).json().users[0].plusSource).toBe('wallet');
    const mine = (await boss('GET', '/admin/subscriptions')).json().passes.filter((p: any) => p.userId === wally.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ platform: 'wallet', purchase: false });
    expect(mine[0].ref).toMatch(/^wallet:/);
    // Not counted as Play passes or revenue either.
    const rv = (await boss('GET', '/admin/revenue')).json();
    const [{ n }] = await sql`select count(*)::int as n from passes where purchase_token not like 'rzp:%' and purchase_token not like 'wallet:%' and voided_at is null`;
    expect(rv.google.passes).toBe(n);

    // A bought pass is still a purchase.
    await sql`insert into passes (purchase_token, user_id, product_id, expires_at) values (${'test-wallet-bought-' + wally.id}, ${wally.id}, 'tablamigo_trip_pass', now() + interval '60 days')`;
    await recomputePlus(wally.id);
    expect((await boss('GET', '/admin/users?q=wally@admin')).json().users[0].plusSource).toBe('pass');
    const both = (await boss('GET', '/admin/subscriptions')).json().passes.filter((p: any) => p.userId === wally.id);
    expect(both.map((p: any) => [p.platform, p.purchase]).sort()).toEqual([['google', true], ['wallet', false]]);
    await sql`delete from passes where user_id = ${wally.id}`;
  });
});

describe('ban', () => {
  it('banned users are refused everywhere and vanish from feeds; unban restores access', async () => {
    const boss = await client('boss@admin.tablamigo');
    const pat = await client('pat@admin.tablamigo'), quin = await client('quin@admin.tablamigo');
    for (const [u, name] of [[pat, 'Pat'], [quin, 'Quin']] as const) {
      await u('PATCH', '/me', { name, birthdate: '1991-01-01', gender: 'man', homeCountry: 'nz' });
      await u('POST', '/me/location', BKK);
    }
    const plan = (await pat('POST', '/activities', { title: 'Ban test dinner', category: 'food', placeName: 'Soi 38', lat: BKK.lat, lng: BKK.lng, startsAt: new Date(Date.now() + 5 * 3600_000).toISOString() })).json();
    expect((await quin('GET', `/travelers?lat=${BKK.lat}&lng=${BKK.lng}`)).json().travelers.map((t: any) => t.id)).toContain(pat.id);

    expect((await boss('POST', `/admin/users/${boss.id}/ban`)).json().error).toBe('cannot_ban_self');
    expect((await boss('POST', `/admin/users/${pat.id}/ban`)).statusCode).toBe(200);

    expect((await pat('GET', '/me')).json().error).toBe('banned');
    expect((await login('pat@admin.tablamigo')).json().error).toBe('banned');
    expect((await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: pat.refresh } })).statusCode).toBe(401);
    expect((await quin('GET', `/travelers?lat=${BKK.lat}&lng=${BKK.lng}`)).json().travelers.map((t: any) => t.id)).not.toContain(pat.id);
    expect((await quin('GET', `/activities?lat=${BKK.lat}&lng=${BKK.lng}`)).json().activities.map((a: any) => a.id)).not.toContain(plan.id);
    expect((await sql`select status from activities where id = ${plan.id}`)[0].status).toBe('cancelled');
    expect((await boss('GET', '/admin/users?filter=banned&q=pat@admin')).json().total).toBe(1);

    await sql`update users set role = 'admin' where id = ${quin.id}`;
    expect((await boss('POST', `/admin/users/${quin.id}/ban`)).statusCode).toBe(403);

    expect((await boss('POST', `/admin/users/${pat.id}/unban`)).statusCode).toBe(200);
    const again = await client('pat@admin.tablamigo');
    expect((await again('GET', '/me')).statusCode).toBe(200);
  });

  it('reports queue: resolve and dismiss', async () => {
    const boss = await client('boss@admin.tablamigo');
    const rae = await client('rae@admin.tablamigo');
    const nia = await client('nia@admin.tablamigo');
    await rae('POST', '/reports', { targetType: 'user', targetId: nia.id, reason: 'spam', details: 'test report' });
    await rae('POST', '/reports', { targetType: 'user', targetId: 'not-a-uuid', reason: 'other' });   // junk ids must not break the queue
    const open = (await boss('GET', '/admin/reports')).json().reports.filter((r: any) => r.reporterId === rae.id);
    expect(open).toHaveLength(2);
    const real = open.find((r: any) => r.targetId === nia.id);
    expect(real.targetUserName).toBeNull();                   // Nia never set a name
    expect(real.targetUserEmail).toBe('nia@admin.tablamigo');
    expect((await boss('GET', '/admin/users?filter=reported&q=nia@admin')).json().users[0].openReports).toBe(1);
    expect((await boss('POST', `/admin/reports/${real.id}/resolve`)).json().status).toBe('actioned');
    expect((await boss('POST', `/admin/reports/${open.find((r: any) => r !== real).id}/dismiss`)).json().status).toBe('dismissed');
    expect((await boss('GET', '/admin/reports')).json().reports.filter((r: any) => r.reporterId === rae.id)).toHaveLength(0);
  });
});

describe('unsubscribe', () => {
  it('signed token: round-trips, rejects tampering, GET records the opt-out, one-click POST works, digest respects it', async () => {
    const id = await user('Uma');
    const t = unsubscribeToken(id, 'digest');
    expect(readUnsubscribeToken(t)).toEqual({ userId: id, key: 'digest' });
    expect(readUnsubscribeToken(t.slice(0, -2) + 'xx')).toBeNull();
    expect(readUnsubscribeToken(t.replace('.digest.', '.all.'))).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(t + 'x')}` })).statusCode).toBe(400);

    // Uma has a trip and someone else is going: she would get the digest...
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${id}, 'Unsubtown', 'PT', 'unsubtown-pt', ${iso(10)}, ${iso(14)})`;
    const other = await user('Vic');
    await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${other}, 'Unsubtown', 'PT', 'unsubtown-pt', ${iso(12)}, ${iso(20)})`;

    // ...until she clicks the link.
    const r = await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(t)}` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain(`You're unsubscribed`);
    expect((await sql`select email_prefs from users where id = ${id}`)[0].emailPrefs).toEqual({ digest: false });
    await weeklyDigest({}, MONDAY);
    expect(to('uma@mail.tablamigo')).toHaveLength(0);
    expect(to('vic@mail.tablamigo')).toHaveLength(1);         // Vic still gets his, with a working link
    const vic = to('vic@mail.tablamigo')[0];
    expect(vic.subject).toBe('1 traveler in Unsubtown on your dates');
    expect(vic.headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const link = vic.html.match(/href="(https?:\/\/[^"]*\/email\/unsubscribe\?t=[^"]+)"/)![1].replace(/&amp;/g, '&');
    expect(vic.text).toContain(link);

    // RFC 8058 one-click POST from a mail client.
    const vt = new URL(link).searchParams.get('t')!;
    const p = await app.inject({ method: 'POST', url: `/email/unsubscribe?t=${encodeURIComponent(vt)}`, payload: 'List-Unsubscribe=One-Click', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(p.json()).toEqual({ ok: true });
    expect((await sql`select email_prefs from users where id = ${other}`)[0].emailPrefs.digest).toBe(false);

    // Undo, then 'all' also stops it.
    await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(t)}&undo=1` });
    expect((await sql`select email_prefs from users where id = ${id}`)[0].emailPrefs.digest).toBe(true);
    await app.inject({ method: 'GET', url: `/email/unsubscribe?t=${encodeURIComponent(unsubscribeToken(id, 'all'))}` });
    await weeklyDigest({}, new Date(MONDAY.getTime() + 7 * 86400_000));
    expect(to('uma@mail.tablamigo')).toHaveLength(0);
  });

  it('digest skips demo personas (their @demo.tablamigo inbox bounces)', async () => {
    const demoEmail = `digestdemo${Date.now()}@demo.tablamigo`;
    const demo = await user('DemoDigest', { email: demoEmail });
    const real = await user('Rhea');
    try {
      for (const id of [demo, real]) await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${id}, 'Demoville', 'PT', 'demoville-pt', ${iso(10)}, ${iso(14)})`;
      await weeklyDigest({}, new Date(MONDAY.getTime() + 14 * 86400_000));
      expect(to(demoEmail)).toHaveLength(0);
      expect(to('rhea@mail.tablamigo')).toHaveLength(1);       // the demo persona still counts as a traveler for real users
    } finally {
      await sql`delete from users where id = ${demo}`;
    }
  });
});

describe('email scheduler', () => {
  it('is idempotent: two runs send each email once, and a failed send is retried once', async () => {
    const DAY = 86400_000;
    const ending = await user('Ema', { compUntil: new Date(Date.now() + 2 * DAY) });      // comp ends in 2 days
    const ended = await user('Fin', { compUntil: new Date(Date.now() - DAY) });           // comp ended yesterday
    const passer = await user('Gia');
    await sql`insert into passes (purchase_token, user_id, product_id, expires_at, raw) values (${'rzp:pay_test_' + passer}, ${passer}, 'tablamigo_trip_pass', now() + interval '30 hours', ${sql.json({ amount: 29900, currency: 'INR' })})`;
    const payer = await user('Hal');
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, raw)
      values (${'rzp:sub_test_' + payer}, ${payer}, 'razorpay', 'tablamigo_plus', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', now() + interval '1 day', ${sql.json({ notes: { product: 'tablamigo_plus_monthly' } })})`;
    const renewing = await user('Ivy');
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, raw)
      values (${'rzp:sub_test_' + renewing}, ${renewing}, 'razorpay', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', now() + interval '2 days', ${sql.json({ id: 'sub_test', notes: { product: 'tablamigo_plus_monthly' }, paid_count: 1 })})`;
    for (const id of [ending, ended, passer, payer, renewing]) await recomputePlus(id);

    failNext = 1;                                           // the first send of the run fails
    await runEmailJobs();
    await runEmailJobs();
    await runEmailJobs();

    const kinds = async (id: string) => (await sql`select kind, status, attempts from email_log where user_id = ${id} order by kind`).map(r => `${r.kind}:${r.status}`);
    expect(await kinds(ending)).toEqual(['plus_ending:sent']);
    expect(await kinds(ended)).toEqual(['plus_ended:sent']);
    expect(await kinds(passer)).toEqual(['pass_expiring:sent', 'plus_started:sent']);
    expect(await kinds(payer)).toEqual(['plus_payment_failed:sent']);
    expect(await kinds(renewing)).toEqual(['plus_started:sent']);      // renews, so no "ending soon"

    const bySubject = (addr: string) => to(addr).map(m => m.subject).sort();
    expect(bySubject('ema@mail.tablamigo')).toEqual(['Your Plus ends in 2 days']);
    expect(bySubject('fin@mail.tablamigo')).toEqual(['Your Tablamigo Plus has ended']);
    expect(bySubject('gia@mail.tablamigo')).toEqual(['Your Trip Pass ends in 2 days', 'Your Trip Pass receipt']);
    expect(bySubject('hal@mail.tablamigo')).toEqual([`Your Plus payment didn't go through`]);
    expect(bySubject('ivy@mail.tablamigo')).toEqual(['Your Tablamigo Plus receipt']);
    expect(to('gia@mail.tablamigo').find(m => m.subject === 'Your Trip Pass receipt')!.text).toContain('₹299');
    expect(to('ivy@mail.tablamigo')[0].text).toContain('₹499');
    // Every email carries a text part and the footer; transactional ones have no unsubscribe link.
    for (const m of mine()) {
      expect(m.text).toContain('Tablamigo by Hookstep · Ghatkopar, Mumbai, India');
      expect(m.html).toContain('https://tablamigo.hookstep.in/icon-192.png');
    }
    expect(to('ivy@mail.tablamigo')[0].headers).toBeUndefined();
    expect(to('ema@mail.tablamigo')[0].headers?.['List-Unsubscribe']).toContain('/email/unsubscribe?t=');

    const retried = await sql`select count(*)::int as n from email_log where attempts = 2 and status = 'sent' and user_id = any(${[ending, ended, passer, payer, renewing]}::uuid[])`;
    expect(retried[0].n).toBe(1);

    // The weekly digest: twice in the same week is still one email.
    const tripper = await user('Jan');
    const friend = await user('Kit', { photoUrl: 'https://example.test/kit.jpg' });
    for (const id of [tripper, friend]) await sql`insert into trips (user_id, city, country_code, city_key, start_date, end_date) values (${id}, 'Idemcity', 'PT', 'idemcity-pt', ${iso(3)}, ${iso(9)})`;
    await runEmailJobs(MONDAY);
    await runEmailJobs(MONDAY);
    expect(to('jan@mail.tablamigo').map(m => m.subject)).toEqual(['1 traveler in Idemcity on your dates']);
    expect(to('jan@mail.tablamigo')[0].html).toContain('https://example.test/kit.jpg');
    expect(to('jan@mail.tablamigo')[0].text).toContain('Kit (33 · Portugal)');
    // Not Monday: no digest at all.
    await sql`delete from email_log where kind = 'weekly_digest' and user_id = ${tripper}`;
    await runEmailJobs(new Date('2026-10-07T05:00:00Z'));
    expect(to('jan@mail.tablamigo')).toHaveLength(1);
  });
});

describe('join emails', () => {
  it('batch: one email per plan per 6 hours, only for joins after the host last opened the app', async () => {
    const H = 3600_000, ago = (h: number) => new Date(Date.now() - h * H);
    const host = await user('Lea', { lastSeenAt: ago(10) });
    const [plan] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at)
      values (${host}, 'Batch test tapas', 'food', 'Bairro Alto', ST_SetSRID(ST_MakePoint(-9.14, 38.71), 4326)::geography, now() + interval '1 day') returning id`;
    await sql`insert into activity_members (activity_id, user_id, joined_at) values (${plan.id}, ${host}, ${ago(11)})`;
    const join = async (name: string, at: Date) => { const id = await user(name); await sql`insert into activity_members (activity_id, user_id, joined_at) values (${plan.id}, ${id}, ${at})`; return id; };
    await join('Max', ago(9));
    await join('Noa', ago(8));

    await planJoins();
    expect(to('lea@mail.tablamigo').map(m => m.subject)).toEqual(['2 people joined Batch test tapas']);
    expect(to('lea@mail.tablamigo')[0].text).toContain('- Max (Portugal)');
    await planJoins();
    expect(to('lea@mail.tablamigo')).toHaveLength(1);

    // A third join within 6 hours of that email waits.
    await join('Oli', ago(0.5));
    await planJoins();
    expect(to('lea@mail.tablamigo')).toHaveLength(1);

    // Once the last email is 7 hours old, the next batch holds only the new joiner.
    await sql`update email_log set created_at = now() - interval '7 hours' where kind = 'plan_joined' and ref = ${plan.id}`;
    await planJoins();
    expect(to('lea@mail.tablamigo').map(m => m.subject)).toEqual(['2 people joined Batch test tapas', 'Oli joined Batch test tapas']);
    expect(to('lea@mail.tablamigo')[1].text).not.toContain('Max');
    await planJoins();
    expect(to('lea@mail.tablamigo')).toHaveLength(2);

    // A host who opened the app after the join gets nothing; a join in the last 15 minutes waits for them.
    const host2 = await user('Mia', { lastSeenAt: new Date() });
    const [p2] = await sql`insert into activities (host_id, title, category, place_name, location, starts_at)
      values (${host2}, 'Seen it already', 'drinks', 'Cais', ST_SetSRID(ST_MakePoint(-9.14, 38.71), 4326)::geography, now() + interval '1 day') returning id`;
    const early = await user('Ned');
    await sql`insert into activity_members (activity_id, user_id, joined_at) values (${p2.id}, ${early}, ${ago(1)})`;
    await planJoins();
    expect(to('mia@mail.tablamigo')).toHaveLength(0);
    await sql`update users set last_seen_at = ${ago(2)} where id = ${host2}`;
    await sql`update activity_members set joined_at = now() - interval '5 minutes' where activity_id = ${p2.id}`;
    await planJoins();
    expect(to('mia@mail.tablamigo')).toHaveLength(0);
    await sql`update activity_members set joined_at = now() - interval '20 minutes' where activity_id = ${p2.id}`;
    await planJoins();
    expect(to('mia@mail.tablamigo').map(m => m.subject)).toEqual(['Ned joined Seen it already']);

    // Opted out of activity emails: nothing.
    await sql`update users set email_prefs = '{"activity": false}' where id = ${host}`;
    await sql`update email_log set created_at = now() - interval '7 hours' where kind = 'plan_joined' and ref = ${plan.id}`;
    await join('Pia', ago(0.5));
    await planJoins();
    expect(to('lea@mail.tablamigo')).toHaveLength(2);
  });
});

describe('event emails', () => {
  it('welcome once when the profile is first complete; deletion confirmation to the old address', async () => {
    const w = await client('welcome@admin.tablamigo');
    await w('PATCH', '/me', { name: 'Wren Ito' });                           // incomplete: no email
    await w('PATCH', '/me', { birthdate: '1995-06-06', gender: 'woman', homeCountry: 'jp' });
    await vi.waitFor(() => expect(to('welcome@admin.tablamigo')).toHaveLength(1));
    expect(to('welcome@admin.tablamigo')[0].subject).toBe('Welcome to Tablamigo, Wren');
    await w('PATCH', '/me', { bio: 'Hi' });
    await w('PATCH', '/me', { name: 'Wren' });
    await new Promise(r => setTimeout(r, 100));
    expect(to('welcome@admin.tablamigo')).toHaveLength(1);

    expect((await w('DELETE', '/me')).statusCode).toBe(200);
    await vi.waitFor(() => expect(to('welcome@admin.tablamigo')).toHaveLength(2));
    const bye = to('welcome@admin.tablamigo')[1];
    expect(bye.subject).toBe('Your Tablamigo account is deleted');
    expect(bye.text).not.toContain('still active');
  });
});
