// Deleting an account while Razorpay is ON (as in production): a web (Razorpay) subscription is cancelled for the person,
// at the end of the period they paid for, and the confirmation email says what happened. Play isn't configured in this file,
// so the Google Play cancel fails and the email tells them where to do it (account-deletion-play.test.ts covers the cancel). Razorpay is a fake (stubbed fetch); mail goes to a recorder.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const D = '@acctrzp.tablamigo';
const RUN = Date.now().toString(36);   // a deleted account keeps its row (and its subscription) under a new email, so ids are fresh per run
const NAMES = ['webcancel', 'webfail', 'both'];
process.env.REVIEW_EMAILS = NAMES.map(n => n + D).join(',');
process.env.REVIEW_CODE = '717171';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake-secret';

const rz = new Map<string, any>();
const rzCalls: string[] = [];
let failCancel = false;
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  const method = init.method ?? 'GET', path = u.pathname.replace(/^\/v1/, '');
  rzCalls.push(`${method} ${path}`);
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const cancel = path.match(/^\/subscriptions\/([^/]+)\/cancel$/);
  if (method === 'POST' && cancel) {
    if (failCancel) return json({ error: { description: 'gateway down' } }, 502);
    const s = rz.get(`/subscriptions/${cancel[1]}`);
    s.cancelAtCycleEnd = JSON.parse(init.body).cancel_at_cycle_end;
    return json(s);
  }
  const o = rz.get(path);
  return o ? json(o) : json({ error: { description: 'not found' } }, 400);
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');
const { syncRazorpaySubscription } = await import('./lib/razorpay.js');

let app: Awaited<ReturnType<typeof build>>;
const mails: { to: string; subject: string; text: string }[] = [];
const id: Record<string, string> = {};
const tok: Record<string, string> = {};
let ip = 0;
async function login(name: string) {
  const email = name + D, remoteAddress = `10.90.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '717171' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  tok[name] = r.json().accessToken;
  id[name] = (await sql`select id from users where email = ${email}`)[0].id;
}
const del = (name: string) => app.inject({ method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${tok[name]}` } });
/** A live monthly Plus subscription on Razorpay, stored the way the app's verify call stores it. */
async function subscribe(name: string) {
  const sub = { id: `sub_del_${name}_${RUN}`, entity: 'subscription', status: 'active', current_end: Math.floor((Date.now() + 20 * 86400_000) / 1000), notes: { service: 'tablamigo', user_id: id[name], product: 'tablamigo_plus_monthly' } };
  rz.set(`/subscriptions/${sub.id}`, sub);
  await syncRazorpaySubscription(id[name], sub.id);
  return sub;
}
const deletionMail = async (to: string) => {
  await vi.waitFor(() => expect(mails.some(m => m.to === to && m.subject === 'Your Tablamigo account is deleted')).toBe(true), { timeout: 5000 });
  return mails.find(m => m.to === to && m.subject === 'Your Tablamigo account is deleted')!;
};

beforeAll(async () => {
  app = await build();
  setMailTransport(async m => { mails.push(m as any); return { id: `re_${mails.length}` }; });
  await sql`delete from users where email like ${'%' + D}`;
  for (const n of NAMES) await login(n);
});
afterAll(async () => {
  setMailTransport(null);
  await sql`delete from users where email like ${'%' + D} or id = any(${Object.values(id)}::uuid[])`;
  await app.close();
  await sql.end();
  vi.unstubAllGlobals();
});

describe('account deletion with Razorpay on', () => {
  it('cancels the web subscription at Razorpay now (SC-06), keeps the billing record, and says so in the email', async () => {
    const sub = await subscribe('webcancel');
    expect((await sql`select cancel_requested_at from subscriptions where purchase_token = ${'rzp:' + sub.id}`)[0].cancelRequestedAt).toBeNull();

    expect((await del('webcancel')).statusCode).toBe(200);

    expect(rzCalls).toContain(`POST /subscriptions/${sub.id}/cancel`);
    expect((sub as any).cancelAtCycleEnd).toBe(0);                              // stopped now (SC-06): nothing more can be charged
    const [row] = await sql`select user_id, platform, cancel_requested_at from subscriptions where purchase_token = ${'rzp:' + sub.id}`;
    expect(row).toMatchObject({ userId: id.webcancel, platform: 'razorpay' });  // the purchase record stays (tax), on the tombstone
    expect(row.cancelRequestedAt).not.toBeNull();
    const m = await deletionMail('webcancel' + D);
    expect(m.text).toContain("We've cancelled your web Plus subscription");
    expect(m.text).not.toContain('still set to renew');
  });

  it('a Razorpay failure does not block the deletion: the account goes and the email asks them to reply so it can be cancelled by hand', async () => {
    const sub = await subscribe('webfail');
    failCancel = true;
    try { expect((await del('webfail')).statusCode).toBe(200); } finally { failCancel = false; }
    expect((await sql`select deleted_at from users where id = ${id.webfail}`)[0].deletedAt).not.toBeNull();
    expect((await sql`select cancel_requested_at from subscriptions where purchase_token = ${'rzp:' + sub.id}`)[0].cancelRequestedAt).toBeNull();
    const m = await deletionMail('webfail' + D);
    expect(m.text).toContain('Your web Plus subscription is still set to renew');
    expect(m.text).not.toContain("We've cancelled");
  });

  it('a web subscription and a Google Play subscription together: the web one is cancelled, the email sends them to Google Play for the other', async () => {
    const sub = await subscribe('both');
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at)
      values (${'tok-acctrzp-both-' + RUN}, ${id.both}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', now() + interval '25 days')`;
    expect((await del('both')).statusCode).toBe(200);
    expect(rzCalls).toContain(`POST /subscriptions/${sub.id}/cancel`);
    const m = await deletionMail('both' + D);
    expect(m.text).toContain('Your Google Play subscription is still active');
    expect(m.text).toContain("We've cancelled your web Plus subscription");
    // Play isn't configured here, so its cancel failed: the row is untouched and the email sends them to Google Play.
    expect((await sql`select status from subscriptions where purchase_token = ${'tok-acctrzp-both-' + RUN}`)[0].status).toBe('SUBSCRIPTION_STATE_ACTIVE');
  });
});
