// Deleting an account cancels its Google Play subscription too (12 Nov 2026): purchases.subscriptionsv2.cancel with
// DEVELOPER_REQUESTED_STOP_PAYMENTS, no further charges. If Play refuses, the deletion still goes ahead and the email tells the
// person to cancel in Google Play, as before. The Play client is a fake; mail goes to a recorder.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const D = '@acctplay.tablamigo';
const RUN = Date.now().toString(36);
const NAMES = ['playok', 'playfail', 'nosub', 'playhang'];
process.env.REVIEW_EMAILS = NAMES.map(n => n + D).join(',');
process.env.REVIEW_CODE = '727272';

const cancelled: string[] = [];
let fail = false, hang = false;
vi.mock('./lib/play-client.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib/play-client.js')>()),
  cancelPlaySubscription: async (token: string) => { if (hang) return new Promise(() => {}); if (fail) throw new Error('play 403'); cancelled.push(token); },
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { setMailTransport } = await import('./lib/mail.js');

let app: Awaited<ReturnType<typeof build>>;
const mails: { to: string; text: string }[] = [];
const id: Record<string, string> = {}, tok: Record<string, string> = {};
let ip = 0;
async function login(name: string) {
  const email = name + D, remoteAddress = `10.91.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '727272' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  tok[name] = r.json().accessToken;
  id[name] = (await sql`select id from users where email = ${email}`)[0].id;
}
const del = (name: string) => app.inject({ method: 'DELETE', url: '/me', headers: { authorization: `Bearer ${tok[name]}` } });
const playSub = (name: string, status = 'SUBSCRIPTION_STATE_ACTIVE', days = 20) => sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at)
  values (${`tok-acctplay-${name}-${status}-${RUN}`}, ${id[name]}, 'google', 'tablamigo_plus', ${status}, now() + make_interval(days => ${days}))`;
const mailTo = async (to: string) => { await expect.poll(() => mails.find(m => m.to === to), { timeout: 5000 }).toBeTruthy(); return mails.find(m => m.to === to)!; };

beforeAll(async () => {
  app = await build();
  setMailTransport(async m => { mails.push({ to: m.to, text: m.text }); return { id: 'x' }; });
  for (const n of NAMES) await login(n);
});
afterAll(async () => { setMailTransport(null); await app.close(); });

describe('DELETE /me with a Google Play subscription', () => {
  it('cancels the live one through Play (not an expired one) and the email says so', async () => {
    await playSub('playok');
    await playSub('playok', 'SUBSCRIPTION_STATE_EXPIRED', -3);
    expect((await del('playok')).statusCode).toBe(200);
    expect(cancelled).toEqual([`tok-acctplay-playok-SUBSCRIPTION_STATE_ACTIVE-${RUN}`]);
    const m = await mailTo('playok' + D);
    expect(m.text).toContain("We've cancelled your Google Play subscription");
    expect(m.text).not.toContain('still active');
  });
  it('a Play failure never blocks the deletion; the email sends them to Google Play', async () => {
    await playSub('playfail');
    fail = true;
    try { expect((await del('playfail')).statusCode).toBe(200); } finally { fail = false; }
    expect((await sql`select deleted_at from users where id = ${id.playfail}`)[0].deletedAt).not.toBeNull();
    const m = await mailTo('playfail' + D);
    expect(m.text).toContain('Your Google Play subscription is still active');
    expect(m.text).not.toContain("We've cancelled your Google Play");
  });
  it('a Play call that hangs is given up after 8 s: the account is still deleted', async () => {
    await login('playhang');
    await playSub('playhang');
    hang = true;
    try { expect((await del('playhang')).statusCode).toBe(200); } finally { hang = false; }
    expect((await sql`select deleted_at from users where id = ${id.playhang}`)[0].deletedAt).not.toBeNull();
    expect((await mailTo('playhang' + D)).text).toContain('Your Google Play subscription is still active');
  }, 20_000);
  it('no subscription: Play is never called', async () => {
    const before = cancelled.length;
    expect((await del('nosub')).statusCode).toBe(200);
    expect(cancelled).toHaveLength(before);
  });
});
