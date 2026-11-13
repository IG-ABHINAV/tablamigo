// Reports for the user content added after the first moderation pass: moments, the comments under moments and plans,
// city tips and circle meetup ideas (lib/report-targets.ts). A report must name something that exists and that the
// reporter can see, and the reporter and the author must not be on either side of a block.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['rep_alice', 'rep_bob', 'rep_carol', 'rep_dave', 'rep_erin', 'rep_admin'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@rep.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = 'rep_admin@rep.tablamigo';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<Awaited<ReturnType<typeof app.inject>>>;

let ip = 2100;
const tokens: Record<string, string> = {};
async function login(name: string, gender: 'woman' | 'man'): Promise<Api> {
  const email = `${name}@rep.tablamigo`;
  const remoteAddress = `10.97.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  tokens[name] = `Bearer ${r.json().accessToken}`;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: tokens[name] }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1996-06-06', gender, homeCountry: 'IN' });
  return call;
}
const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@rep.tablamigo'}`)[0].id as string;
const upload = async (name: string) => {
  const r = await app.inject({ method: 'POST', url: '/uploads/image/direct?kind=chat', payload: Buffer.from('fake-jpeg'), headers: { 'content-type': 'image/jpeg', authorization: tokens[name] } });
  expect(r.statusCode).toBe(200);
  return r.json().publicUrl as string;
};

const u: Record<string, Api> = {};
let aliceId: string;
// What alice wrote, by kind: the ids the reports point at.
const ids: Record<'moment' | 'moment_comment' | 'plan_comment' | 'city_tip' | 'circle_proposal', string> = {} as any;
let deletedMomentId: string, womenOnlyCommentId: string, carolPlanCommentId: string;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@rep.tablamigo'`;
  await sql`insert into geo_cache (cell, city, country) values ('18.9,72.85', 'Mumbai', 'IN') on conflict (cell) do update set city = excluded.city, country = excluded.country, cached_at = now()`;
  u.rep_alice = await login('rep_alice', 'woman');
  u.rep_bob = await login('rep_bob', 'man');
  u.rep_carol = await login('rep_carol', 'woman');
  u.rep_dave = await login('rep_dave', 'man');
  u.rep_erin = await login('rep_erin', 'woman');
  u.rep_admin = await login('rep_admin', 'woman');
  aliceId = await idOf('rep_alice');

  // A moment, and a comment under it, by alice; a second moment that she deletes.
  const m = await u.rep_alice('POST', '/moments', { caption: 'Rooftop sunset, come say hi', imageUrl: await upload('rep_alice'), city: 'Mumbai' });
  expect(m.statusCode).toBe(200);
  ids.moment = m.json().id;
  const c = await u.rep_alice('POST', `/moments/${ids.moment}/comments`, { body: 'Best chai in town is two streets over' });
  expect(c.statusCode).toBe(200);
  ids.moment_comment = c.json().id;
  const m2 = await u.rep_alice('POST', '/moments', { caption: 'This one gets deleted', imageUrl: await upload('rep_alice'), city: 'Mumbai' });
  deletedMomentId = m2.json().id;
  expect((await u.rep_alice('DELETE', `/moments/${deletedMomentId}`)).statusCode).toBe(200);

  // An open plan (alice and carol comment) and a women-only plan (alice comments).
  const plan = { category: 'explore', placeName: 'Colaba Causeway', lat: 18.9218, lng: 72.8347, startsAt: new Date(Date.now() + 86400_000).toISOString(), maxPeople: 6 };
  const open = await u.rep_alice('POST', '/activities', { ...plan, title: 'Colaba walk' });
  expect(open.statusCode).toBe(200);
  const women = await u.rep_alice('POST', '/activities', { ...plan, title: 'Women-only chai', womenOnly: true });
  expect(women.statusCode).toBe(200);
  const pc = await u.rep_alice('POST', `/activities/${open.json().id}/comments`, { body: 'Is the walk fine for beginners?' });
  expect(pc.statusCode).toBe(200);
  ids.plan_comment = pc.json().id;
  const cc = await u.rep_carol('POST', `/activities/${open.json().id}/comments`, { body: 'Yes, an easy pace' });
  expect(cc.statusCode).toBe(200);
  carolPlanCommentId = cc.json().id;
  const wc = await u.rep_alice('POST', `/activities/${women.json().id}/comments`, { body: 'Bring your own mug' });
  expect(wc.statusCode).toBe(200);
  womenOnlyCommentId = wc.json().id;

  // A city tip by alice.
  const tip = await u.rep_alice('POST', '/cities/barcelona/tips', { category: 'food', title: 'Best vermut hour', body: 'Go to the small bar behind Santa Maria del Mar at five, it is half price.' });
  expect(tip.statusCode).toBe(200);
  ids.city_tip = tip.json().id;

  // A trip circle (Reykjavik, December 2026 is this file's alone): alice pitches an idea, bob is in the circle, carol is not.
  const trip = { city: 'Reykjavik', countryCode: 'IS', startDate: '2026-12-10', endDate: '2026-12-20', lat: 64.1466, lng: -21.9426 };
  const aliceTrip = (await u.rep_alice('POST', '/trips', trip)).json().id;
  expect((await u.rep_alice('POST', `/trips/${aliceTrip}/group-chat`)).statusCode).toBe(200);
  // bob, dave and erin are in the circle (dave and erin so the block test reaches the block check for this kind too)
  for (const who of ['rep_bob', 'rep_dave', 'rep_erin']) {
    const t = (await u[who]('POST', '/trips', trip)).json().id;
    expect((await u[who]('POST', `/trips/${t}/group-chat`)).statusCode, who).toBe(200);
  }
  const prop = await u.rep_alice('POST', `/trips/${aliceTrip}/circle-proposals`, { title: 'Northern lights tour, everyone welcome', category: 'outdoors', proposedDate: '2026-12-14' });
  expect(prop.statusCode).toBe(200);
  ids.circle_proposal = prop.json().proposal.id;
});

afterAll(async () => {
  await sql`delete from users where email like '%@rep.tablamigo'`;
  await app.close();
  await sql.end();
});

const KINDS = ['moment', 'moment_comment', 'plan_comment', 'city_tip', 'circle_proposal'] as const;
const report = (who: string, targetType: string, targetId: string, reason = 'spam', details?: string) =>
  u[who]('POST', '/reports', { targetType, targetId, reason, ...(details ? { details } : {}) });

describe('reports for user content', () => {
  it('accepts a report for each kind, opens a ticket and keeps what was reported', async () => {
    const said: Record<string, string> = {
      moment: 'Rooftop sunset, come say hi', moment_comment: 'Best chai in town is two streets over', plan_comment: 'Is the walk fine for beginners?',
      city_tip: 'Best vermut hour', circle_proposal: 'Northern lights tour, everyone welcome',
    };
    for (const kind of KINDS) {
      const r = await report('rep_bob', kind, ids[kind], 'inappropriate', 'not ok');
      expect(r.statusCode, kind).toBe(200);
      expect(r.json().ref, kind).toMatch(/^TM-/);
      const [row] = await sql`select target_type, target_id, reason, details from reports where reporter_id = ${await idOf('rep_bob')} and target_type = ${kind} and target_id = ${ids[kind]}`;
      expect(row, kind).toBeTruthy();
      expect(row.reason).toBe('inappropriate');
      // the reporter's words first, then the reported text and its author: it survives the author deleting it
      expect(row.details).toContain('not ok');
      expect(row.details).toContain(said[kind]);
      expect(row.details).toContain(aliceId);
      const [ticket] = await sql`select t.ref, t.body from support_tickets t join reports r on r.id = t.report_id where r.target_id = ${ids[kind]} and r.reporter_id = ${await idOf('rep_bob')}`;
      expect(ticket.ref).toBe(r.json().ref);
      expect(ticket.body).toContain(said[kind]);
    }
  });

  it('the admin queue finds the author of each kind', async () => {
    const reports = (await u.rep_admin('GET', '/admin/reports?status=all')).json().reports.filter((r: any) => KINDS.includes(r.targetType) && r.reporterName === 'rep_bob');
    expect(reports.map((r: any) => r.targetType).sort()).toEqual([...KINDS].sort());
    for (const r of reports) expect(r.targetUserId, r.targetType).toBe(aliceId);
  });

  it('a target that does not exist, or is not a uuid, is a 404 and stores nothing', async () => {
    // Only rep_carol's reports: a global count moved when other files reported things in parallel (flaky on main).
    const carols = sql`select count(*)::int as n from reports where reporter_id = (select id from users where email = 'rep_carol@rep.tablamigo')`;
    const before = (await carols)[0].n;
    for (const kind of KINDS) {
      for (const id of ['00000000-0000-4000-8000-000000000000', "1' or '1'='1"]) {
        const r = await report('rep_carol', kind, id);
        expect(r.statusCode, `${kind} ${id}`).toBe(404);
        expect(r.json().error).toBe('report_target_not_found');
      }
    }
    expect((await sql`select count(*)::int as n from reports where reporter_id = (select id from users where email = 'rep_carol@rep.tablamigo')`)[0].n).toBe(before);
  });

  it('a deleted moment can no longer be reported', async () => {
    const r = await report('rep_bob', 'moment', deletedMomentId);
    expect(r.statusCode).toBe(404);
  });

  it('you cannot report your own content', async () => {
    for (const kind of KINDS) {
      const r = await report('rep_alice', kind, ids[kind]);
      expect(r.statusCode, kind).toBe(400);
      expect(r.json().error).toBe('cannot_report_own');
    }
  });

  it('exploit: a blocked reporter, or one who blocked the author, is refused until the block is lifted', async () => {
    const daveId = await idOf('rep_dave'), erinId = await idOf('rep_erin');
    // dave blocks alice: her content is hidden from him, so it is not his to report
    expect((await u.rep_dave('POST', `/blocks/${aliceId}`)).statusCode).toBe(200);
    // alice blocks erin: a blocked person can't keep filing reports about the person who blocked them
    expect((await u.rep_alice('POST', `/blocks/${erinId}`)).statusCode).toBe(200);
    for (const who of ['rep_dave', 'rep_erin']) {
      for (const kind of KINDS) {
        const r = await report(who, kind, ids[kind]);
        expect(r.statusCode, `${who} ${kind}`).toBe(403);
        expect(r.json().error).toBe('blocked');
      }
    }
    expect((await sql`select count(*)::int as n from reports where reporter_id in (${daveId}, ${erinId})`)[0].n).toBe(0);
    await u.rep_dave('DELETE', `/blocks/${aliceId}`);
    await u.rep_alice('DELETE', `/blocks/${erinId}`);
    expect((await report('rep_dave', 'moment', ids.moment)).statusCode).toBe(200);
    expect((await report('rep_erin', 'city_tip', ids.city_tip)).statusCode).toBe(200);
  });

  it('a women-only plan\'s comments can be reported by women only', async () => {
    const man = await report('rep_bob', 'plan_comment', womenOnlyCommentId);
    expect(man.statusCode).toBe(404);
    const woman = await report('rep_carol', 'plan_comment', womenOnlyCommentId);
    expect(woman.statusCode).toBe(200);
  });

  it('a circle idea can be reported by the circle\'s members only', async () => {
    const stranger = await report('rep_carol', 'circle_proposal', ids.circle_proposal);
    expect(stranger.statusCode).toBe(404);
    const member = await report('rep_bob', 'circle_proposal', ids.circle_proposal, 'harassment');
    expect(member.statusCode).toBe(200);
  });

  it('someone else\'s comment on a plan is reportable, and a report twice in a minute is one ticket', async () => {
    const a = await report('rep_bob', 'plan_comment', carolPlanCommentId, 'harassment');
    const b = await report('rep_bob', 'plan_comment', carolPlanCommentId, 'harassment');
    expect(a.statusCode).toBe(200);
    expect(b.json().ref).toBe(a.json().ref);
  });

  it('the old kinds behave as before, and an unknown kind is refused', async () => {
    expect((await report('rep_bob', 'user', 'x')).statusCode).toBe(200);          // stored for a person to review, as before
    expect((await report('rep_bob', 'photo', ids.moment)).statusCode).toBe(400);
  });

  it('migration 054 can run twice and keeps the check', async () => {
    const fs = await import('node:fs');
    const sqlText = fs.readFileSync(new URL('./db/migrations/054_report_target_types.sql', import.meta.url), 'utf8');
    await sql.unsafe(sqlText);
    await sql.unsafe(sqlText);
    const [c] = await sql`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'reports'::regclass and conname = 'reports_target_type_check'`;
    for (const t of ['moment', 'moment_comment', 'plan_comment', 'city_tip', 'circle_proposal']) expect(c.def).toContain(`'${t}'`);
  });
});
