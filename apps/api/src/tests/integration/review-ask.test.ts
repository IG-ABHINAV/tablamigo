// POST /me/review-ask (lib/review-ask.ts): the server's yes or no before the app asks someone for a store rating. Earned by a
// 3rd sent chat message or by joining someone else's plan; once per 60 days per person across every surface; never for the
// store reviewer, demo personas, the team, admins or test addresses; one yes for any number of concurrent claims.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const D = '@reviewask.tablamigo';
process.env.REVIEW_ASK = 'on';
process.env.REVIEW_EMAILS = `storereviewer${D}`;
process.env.REVIEW_CODE = '135792';
process.env.ADMIN_EMAILS = `owner${D}`;
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { issueTokens, signImpersonation } = await import('../../lib/auth.js');
const { reviewAskExclusion, REVIEW_ASK_COOLDOWN_DAYS } = await import('../../lib/review-ask.js');
const { signIn, onboard, createPlan, BKK } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
type Call = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;
type P = { id: string; token: string; call: Call };
let ipN = 0;
const ip = () => `10.77.${Math.floor(++ipN / 250) % 250}.${(ipN % 250) + 1}`;

/** A real (non-review) person: created directly, signed in with real tokens, onboarded through PATCH /me. */
async function person(local: string, opts: { email?: string; role?: 'user' | 'admin'; onboard?: boolean } = {}): Promise<P> {
  const email = opts.email ?? `${local}${D}`;
  const [u] = await sql`insert into users (email, role) values (${email}, ${opts.role ?? 'user'}) returning id`;
  const { accessToken: token } = await issueTokens(u.id);
  const remoteAddress = ip();
  const call: Call = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress });
  const p = { id: u.id as string, token, call };
  if (opts.onboard !== false) await onboard({ ...p, refreshToken: '', email, ip: remoteAddress }, { name: local.slice(0, 1).toUpperCase() + local.slice(1), gender: 'woman' }, BKK);
  return p;
}
const claim = (p: P, surface = 'android', trigger = 'messages') => p.call('POST', '/me/review-ask', { surface, trigger });
const say = async (p: P, chatId: string, n: number) => {
  for (let i = 0; i < n; i++) expect((await p.call('POST', `/chats/${chatId}/messages`, { body: `hello ${i}` })).statusCode).toBe(200);
};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D} or email in ('persona-rev@demo.tablamigo', 'qa-rev@qa.test')`;
});
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D} or email in ('persona-rev@demo.tablamigo', 'qa-rev@qa.test')`;
  await app.close();
  await sql.end();
});

describe('earning the ask with chat messages', () => {
  it('no after 0, 1 and 2 sent messages; yes right after the 3rd; then no for 60 days', async () => {
    const ana = await person('ana');
    const plan = await createPlan(ana as any);
    expect((await claim(ana)).json()).toEqual({ ask: false, reason: 'not_earned' });
    await say(ana, plan.chatId, 2);
    expect((await claim(ana)).json()).toEqual({ ask: false, reason: 'not_earned' });
    await say(ana, plan.chatId, 1);
    const yes = await claim(ana);
    expect(yes.statusCode).toBe(200);
    expect(yes.json()).toMatchObject({ ask: true, askedAt: expect.any(String) });
    await say(ana, plan.chatId, 1);
    const again = (await claim(ana)).json();
    expect(again).toMatchObject({ ask: false, reason: 'cooldown' });
    const days = (new Date(again.nextAt).getTime() - new Date(yes.json().askedAt).getTime()) / 86_400_000;
    expect(days).toBeCloseTo(REVIEW_ASK_COOLDOWN_DAYS, 5);
    const [row] = await sql`select review_ask_surface from users where id = ${ana.id}`;
    expect(row.reviewAskSurface).toBe('android');
  });

  it('system lines (joins, renames) are not messages the person sent', async () => {
    const host = await person('host1');
    const bo = await person('bo');
    const plan = await createPlan(host as any);
    await say(bo, (await bo.call('POST', `/activities/${plan.id}/join`, { rsvp: 'maybe' })).json().chatId, 2);
    await sql`insert into messages (chat_id, sender_id, kind, body) values (${plan.chatId}, ${bo.id}, 'system', 'Bo joined'), (${plan.chatId}, ${bo.id}, 'system', 'x')`;
    expect((await claim(bo)).json()).toEqual({ ask: false, reason: 'not_earned' });
  });
});

describe('earning the ask by joining a plan', () => {
  it('joining someone else\'s plan as going is enough on its own', async () => {
    const host = await person('host2');
    const cy = await person('cy');
    const plan = await createPlan(host as any);
    expect((await claim(cy, 'android', 'plan_join')).json()).toEqual({ ask: false, reason: 'not_earned' });
    const j = await cy.call('POST', `/activities/${plan.id}/join`);
    expect(j.json()).toMatchObject({ rsvpStatus: 'going' });
    expect((await claim(cy, 'android', 'plan_join')).json()).toMatchObject({ ask: true });
  });

  it('hosting your own plan, a maybe and a waitlist place are not a join', async () => {
    const host = await person('host3');
    const filler = await person('filler');
    const di = await person('di');
    const full = await createPlan(host as any, { maxPeople: 2 });
    expect((await filler.call('POST', `/activities/${full.id}/join`)).json()).toMatchObject({ rsvpStatus: 'going' });
    const w = await di.call('POST', `/activities/${full.id}/join`, { rsvp: 'waitlist' });
    expect(w.statusCode, w.body).toBe(200);
    const other = await createPlan(host as any);
    expect((await di.call('POST', `/activities/${other.id}/join`, { rsvp: 'maybe' })).statusCode).toBe(200);
    expect((await claim(di, 'android', 'plan_join')).json()).toEqual({ ask: false, reason: 'not_earned' });
    expect((await claim(host, 'android', 'plan_join')).json()).toEqual({ ask: false, reason: 'not_earned' });
  });
});

describe('the 60 days', () => {
  it('are per person across surfaces: an Android ask means no web card, and after 59 days still no; after 60, yes again', async () => {
    const host = await person('host4');
    const ed = await person('ed');
    const plan = await createPlan(host as any);
    await ed.call('POST', `/activities/${plan.id}/join`);
    expect((await claim(ed, 'android')).json()).toMatchObject({ ask: true });
    expect((await claim(ed, 'web')).json()).toMatchObject({ ask: false, reason: 'cooldown' });
    expect((await claim(ed, 'ios')).json()).toMatchObject({ ask: false, reason: 'cooldown' });
    await sql`update users set review_asked_at = now() - interval '59 days 23 hours' where id = ${ed.id}`;
    expect((await claim(ed, 'web')).json()).toMatchObject({ ask: false, reason: 'cooldown' });
    await sql`update users set review_asked_at = now() - interval '60 days 1 minute' where id = ${ed.id}`;
    expect((await claim(ed, 'web')).json()).toMatchObject({ ask: true });
    const [row] = await sql`select review_ask_surface from users where id = ${ed.id}`;
    expect(row.reviewAskSurface).toBe('web');
  });

  it('a burst of concurrent claims (rapid sends, two phones) gets exactly one yes', async () => {
    const host = await person('host5');
    const fi = await person('fi');
    const plan = await createPlan(host as any);
    await fi.call('POST', `/activities/${plan.id}/join`);
    const rs = await Promise.all(Array.from({ length: 12 }, (_, i) => claim(fi, i % 2 ? 'android' : 'web')));
    expect(rs.map(r => r.statusCode).every(s => s === 200)).toBe(true);
    expect(rs.filter(r => r.json().ask === true)).toHaveLength(1);
  });
});

describe('accounts that are never asked', () => {
  const earn = async (p: P) => {
    const host = await person(`h${Math.random().toString(36).slice(2, 8)}`);
    const plan = await createPlan(host as any);
    expect((await p.call('POST', `/activities/${plan.id}/join`)).statusCode).toBe(200);
  };

  it('the Play reviewer (REVIEW_EMAILS), a demo persona, an admin and a test address, even after joining a plan', async () => {
    const rev = await signIn(app, `storereviewer${D}`, '135792', 77);
    await onboard(rev, { name: 'Reviewer', gender: 'man' }, BKK);
    const demo = await person('persona', { email: 'persona-rev@demo.tablamigo' });
    const admin = await person('boss', { role: 'admin' });
    const qa = await person('qa', { email: 'qa-rev@qa.test' });
    const owner = await person('owner');   // role 'user', an admin only through ADMIN_EMAILS
    for (const p of [rev as any as P, demo, admin, qa, owner]) {
      await earn(p);
      expect((await claim(p)).json(), JSON.stringify(p.id)).toEqual({ ask: false, reason: 'excluded' });
    }
    const [n] = await sql`select count(*)::int as n from users where id = any(${[rev.id, demo.id, admin.id, qa.id]}::uuid[]) and review_asked_at is not null`;
    expect(n.n).toBe(0);
  });

  it('someone who has not finished onboarding', async () => {
    const gi = await person('gi', { onboard: false });
    expect((await claim(gi)).json()).toEqual({ ask: false, reason: 'excluded' });
  });

  it('the exclusion rule itself', () => {
    const p = (email: string, accountKind = 'person', role = 'user') => reviewAskExclusion({ email, accountKind, role });
    expect(p(`traveller${D}`)).toBeNull();
    expect(p('priya@gmail.com')).toBeNull();
    expect(p(`STOREREVIEWER${D.toUpperCase()}`)).toBe('store_review');
    expect(p('x@demo.tablamigo')).toBe('demo');
    expect(p('host@team.tablamigo', 'team', 'admin')).toBe('team');
    expect(p('deleted-1@deleted.tablamigo')).toBe('demo');
    expect(p('admin.person@example.com', 'person', 'admin')).toBe('admin');
    expect(p(`OWNER${D}`)).toBe('admin');
    for (const e of ['a@qa.test', 'a@review.test', 'a@example.com', 'a@mail.example', 'a@x.invalid', 'a@localhost']) expect(p(e), e).toBe('test');
    expect(p('noatsign')).toBe('no_email');
    expect(p('a@testing.com')).toBeNull();
  });
});

describe('the route', () => {
  it('needs a signed-in person and a known surface and trigger', async () => {
    const hu = await person('hu');
    expect((await app.inject({ method: 'POST', url: '/me/review-ask', payload: { surface: 'android', trigger: 'messages' } })).statusCode).toBe(401);
    expect((await hu.call('POST', '/me/review-ask', { surface: 'windows', trigger: 'messages' })).statusCode).toBe(400);
    expect((await hu.call('POST', '/me/review-ask', { surface: 'web', trigger: 'five_stars' })).statusCode).toBe(400);
    expect((await hu.call('POST', '/me/review-ask', {})).statusCode).toBe(400);
  });

  it('an admin looking through someone\'s account (read-only impersonation) can never use up their ask', async () => {
    const admin = await person('lookadmin', { role: 'admin' });
    const host = await person('host6');
    const ivy = await person('ivy');
    const plan = await createPlan(host as any);
    await ivy.call('POST', `/activities/${plan.id}/join`);
    const r = await app.inject({ method: 'POST', url: '/me/review-ask', payload: { surface: 'web', trigger: 'plan_join' }, headers: { authorization: `Bearer ${signImpersonation(ivy.id, admin.id)}` }, remoteAddress: ip() });
    expect(r.statusCode).toBe(403);
    const [row] = await sql`select review_asked_at from users where id = ${ivy.id}`;
    expect(row.reviewAskedAt).toBeNull();
    expect((await claim(ivy, 'web', 'plan_join')).json()).toMatchObject({ ask: true });
  });
});

describe('the kill switch (REVIEW_ASK, off by default)', () => {
  it('off: an earned, never-asked traveller gets { ask: false, reason: disabled } and nothing is recorded; on again: yes', async () => {
    const kim = await person('kim');
    const plan = await createPlan(kim as any);
    await say(kim, plan.chatId, 3);
    config.reviewAsk = false;
    try {
      for (const surface of ['android', 'ios', 'web']) {
        const r = await claim(kim, surface);
        expect(r.statusCode).toBe(200);
        expect(r.json()).toEqual({ ask: false, reason: 'disabled' });
      }
      const [u] = await sql`select review_asked_at, review_ask_surface from users where id = ${kim.id}`;
      expect(u.reviewAskedAt).toBeNull();
      expect(u.reviewAskSurface).toBeNull();
    } finally { config.reviewAsk = true; }
    expect((await claim(kim)).json()).toMatchObject({ ask: true });
  });

});
