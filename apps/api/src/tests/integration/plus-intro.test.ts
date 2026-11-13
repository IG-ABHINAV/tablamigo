// The soft paywall after onboarding (lib/plus-intro.ts, 1 Nov 2026): POST /me/plus-intro answers show = true once per account,
// never to a Plus account, never while nothing is sold, never to an old account, and only for the caller. Plus the Play trial
// offer switch the paywall reads from GET /billing/plans (PLAY_YEARLY_TRIAL_OFFER_ID).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

const D = '@plus-intro.tablamigo';
const PEOPLE = ['new1', 'new2', 'plus1', 'old1', 'other1', 'other2', 'free1', 'gone1', 'imp1', 'race1'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => p + D).join(',');
process.env.REVIEW_CODE = '864213';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { signImpersonation } = await import('../../lib/auth.js');
const { PLUS_INTRO_NEW_ACCOUNT_DAYS } = await import('../../lib/plus-intro.js');
const { signIn } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
const saved = { allFree: config.allFree, launch: config.launchPlusUntil, trial: config.playYearlyTrialOfferId };
const seen = async (id: string) => (await sql`select plus_intro_seen_at from users where id = ${id}`)[0]?.plusIntroSeenAt ?? null;
const person = (local: string) => signIn(app, local + D, '864213', 93);

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
});
beforeEach(() => { config.allFree = false; config.launchPlusUntil = null; config.playYearlyTrialOfferId = null; });
afterAll(async () => {
  Object.assign(config, { allFree: saved.allFree, launchPlusUntil: saved.launch, playYearlyTrialOfferId: saved.trial });
  await sql`delete from users where email like ${'%' + D}`;
  await app.close();
});

describe('POST /me/plus-intro', () => {
  it('shows it to a new free account exactly once, and a replay of the same request gets false', async () => {
    const p = await person('new1');
    const first = await p.call('POST', '/me/plus-intro', {});
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ show: true, reason: 'show' });
    expect(await seen(p.id)).not.toBeNull();
    for (let i = 0; i < 3; i++) expect((await p.call('POST', '/me/plus-intro', {})).json()).toEqual({ show: false, reason: 'seen' });
    // A second session (another phone, a reinstall) for the same account gets false too.
    const again = await person('new1');
    expect((await again.call('POST', '/me/plus-intro', {})).json().show).toBe(false);
    const ev = await sql`select 1 from analytics_events where user_id = ${p.id} and event_name = 'plus_intro_shown'`;
    expect(ev.length).toBe(1);
  });

  it('two requests at the same moment: only one of them shows it', async () => {
    const p = await person('race1');
    const rs = await Promise.all(Array.from({ length: 6 }, () => p.call('POST', '/me/plus-intro', {})));
    expect(rs.filter(r => r.json().show === true).length).toBe(1);
  });

  it('never to a Plus account, and the account is marked so it never comes later either', async () => {
    const p = await person('plus1');
    await sql`update users set comp_until = now() + interval '30 days', plus_until = now() + interval '30 days' where id = ${p.id}`;
    expect((await p.call('POST', '/me/plus-intro', {})).json()).toEqual({ show: false, reason: 'plus' });
    await sql`update users set comp_until = null, plus_until = null where id = ${p.id}`;
    expect((await p.call('POST', '/me/plus-intro', {})).json()).toEqual({ show: false, reason: 'seen' });
  });

  it('never while everything is free or the launch offer gives everyone Plus', async () => {
    const p = await person('free1');
    config.allFree = true;
    expect((await p.call('POST', '/me/plus-intro', {})).json()).toEqual({ show: false, reason: 'nothing_to_sell' });
    expect(await seen(p.id)).not.toBeNull();
    const q = await person('new2');
    config.allFree = false; config.launchPlusUntil = new Date(Date.now() + 86_400_000);
    expect((await q.call('POST', '/me/plus-intro', {})).json().show).toBe(false);
  });

  it(`never to an account older than ${PLUS_INTRO_NEW_ACCOUNT_DAYS} days`, async () => {
    const p = await person('old1');
    await sql`update users set created_at = now() - interval '30 days' where id = ${p.id}`;
    expect((await p.call('POST', '/me/plus-intro', {})).json()).toEqual({ show: false, reason: 'not_new' });
  });

  it("only ever touches the caller's own flag, whatever the body says", async () => {
    const a = await person('other1'); const b = await person('other2');
    const r = await a.call('POST', '/me/plus-intro', { userId: b.id, id: b.id, user_id: b.id });
    expect(r.json().show).toBe(true);
    expect(await seen(b.id)).toBeNull();
    expect((await b.call('POST', '/me/plus-intro', {})).json().show).toBe(true);
  });

  it('signed out: 401; a deleted account: 401 and nothing written', async () => {
    expect((await app.inject({ method: 'POST', url: '/me/plus-intro', payload: {} })).statusCode).toBe(401);
    const p = await person('gone1');
    await sql`update users set deleted_at = now() where id = ${p.id}`;
    expect((await p.call('POST', '/me/plus-intro', {})).statusCode).toBe(401);
    expect(await seen(p.id)).toBeNull();
  });

  it("an admin looking at the account (impersonation) can't use it up", async () => {
    const p = await person('imp1');
    const token = signImpersonation(p.id, p.id);
    const r = await app.inject({ method: 'POST', url: '/me/plus-intro', payload: {}, headers: { authorization: `Bearer ${token}` } });
    expect(r.statusCode).toBe(403);
    expect(await seen(p.id)).toBeNull();
    expect((await p.call('POST', '/me/plus-intro', {})).json().show).toBe(true);
  });
});

describe('the yearly trial switch on GET /billing/plans', () => {
  it('null while PLAY_YEARLY_TRIAL_OFFER_ID is unset, the offer id once it is set (playTrialOfferId; apps before 1.4.2 always get null)', async () => {
    const p = await person('new1');
    expect((await p.call('GET', '/billing/plans')).json().playTrialOfferId).toBeNull();
    config.playYearlyTrialOfferId = 'yearly-trial-3d';
    const me = (await p.call('GET', '/billing/me')).json();
    expect(me.playTrialOfferId).toBe('yearly-trial-3d');
    // The trial now includes a discounted first year that older apps would describe as "then <full price>/year".
    expect(me.playYearlyTrialOfferId).toBeNull();
  });
});
