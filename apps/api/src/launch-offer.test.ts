// The launch offer: Plus free for everyone until LAUNCH_PLUS_UNTIL, built on the derived model (comp_until + recomputePlus), not
// as a rule in isPlus. New accounts get it at sign-up (email code, Google, admin sign-in), existing ones through
// grantLaunchPlusAll / scripts/grant-launch-plus.ts; the billing endpoint reports it; Razorpay refuses to start a purchase while it
// runs; the expiry emails say what it is. Razorpay is ON with a fake (stubbed fetch), Google's ID-token check is mocked, mail goes
// to a recorder. Calls that go through every account are scoped to this file's own accounts (the database is shared).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const D = '@launch.tablamigo';
const NAMES = ['during', 'existing', 'late', 'expiring', 'refa', 'refb', 'rzp', 'rzp2'];
process.env.REVIEW_EMAILS = NAMES.map(n => n + D).join(',');
process.env.REVIEW_CODE = '424242';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret';
process.env.RAZORPAY_PLAN_MONTHLY = 'plan_monthly_fake';
process.env.RAZORPAY_PLAN_YEARLY = 'plan_yearly_fake';

// Google's ID-token check, as in google-signin.test.ts: a "token" is base64 JSON of the claims.
const verifyIdToken = vi.fn(async ({ idToken, audience }: { idToken: string; audience: string }) => {
  const claims = JSON.parse(Buffer.from(idToken, 'base64url').toString());
  if (claims.aud !== audience) throw new Error('Wrong recipient');
  return { getPayload: () => claims };
});
vi.mock('google-auth-library', async orig => ({ ...(await orig<any>()), OAuth2Client: class { verifyIdToken = verifyIdToken; } }));

// The real grantLaunchPlus, unless a test makes it fail (to show a failing grant never stops a sign-up).
const ctl = vi.hoisted(() => ({ failGrant: false }));
vi.mock('./lib/play.js', async importOriginal => {
  const real = await importOriginal<typeof import('./lib/play.js')>();
  return { ...real, grantLaunchPlus: (...a: Parameters<typeof real.grantLaunchPlus>) => ctl.failGrant ? Promise.reject(new Error('grant exploded')) : real.grantLaunchPlus(...a) };
});

// Razorpay (fake): creates orders and subscriptions, and knows the payments a test registers. Every call is recorded.
const rzCalls: string[] = [];
const rzPayments = new Map<string, any>();
let rzN = 0;
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : {}, path = u.pathname.replace(/^\/v1/, '');
  rzCalls.push(`${method} ${path}`);
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST' && path === '/orders') return json({ id: `order_launch_${++rzN}`, amount: body.amount, currency: body.currency, notes: body.notes });
  if (method === 'POST' && path === '/subscriptions') return json({ id: `sub_launch_${++rzN}`, notes: body.notes });
  const orderOrPayment = path.match(/^\/(orders|payments)\/(.+)$/);
  const o = orderOrPayment && rzPayments.get(`${orderOrPayment[1]}/${orderOrPayment[2]}`);
  return o ? json(o) : json({ error: { description: 'not found' } }, 400);
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config, parseLaunchPlusUntil } = await import('./lib/config.js');
const { launchOffer } = await import('./lib/plus.js');
const { grantLaunchPlus, grantLaunchPlusAll, recomputePlus } = await import('./lib/play.js');
const { plusLifecycle } = await import('./lib/emails/jobs.js');
const { setMailTransport } = await import('./lib/mail.js');

let app: Awaited<ReturnType<typeof build>>;
const DAY = 86400_000, MIN = 60_000;
const sign = (payload: string) => crypto.createHmac('sha256', 'fake-secret').update(payload).digest('hex');
const mails: { to: string; subject: string; text: string }[] = [];
let ip = 0;

type Res = Awaited<ReturnType<typeof app.inject>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<Res>;
const api: Record<string, Api> = {};
const id: Record<string, string> = {};
/** Sign-in with the fixed review code (creates the account when the email is new). */
async function signIn(name: string) {
  const email = name + D, remoteAddress = `10.66.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  api[name] = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  id[name] = (await sql`select id from users where email = ${email}`)[0].id;
  return r;
}
const row = async (userId: string) => (await sql`select plus_until, comp_until from users where id = ${userId}`)[0] as { plusUntil: Date | null; compUntil: Date | null };
const ms = (d: Date | null) => d ? d.getTime() : null;
/** The offer ends `minutes` from now (short enough that a token issued now is still valid when the clock is moved past it). */
const offerEndingIn = (minutes: number) => (config.launchPlusUntil = new Date(Math.floor((Date.now() + minutes * MIN) / 1000) * 1000));

beforeAll(async () => {
  app = await build();
  setMailTransport(async m => { mails.push(m as any); return { id: `re_${mails.length}` }; });
  await sql`delete from users where email like ${'%' + D}`;
});
afterAll(async () => {
  config.launchPlusUntil = null;
  setMailTransport(null);
  await sql`delete from users where email like ${'%' + D}`;
  await app.close();
  await sql.end();
  vi.unstubAllGlobals();
});
afterEach(() => { vi.useRealTimers(); config.launchPlusUntil = null; });

describe('the setting and the helper', () => {
  it('LAUNCH_PLUS_UNTIL: unset or empty is no offer; an ISO instant with a zone is its end; anything else refuses to start', () => {
    for (const none of [undefined, '', '   ']) expect(parseLaunchPlusUntil(none), JSON.stringify(none)).toBeNull();
    expect(parseLaunchPlusUntil('2026-12-31T18:29:59Z')!.toISOString()).toBe('2026-12-31T18:29:59.000Z');
    expect(parseLaunchPlusUntil('2026-12-31T23:59:59+05:30')!.toISOString()).toBe('2026-12-31T18:29:59.000Z');   // 23:59 in India
    expect(parseLaunchPlusUntil(' 2026-12-31T18:29:59.500Z ')!.getTime()).toBe(Date.parse('2026-12-31T18:29:59.500Z'));
    // A date with no zone would be read in the server's time zone; a typo would silently end the offer early or never.
    for (const bad of ['2026-12-31', '2026-12-31T23:59:59', 'tomorrow', '31/12/2026', '2026-13-45T00:00:00Z', 'null', '1798741799']) {
      expect(() => parseLaunchPlusUntil(bad), bad).toThrow(/Invalid LAUNCH_PLUS_UNTIL/);
    }
    expect(config.launchPlusUntil).toBeNull();      // off unless the environment sets it
  });

  it('launchOffer(): none when unset; active up to, not at, the end instant; the end stays reported once it is over', () => {
    expect(launchOffer()).toEqual({ active: false, until: null });
    const end = new Date('2026-12-31T18:29:59Z');
    config.launchPlusUntil = end;
    expect(launchOffer(new Date(end.getTime() - 1))).toEqual({ active: true, until: end });
    expect(launchOffer(end)).toEqual({ active: false, until: end });
    expect(launchOffer(new Date(end.getTime() + DAY))).toEqual({ active: false, until: end });
  });
});

describe('sign-up', () => {
  it('a new account made during the offer has Plus until its end (email code), and /billing/plans says so', async () => {
    const end = offerEndingIn(20);
    const r = await signIn('during');
    expect(r.json().isNew).toBe(true);
    const me = (await api.during('GET', '/me')).json();
    expect(me.plus).toBe(true);
    expect(new Date(me.plusUntil).getTime()).toBe(end.getTime());
    expect(await row(id.during)).toMatchObject({ plusUntil: end, compUntil: end });          // the offer is comp_until, plus_until derived from it

    for (const url of ['/billing/plans', '/billing/me']) {
      const plans = (await api.during('GET', url)).json();
      expect(plans.launchOffer, url).toEqual({ active: true, until: end.toISOString() });
      expect(plans).toMatchObject({ plus: true, products: expect.any(Array), limits: expect.any(Object) });
    }
  });

  it('a new account made through Google sign-in has it too', async () => {
    const end = offerEndingIn(20);
    const WEB = config.googleWebClientId;
    const idToken = Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: WEB, sub: 'g-launch-1', email: 'google' + D, email_verified: true, given_name: 'Gia' })).toString('base64url');
    const r = await app.inject({ method: 'POST', url: '/auth/google', payload: { idToken }, remoteAddress: `10.66.1.${++ip}` });
    expect(r.statusCode).toBe(200);
    expect(r.json().isNew).toBe(true);
    const uid = (await sql`select id from users where email = ${'google' + D}`)[0].id;
    expect(await row(uid)).toMatchObject({ plusUntil: end, compUntil: end });
    const me = await app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${r.json().accessToken}` } });
    expect(me.json().plus).toBe(true);
  });

  it('after the end date a new account has no Plus, and /billing/plans reports the offer as over', async () => {
    const end = (config.launchPlusUntil = new Date(Date.now() - MIN));
    await signIn('late');
    const me = (await api.late('GET', '/me')).json();
    expect(me.plus).toBe(false);
    expect(me.plusUntil).toBeNull();
    expect(await row(id.late)).toEqual({ plusUntil: null, compUntil: null });
    expect((await api.late('GET', '/billing/plans')).json().launchOffer).toEqual({ active: false, until: end.toISOString() });
    config.launchPlusUntil = null;
    expect((await api.late('GET', '/billing/plans')).json().launchOffer).toEqual({ active: false, until: null });
  });

  it('Plus ends by itself at the end of the offer (nothing to switch off)', async () => {
    const end = offerEndingIn(20);
    await signIn('expiring');
    expect((await api.expiring('GET', '/me')).json().plus).toBe(true);
    // The clock passes the end: the same account, the same token, no Plus. Only Date is faked.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(end.getTime() + 1000));
    const me = (await api.expiring('GET', '/me')).json();
    expect(me.plus).toBe(false);
    expect(new Date(me.plusUntil).getTime()).toBe(end.getTime());   // still on record, in the past
    expect((await api.expiring('GET', '/billing/plans')).json()).toMatchObject({ plus: false, launchOffer: { active: false } });
  });

  it('an account that already existed is not touched by signing in again (the script grants those)', async () => {
    await signIn('existing');                         // no offer yet
    expect(await row(id.existing)).toEqual({ plusUntil: null, compUntil: null });
    offerEndingIn(20);
    await signIn('existing');
    expect(await row(id.existing)).toEqual({ plusUntil: null, compUntil: null });
    expect((await api.existing('GET', '/me')).json().plus).toBe(false);
  });

  it('a grant that fails never stops a sign-up: the account is made and signed in, and the script can grant it afterwards', async () => {
    const end = offerEndingIn(20);
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.failGrant = true;
    try {
      const r = await signIn('rzp2');
      expect(r.json().isNew).toBe(true);
      expect(quiet).toHaveBeenCalledWith('launch plus grant failed', 'grant exploded');
      expect((await api.rzp2('GET', '/me')).json().plus).toBe(false);
    } finally { ctl.failGrant = false; quiet.mockRestore(); }
    expect(await grantLaunchPlusAll({ userIds: [id.rzp2] })).toMatchObject({ users: 1, granted: 1, gained: 1 });
    expect(await row(id.rzp2)).toEqual({ plusUntil: end, compUntil: end });
  });
});

describe('the greatest of everything that grants Plus still holds', () => {
  it('a later admin comp, a subscription that runs past the end, and a referral stacked after it all keep their dates', async () => {
    const end = offerEndingIn(20);
    const make = async (name: string) => (id[name] = (await sql`insert into users (email, name) values (${name + D}, ${name}) returning id`)[0].id);
    const comp = await make('compbig'), sub = await make('subbeyond'), plain = await make('plain');
    const comp2099 = new Date('2099-01-01T00:00:00Z');
    await sql`update users set comp_until = ${comp2099} where id = ${comp}`;
    await recomputePlus(comp);
    const subEnds = new Date(Math.floor((end.getTime() + 40 * DAY) / 1000) * 1000);
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at) values ('tok-launch-sub', ${sub}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', ${subEnds})`;
    await recomputePlus(sub);

    for (const uid of [comp, sub, plain]) expect(await grantLaunchPlus(uid)).toBe(true);
    expect(await row(comp)).toEqual({ plusUntil: comp2099, compUntil: comp2099 });       // greatest of the two comps
    expect(await row(sub)).toEqual({ plusUntil: subEnds, compUntil: end });             // the subscription is later: Plus follows it
    expect(await row(plain)).toEqual({ plusUntil: end, compUntil: end });
    // Idempotent: again, nothing moves.
    for (const uid of [comp, sub, plain]) await grantLaunchPlus(uid);
    expect(await row(plain)).toEqual({ plusUntil: end, compUntil: end });

    // The subscription is refunded: the offer is still there underneath, until its end.
    await sql`update subscriptions set status = 'SUBSCRIPTION_STATE_EXPIRED' where purchase_token = 'tok-launch-sub'`;
    await recomputePlus(sub);
    expect(ms((await row(sub)).plusUntil)).toBe(end.getTime());
    await sql`delete from users where id = any(${[comp, sub, plain]}::uuid[])`;
  });

  it('referral days stack after the end of the offer, not inside it', async () => {
    const end = offerEndingIn(20);
    await signIn('refa');
    await signIn('refb');
    const code = (await api.refa('GET', '/me/referral')).json().referralCode;
    const r = await api.refb('POST', '/me/referral/redeem', { code });
    expect(r.statusCode).toBe(200);
    expect(r.json().referrerRewarded).toBe(true);
    // comp_until = greatest(now, comp_until, plus_until) + 7 days = the end of the offer + 7 days, for both people.
    for (const who of ['refa', 'refb']) {
      const x = await row(id[who]);
      expect(ms(x.compUntil), who).toBe(end.getTime() + 7 * DAY);
      expect(ms(x.plusUntil), who).toBe(end.getTime() + 7 * DAY);
    }
  });
});

describe('grantLaunchPlusAll and scripts/grant-launch-plus.ts: the accounts that exist already', () => {
  const people = ['none', 'short', 'beyond', 'handset', 'compbig', 'gone', 'banned'];
  const mine = () => people.map(p => id['g_' + p]);
  const E = new Date('2031-06-30T18:29:59Z');
  const state = async () => Object.fromEntries(await Promise.all(people.map(async p => [p, await row(id['g_' + p])])));

  beforeAll(async () => {
    const make = async (p: string, extra: Record<string, unknown> = {}) => (id['g_' + p] = (await sql`insert into users (email, name, plus_until, comp_until, deleted_at, banned_at)
      values (${'g_' + p + D}, ${p}, ${(extra.plus as Date) ?? null}, ${(extra.comp as Date) ?? null}, ${(extra.deleted as Date) ?? null}, ${(extra.banned as Date) ?? null}) returning id`)[0].id);
    const soon = new Date(Date.now() + 2 * DAY), beyond = new Date(E.getTime() + 30 * DAY);
    await make('none');                                              // no Plus at all
    await make('short', { plus: soon });                             // Plus that ends before the offer does
    await make('beyond', { plus: beyond });                          // a subscription that runs past the end
    await make('handset', { plus: new Date('2040-01-01T00:00:00Z') });   // Plus written by hand, nothing behind it (like the founder's)
    await make('compbig', { plus: new Date('2099-01-01T00:00:00Z'), comp: new Date('2099-01-01T00:00:00Z') });
    await make('gone', { deleted: new Date() });
    await make('banned', { banned: new Date() });
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at) values ('tok-launch-short', ${id.g_short}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', ${soon})`;
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at) values ('tok-launch-beyond', ${id.g_beyond}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', ${beyond})`;
  });

  it('refuses when there is no offer or it is over', async () => {
    await expect(grantLaunchPlusAll({ dryRun: true, userIds: mine() })).rejects.toThrow('launch_offer_not_active');
    config.launchPlusUntil = new Date(Date.now() - MIN);
    await expect(grantLaunchPlusAll({ userIds: mine() })).rejects.toThrow('launch_offer_not_active');
  });

  it('a dry run reports who would get what and writes nothing', async () => {
    config.launchPlusUntil = E;
    const before = await state();
    const r = await grantLaunchPlusAll({ dryRun: true, userIds: mine() });
    // 5 accounts count (a deleted and a banned one don't); 4 need the grant; one had no Plus, one had Plus ending sooner.
    expect(r).toMatchObject({ until: E, users: 5, granted: 4, gained: 1, extended: 1, alreadyBeyond: 3 });
    expect(await state()).toEqual(before);
  });

  it('applying sets comp_until to the end of the offer and never lowers anyone; a second run finds nothing to do', async () => {
    config.launchPlusUntil = E;
    const before = await state();
    const r = await grantLaunchPlusAll({ userIds: mine() });
    expect(r).toMatchObject({ users: 5, granted: 4, gained: 1, extended: 1, alreadyBeyond: 3 });
    const after = await state();
    expect(after.none).toEqual({ plusUntil: E, compUntil: E });                                   // Plus until the end
    expect(after.short).toEqual({ plusUntil: E, compUntil: E });                                  // extended to the end
    expect(ms(after.beyond.plusUntil)).toBe(ms(before.beyond.plusUntil));                         // its subscription is later: kept
    expect(after.beyond.compUntil).toEqual(E);                                                    // ...with the offer as a floor under it
    expect(ms(after.handset.plusUntil)).toBe(ms(before.handset.plusUntil));                       // hand-set Plus beyond the end is not lowered
    expect(after.handset.compUntil).toEqual(E);
    expect(after.compbig).toEqual(before.compbig);                                                // a bigger comp stays
    expect(after.gone).toEqual({ plusUntil: null, compUntil: null });                             // deleted and banned accounts are left alone
    expect(after.banned).toEqual({ plusUntil: null, compUntil: null });
    for (const p of people) expect(ms(after[p].plusUntil) ?? 0, p).toBeGreaterThanOrEqual(ms(before[p].plusUntil) ?? 0);   // nobody lost anything

    const again = await grantLaunchPlusAll({ userIds: mine() });
    expect(again).toMatchObject({ users: 5, granted: 0, gained: 0, extended: 0 });
    expect(await state()).toEqual(after);
  });

  describe('the command line', () => {
    const run = (env: Record<string, string>, ...args: string[]) => promisify(execFile)('npx', ['tsx', 'src/scripts/grant-launch-plus.ts', ...args], { env: { ...process.env, NODE_ENV: 'test', LAUNCH_PLUS_UNTIL: '', ...env } })
      .then(r => ({ code: 0, out: r.stdout }), (e: any) => ({ code: e.code as number, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }));
    const host = new URL(process.env.DATABASE_URL ?? 'postgres://tablamigo:tablamigo-local@localhost:5434/tablamigo').hostname;

    it('reports by default and with --dry-run, writes only with --apply, and says which database it is on', async () => {
      const one = id.g_none;
      await sql`update users set comp_until = null, plus_until = null where id = ${one}`;
      const end = new Date(Date.now() + 5 * DAY).toISOString();
      for (const flags of [[], ['--dry-run']]) {
        const r = await run({ LAUNCH_PLUS_UNTIL: end }, ...flags, `--user=${one}`);
        expect(r.code, flags.join(' ')).toBe(0);
        expect(r.out).toContain(`database: ${host}`);
        expect(r.out).toContain('report only, nothing is written');
        expect(r.out).toContain(`offer ends: ${end.replace(/\.000Z$/, '.000Z')}`);
        expect(r.out).toMatch(/to be granted:\s+1/);
        expect(r.out).toMatch(/had no Plus:\s+1/);
        expect(await row(one)).toEqual({ plusUntil: null, compUntil: null });
      }
      const applied = await run({ LAUNCH_PLUS_UNTIL: end }, '--apply', `--user=${one}`);
      expect(applied.code).toBe(0);
      expect(applied.out).toContain('APPLYING changes');
      expect(ms((await row(one)).compUntil)).toBe(Date.parse(end));
      expect(ms((await row(one)).plusUntil)).toBe(Date.parse(end));
      const again = await run({ LAUNCH_PLUS_UNTIL: end }, '--apply', `--user=${one}`);
      expect(again.out).toContain('Nothing to grant');
    }, 90_000);

    it('refuses without an offer, with an offer that is over, and with arguments it does not know', async () => {
      const none = await run({}, '--dry-run');
      expect(none.code).toBe(2);
      expect(none.out).toContain('LAUNCH_PLUS_UNTIL is not set');
      const over = await run({ LAUNCH_PLUS_UNTIL: new Date(Date.now() - DAY).toISOString() }, '--dry-run');
      expect(over.code).toBe(2);
      expect(over.out).toContain('nothing to grant');
      expect((await run({ LAUNCH_PLUS_UNTIL: '2031-01-01' }, '--dry-run')).out).toContain('Invalid LAUNCH_PLUS_UNTIL');
      const future = { LAUNCH_PLUS_UNTIL: new Date(Date.now() + DAY).toISOString() };
      expect((await run(future, '--everything')).code).toBe(2);
      expect((await run(future, '--apply', '--dry-run')).code).toBe(2);
      expect((await run(future, '--user=not-a-uuid')).code).toBe(2);
    }, 90_000);
  });
});

describe('Razorpay while the offer runs', () => {
  const pay = (kind: 'orders' | 'payments', obj: any) => rzPayments.set(`${kind}/${obj.id}`, obj);

  it('exploit: no new order and no new subscription is created on Razorpay while Plus is free (409 launch_offer_free)', async () => {
    const end = offerEndingIn(20);
    await signIn('rzp');
    rzCalls.length = 0;
    for (const [url, payload] of [['/billing/razorpay/pass-order', {}], ['/billing/razorpay/subscribe', { period: 'monthly' }], ['/billing/razorpay/subscribe', { period: 'yearly' }]] as const) {
      const r = await api.rzp('POST', url, payload);
      expect(r.statusCode, url).toBe(409);
      expect(r.json(), url).toMatchObject({ error: 'launch_offer_free', until: end.toISOString(), message: expect.stringMatching(/^Plus is free for everyone until \d{1,2} \w+ \d{4}, so there is nothing to buy right now/) });
    }
    expect(rzCalls).toEqual([]);                                 // nothing was created at Razorpay
    // Signed out is still a 401, not a 409.
    expect((await app.inject({ method: 'POST', url: '/billing/razorpay/subscribe', payload: { period: 'monthly' } })).statusCode).toBe(401);
    // The message names the day in India: 31 December 2026 23:59 IST is 18:29 UTC the same day.
    config.launchPlusUntil = new Date('2026-12-31T18:29:59Z');
    expect((await api.rzp('POST', '/billing/razorpay/subscribe', { period: 'monthly' })).json().message).toContain('until 31 December 2026,');
    config.launchPlusUntil = new Date('2026-12-31T19:30:00Z');          // 1 Jan 01:00 in India
    expect((await api.rzp('POST', '/billing/razorpay/pass-order', {})).json().message).toContain('until 1 January 2027,');
  });

  it('finishing a purchase that was already paid for still works (the verify calls are not refused), and Play is not touched', async () => {
    offerEndingIn(20);
    const o = { id: 'order_paid_before', amount: 29900, currency: 'INR', notes: { service: 'tablamigo', user_id: id.rzp, product: 'tablamigo_trip_pass' } };
    pay('orders', o);
    pay('payments', { id: 'pay_paid_before', order_id: o.id, amount: 29900, currency: 'INR', status: 'captured', notes: o.notes });
    const r = await api.rzp('POST', '/billing/razorpay/pass-verify', { orderId: o.id, paymentId: 'pay_paid_before', signature: sign(`${o.id}|pay_paid_before`) });
    expect(r.statusCode).toBe(200);
    expect(r.json().active).toBe(true);
    // Google Play purchases are the store's business: this endpoint doesn't know about the offer (it fails for want of a
    // Play account here, not with launch_offer_free).
    const play = await api.rzp('POST', '/billing/google/verify', { productId: 'tablamigo_plus', purchaseToken: 'x'.repeat(20) });
    expect(play.json().error).not.toBe('launch_offer_free');
  });

  it('after the end, or with no offer, orders and subscriptions are created as before', async () => {
    for (const setting of [new Date(Date.now() - MIN), null]) {
      config.launchPlusUntil = setting;
      rzCalls.length = 0;
      const order = await api.rzp('POST', '/billing/razorpay/pass-order', {});
      expect(order.statusCode, String(setting)).toBe(200);
      expect(order.json()).toMatchObject({ orderId: expect.stringMatching(/^order_launch_/), amount: 29900 });
      const sub = await api.rzp('POST', '/billing/razorpay/subscribe', { period: 'yearly' });
      expect(sub.statusCode, String(setting)).toBe(200);
      expect(sub.json().subscriptionId).toMatch(/^sub_launch_/);
      expect(rzCalls).toEqual(['POST /orders', 'POST /subscriptions']);
    }
  });
});

describe('the expiry emails', () => {
  // The offer ends 31 Dec 2031 18:29:59 UTC. Everything below gives lifecycle emails the time ("now") and only looks at accounts
  // whose Plus ends within 3 days of it, so nothing here touches another test file's accounts.
  const END = new Date('2031-12-31T18:29:59Z');
  const before = new Date('2031-12-29T00:00:00Z'), after = new Date('2032-01-01T00:00:00Z');
  const to = (who: string) => mails.filter(m => m.to === who + D);
  const user: Record<string, string> = {};

  beforeAll(async () => {
    const make = async (n: string, comp: Date | null) => (user[n] = (await sql`insert into users (email, name, comp_until) values (${'e_' + n + D}, ${n}, ${comp}) returning id`)[0].id);
    await make('launchonly', END);                                                // Plus only from the offer
    await make('admincomp', new Date('2031-12-30T00:00:00Z'));                    // an admin comp that happens to end near it
    await make('cancelled', END);                                                 // a cancelled subscription that ends with the offer
    await make('renewing', END);                                                  // an auto-renewing subscription that runs on
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, cancel_requested_at) values ('tok-launch-cancelled', ${user.cancelled}, 'razorpay', 'tablamigo_plus', 'SUBSCRIPTION_STATE_CANCELED', ${END}, now())`;
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at) values ('tok-launch-renewing', ${user.renewing}, 'razorpay', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', ${new Date(END.getTime() + 20 * DAY)})`;
    for (const n of Object.keys(user)) await recomputePlus(user[n]);
  });
  afterAll(async () => { await sql`delete from users where id = any(${Object.values(user)}::uuid[])`; });

  it('an account whose only Plus is the launch offer is told the offer is ending, with what Plus costs, and nothing says it renews', async () => {
    config.launchPlusUntil = END;
    mails.length = 0;
    await plusLifecycle({}, before);
    const [m] = to('e_launchonly');
    expect(to('e_launchonly')).toHaveLength(1);
    expect(m.subject).toBe('Your free Plus ends in 3 days');
    expect(m.text).toContain('The launch offer ends on Wed 31 Dec 2031');
    expect(m.text).toContain('Plus has been free for everyone since we launched');
    expect(m.text).toContain('₹499 a month');
    expect(m.text).toContain('₹3,999 a year');
    expect(m.text).toContain(`you won't be charged`);
    expect(m.text).not.toMatch(/renew|subscription|complimentary/i);

    // Other kinds of Plus keep their own wording.
    expect(to('e_admincomp')[0].text).toContain('the complimentary Plus we gave you runs out');
    expect(to('e_admincomp')[0].text).not.toMatch(/launch offer/i);
    expect(to('e_cancelled')[0].text).toContain('your Plus is set not to renew');
    expect(to('e_cancelled')[0].text).not.toMatch(/launch offer/i);
    expect(to('e_renewing')).toHaveLength(0);                                      // it renews: no "ending" email at all

    // Once only.
    await plusLifecycle({}, before);
    expect(to('e_launchonly')).toHaveLength(1);
  });

  it('after the end the same account is told the offer has ended, and what Plus costs', async () => {
    config.launchPlusUntil = END;
    mails.length = 0;
    await plusLifecycle({}, after);
    const [m] = to('e_launchonly');
    expect(to('e_launchonly')).toHaveLength(1);
    expect(m.subject).toBe('The Tablamigo launch offer has ended');
    expect(m.text).toContain('Plus was free for everyone while we launched');
    expect(m.text).toContain('₹499 a month');
    expect(m.text).toContain('₹3,999 a year');
    expect(m.text).not.toMatch(/renew|subscription|complimentary/i);
    expect(to('e_admincomp')[0].subject).toBe('Your Tablamigo Plus has ended');    // the old wording for any other comp
    expect(to('e_admincomp')[0].text).not.toMatch(/launch offer/i);
    expect(to('e_renewing')).toHaveLength(0);
  });

  it('without the setting the same account gets the plain comp wording (nothing says "launch")', async () => {
    const u = (await sql`insert into users (email, name, comp_until) values (${'e_nosetting' + D}, 'nosetting', ${END}) returning id`)[0].id as string;
    user.nosetting = u;
    await recomputePlus(u);
    config.launchPlusUntil = null;
    mails.length = 0;
    await plusLifecycle({}, before);
    expect(to('e_nosetting')[0].text).toContain('the complimentary Plus we gave you runs out');
    expect(to('e_nosetting')[0].text).not.toMatch(/launch offer/i);
  });
});
