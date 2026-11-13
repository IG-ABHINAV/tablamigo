// Journey: Asha shares her invite link, Ben opens it, installs from Google Play (the invite page puts the code in the install
// referrer), signs up and onboards, and both see Plus with the invite days; Ben's inbox says who gave it. A second friend uses the
// web app link (?ref=) instead. Real routes end to end with signed-in people (review code); the website half of the journey (the
// page turning ?code= into those two links) is apps/web/tests/browser-smoke.mjs.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@invite-e2e.tablamigo';
process.env.REVIEW_EMAILS = ['asha', 'ben', 'cleo'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '515151';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { REFERRAL } = await import('../../lib/plus.js');
const { signIn, onboard, freshIp } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let asha: Person;
const cleanup = () => sql`delete from users where email like ${'%' + D}`;

/** What the invite page builds: the Play referrer for Android, the web app's query for everyone else. */
function linksFrom(link: string) {
  const code = new URL(link).searchParams.get('code')!;
  return { code, playReferrer: `utm_source=invite&utm_medium=referral&ref=${code}`, web: `/app/?ref=${code}&utm_source=invite&utm_medium=referral` };
}

async function signUpWith(email: string, extra: Record<string, unknown>): Promise<Person> {
  const remoteAddress = freshIp(84);
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '515151', ...extra }, remoteAddress, headers: { 'user-agent': 'okhttp/4.12.0' } });
  expect(r.statusCode, r.body).toBe(200);
  expect(r.json().isNew).toBe(true);
  const { accessToken: token, refreshToken } = r.json();
  const call = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress });
  const me = await call('GET', '/me');
  return { call, id: me.json().id, token, refreshToken, email, ip: remoteAddress };
}

beforeAll(async () => {
  app = await build();
  await cleanup();
  asha = await onboard(await signIn(app, 'asha' + D, '515151', 84), { name: 'Asha', gender: 'woman' });
});
afterAll(async () => { await cleanup(); await app.close(); await sql.end(); });

describe('an invite link, start to finish', () => {
  let link = '';
  it('Asha gets a link that opens the website invite page', async () => {
    const r = (await asha.call('GET', '/me/referral')).json();
    link = r.referralLink;
    expect(link).toMatch(/^https:\/\/tablamigo\.hookstep\.in\/invite\?code=[A-Z0-9]{4,16}$/);
    expect(r.totalReferred).toBe(0);
  });

  it('Ben installs from Play through it, signs up and onboards: both have Plus, nobody typed a code', async () => {
    const { playReferrer } = linksFrom(link);
    const ben = await onboard(await signUpWith('ben' + D, { install_referrer: playReferrer }), { name: 'Ben', gender: 'man' });
    const me = (await ben.call('GET', '/me')).json();
    expect(me.isPlus ?? me.plus).toBe(true);
    const inbox = (await ben.call('GET', '/inbox')).json();
    const items = inbox.notifications ?? inbox.items ?? inbox;
    expect(JSON.stringify(items)).toContain(`${REFERRAL.rewardDays} days of Tablamigo Plus from Asha`);
    const a = (await asha.call('GET', '/me/referral')).json();
    expect(a.totalReferred).toBe(1);
    expect(a.daysEarned).toBe(REFERRAL.rewardDays);
    expect(((await asha.call('GET', '/me')).json().isPlus ?? (await asha.call('GET', '/me')).json().plus)).toBe(true);
  });

  it('Cleo uses the web app link instead and is credited the same way', async () => {
    const { code, web } = linksFrom(link);
    const cleo = await signUpWith('cleo' + D, { ref_code: code, utm_source: 'invite', utm_medium: 'referral', landing: web });
    const [row] = await sql`select referred_by, attribution from users where id = ${cleo.id}`;
    expect(row.referredBy).toBe(asha.id);
    expect(row.attribution.source).toBe('invite');
    expect((await asha.call('GET', '/me/referral')).json().totalReferred).toBe(2);
  });
});
