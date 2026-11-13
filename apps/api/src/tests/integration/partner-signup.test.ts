// Self-serve partner sign-up (routes/partner.ts, lib/partner-signup.ts) end to end: the Fastify app in-process on the test
// PostGIS. A signed-in member accepts the partner terms and gets a code and link at the default 30%; the link, the Play install
// referrer, a typed code and a checkout coupon attribute new accounts to it; commissions accrue through the existing ledger
// (lib/affiliate-ledger.ts), never on the partner's own purchases and never while paused or ended. Then the break-it cases: double
// sign-up and races, a percent in the body, stale terms, the rate limit, banned and snoozed members, injection in payout details,
// what the partner can and cannot see, and a referral loop (A brings B, B's code on A).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'node:crypto';

const D = '@psu.tablamigo';
const NAMES = Array.from({ length: 60 }, (_, i) => `p${i}`).concat(['admin']);
process.env.REVIEW_EMAILS = NAMES.map(n => n + D).join(',');
process.env.REVIEW_CODE = '515151';
process.env.ADMIN_EMAILS = `admin${D}`;

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { setMailTransport } = await import('../../lib/mail.js');
const { accrueCommission, attributeReferral } = await import('../../lib/affiliate-ledger.js');
const { couponAffiliate } = await import('../../lib/affiliates.js');
const { PARTNER_TERMS } = await import('../../lib/partner-signup.js');

let app: Awaited<ReturnType<typeof build>>;
const R = crypto.randomBytes(3).toString('hex');
type P = { id: string; email: string; ip: string; token: string; call: (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response> };
let ipN = 0;
const nextIp = () => `10.88.${Math.floor(++ipN / 250)}.${(ipN % 250) + 1}`;
let next = 0;
const fresh = () => `p${next++}`;

/** A new account, with what the app sends at sign-up (ref_code, install_referrer). */
async function signUp(name = fresh(), extra: Record<string, unknown> = {}, ip = nextIp()): Promise<P> {
  const email = name + D;
  const st = await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress: ip });
  expect(st.statusCode, `start ${email}: ${st.body}`).toBe(200);
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '515151', ...extra }, remoteAddress: ip });
  expect(r.statusCode, `verify ${email}: ${r.body}`).toBe(200);
  const token = r.json().accessToken;
  const id = (await sql`select id from users where email = ${email}`)[0].id as string;
  return { id, email, ip, token, call: (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` }, remoteAddress: ip }) };
}
const join = (p: P, body: Record<string, unknown> = { acceptTerms: true, termsVersion: PARTNER_TERMS.version }) => p.call('POST', '/me/partner', body);
async function partnerOf(p: P) {
  const r = await join(p);
  expect(r.statusCode, r.body).toBe(200);
  return r.json().partner as { id?: string; code: string; link: string; status: string; percent: number; stats: any; payout: any };
}
const affRow = async (code: string) => (await sql`select * from affiliates where code = ${code}`)[0];
const referral = async (userId: string) => (await sql`select r.source, a.code from affiliate_referrals r join affiliates a on a.id = r.affiliate_id where r.user_id = ${userId}`)[0] ?? null;
let k = 0;
const charge = (userId: string, net = 50_000, currency = 'INR') => accrueCommission({
  provider: 'razorpay', eventKey: `rzp:pay:psu${R}${++k}`, userId, product: 'tablamigo_plus_monthly', grossMinor: net, feeMinor: 0, netMinor: net,
  currency, amountSource: 'razorpay_payment', occurredAt: new Date(),
});
let admin: P;

async function cleanup() {
  const users = sql`select id from users where email like ${'%' + D}`;
  const affs = sql`select id from affiliates where user_id in (${users}) or email like ${'%' + D}`;
  await sql`delete from affiliate_commissions where affiliate_id in (${affs}) or user_id in (${users})`;
  await sql`delete from affiliate_referrals where affiliate_id in (${affs}) or user_id in (${users})`;
  await sql`delete from affiliate_payout_details where affiliate_id in (${affs})`;
  await sql`delete from affiliates where id in (${affs})`;
  await sql`delete from users where email like ${'%' + D}`;
}

beforeAll(async () => {
  app = await build();
  await cleanup();
  setMailTransport(async () => ({ id: 're_test' }));
  admin = await signUp('admin');
});
afterAll(async () => { await cleanup(); setMailTransport(null); await app.close(); await sql.end(); });

describe('becoming a partner', () => {
  it('signed out: 401', async () => {
    expect((await app.inject({ method: 'GET', url: '/me/partner' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/me/partner', payload: { acceptTerms: true, termsVersion: PARTNER_TERMS.version } })).statusCode).toBe(401);
  });

  it('before joining, GET says not a partner and returns the terms to accept', async () => {
    const p = await signUp();
    const r = await p.call('GET', '/me/partner');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ partner: null, terms: { version: PARTNER_TERMS.version, percent: 30 } });
  });

  it('one step: accepting the terms makes an active 30% partner with a fresh code and link, linked to the account', async () => {
    const p = await signUp();
    await sql`update users set name = 'Asha Rao' where id = ${p.id}`;
    const r = await join(p);
    expect(r.statusCode, r.body).toBe(200);
    const { partner, created } = r.json();
    expect(created).toBe(true);
    expect(partner.code).toMatch(/^[A-Z0-9]{8}$/);
    expect(partner.link).toBe(`https://tablamigo.hookstep.in/?ref=${partner.code}`);
    expect(partner).toMatchObject({ status: 'active', percent: 30, payout: null, stats: { signups: 0, paying: 0, earned: [], owed: [], paid: [] } });
    const row = await affRow(partner.code);
    expect(row).toMatchObject({ userId: p.id, status: 'active', source: 'self', name: 'Asha Rao', email: p.email, commissionMonths: null, razorpayOfferId: null, termsVersion: PARTNER_TERMS.version });
    expect(Number(row.commissionPercent)).toBe(30);
    expect(row.termsAcceptedAt).toBeTruthy();
    // And GET shows it from now on.
    expect((await p.call('GET', '/me/partner')).json().partner.code).toBe(partner.code);
  });

  it('without accepting the terms, or with terms that changed since the page loaded: refused, nothing made', async () => {
    const p = await signUp();
    for (const body of [{}, { acceptTerms: false, termsVersion: PARTNER_TERMS.version }, { acceptTerms: 'yes', termsVersion: PARTNER_TERMS.version }]) {
      const r = await join(p, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    const stale = await join(p, { acceptTerms: true, termsVersion: '2020-01-01' });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('terms_changed');
    expect((await sql`select 1 from affiliates where user_id = ${p.id}`).length).toBe(0);
  });

  it('a member cannot choose their own percent, duration, code or status', async () => {
    const p = await signUp();
    for (const extra of [{ percent: 40 }, { commissionPercent: 50 }, { months: 120 }, { code: 'MYCODE', status: 'active' }, { razorpayOfferId: 'offer_abcdef' }]) {
      const r = await join(p, { acceptTerms: true, termsVersion: PARTNER_TERMS.version, ...extra });
      expect(r.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect((await sql`select 1 from affiliates where user_id = ${p.id}`).length).toBe(0);
  });

  it('joining twice returns the same partner (a double tap), never a second code', async () => {
    const p = await signUp();
    const a = await partnerOf(p);
    const r = await join(p);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ created: false, partner: { code: a.code } });
    expect((await sql`select count(*)::int as n from affiliates where user_id = ${p.id}`)[0].n).toBe(1);
  });

  it('a race of sign-ups for one member makes one partner', async () => {
    const p = await signUp();
    const rs = await Promise.all(Array.from({ length: 4 }, () => join(p)));
    expect(rs.map(r => r.statusCode)).toEqual([200, 200, 200, 200]);
    expect(new Set(rs.map(r => r.json().partner.code)).size).toBe(1);
    expect(rs.filter(r => r.json().created).length).toBe(1);
    expect((await sql`select count(*)::int as n from affiliates where user_id = ${p.id}`)[0].n).toBe(1);
  });

  it('a member an admin already made a partner gets that partner back, at its own terms', async () => {
    const p = await signUp();
    const code = `PSUA${R.toUpperCase()}`.slice(0, 16);
    const made = await admin.call('POST', '/admin/affiliates', { code, name: 'Admin made', userEmail: p.email, percent: 40 });
    expect(made.statusCode, made.body).toBe(200);
    const r = await join(p);
    expect(r.json()).toMatchObject({ created: false, partner: { code, percent: 40 } });
  });

  it('a new code never takes an existing partner code or a member\'s invite code', async () => {
    const { createSelfPartner } = await import('../../lib/partner-signup.js');
    const p = await signUp(), q = await signUp();
    const taken = await partnerOf(q);
    await sql`update users set referral_code = 'INVITE22' where id = ${q.id}`;
    // A random source that first gives the two taken codes, then a free one.
    const queue = [taken.code, 'INVITE22', 'FREEC0DE'.replace('0', '9')];
    const res = await createSelfPartner(p.id, PARTNER_TERMS.version, () => queue.shift()!);
    expect(res.partner.code).toBe('FREEC9DE');
  });

  it('banned: refused. Snoozed (hidden from the map): allowed, and the link shows nothing of the person', async () => {
    const b = await signUp();
    await sql`update users set banned_at = now() where id = ${b.id}`;
    expect((await join(b)).statusCode).toBe(403);
    expect((await sql`select 1 from affiliates where user_id = ${b.id}`).length).toBe(0);
    const s = await signUp();
    await sql`update users set snoozed_until = 'infinity' where id = ${s.id}`;
    const sp = await partnerOf(s);
    expect(sp.link).toBe(`https://tablamigo.hookstep.in/?ref=${sp.code}`);
  });

  it('sign-ups are rate-limited per address', async () => {
    // Six members (each signed in from their own address) joining from one address.
    const ip = nextIp();
    const people = [] as P[];
    for (let i = 0; i < 6; i++) people.push(await signUp());
    const codes = [] as number[];
    for (const p of people) codes.push((await app.inject({ method: 'POST', url: '/me/partner', payload: { acceptTerms: true, termsVersion: PARTNER_TERMS.version },
      headers: { authorization: `Bearer ${p.token}` }, remoteAddress: ip })).statusCode);
    expect(codes.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(codes[5]).toBe(429);
    expect((await sql`select 1 from affiliates where user_id = ${people[5].id}`).length).toBe(0);
  });
});

describe('attribution and commissions for a self-signed-up code', () => {
  it('a new account from the partner\'s link, the Play install referrer, a typed code or a coupon is theirs', async () => {
    const p = await signUp();
    const { code } = await partnerOf(p);
    const web = await signUp(fresh(), { ref_code: code.toLowerCase() });
    expect(await referral(web.id)).toEqual({ source: 'web_link', code });
    const play = await signUp(fresh(), { install_referrer: `utm_source=affiliate&utm_medium=partner&utm_campaign=${code}&ref=${code}` });
    expect(await referral(play.id)).toEqual({ source: 'play_install_referrer', code });
    const typed = await signUp();
    const r = await typed.call('POST', '/me/referral/redeem', { code });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().partner).toBe(true);
    expect(await referral(typed.id)).toEqual({ source: 'signup_code', code });
    const buyer = await signUp();
    expect(await couponAffiliate(code, buyer.id)).toEqual({ code, offerId: null });
    expect(await attributeReferral(buyer.id, code, 'coupon', null)).toBe('attributed');
  });

  it('commissions accrue at 30% and show in the partner\'s stats, per currency, with no customer names', async () => {
    const p = await signUp();
    const { code } = await partnerOf(p);
    const a = await signUp(fresh(), { ref_code: code }), b = await signUp(fresh(), { ref_code: code });
    await signUp(fresh(), { ref_code: code });
    expect(await charge(a.id, 50_000)).toBe('recorded');
    expect(await charge(a.id, 50_000)).toBe('recorded');
    expect(await charge(b.id, 1_000, 'USD')).toBe('recorded');
    const r = (await p.call('GET', '/me/partner')).json().partner;
    expect(r.stats).toEqual({
      signups: 3, paying: 2,
      earned: [{ currency: 'INR', amountMinor: 30_000 }, { currency: 'USD', amountMinor: 300 }],
      owed: [{ currency: 'INR', amountMinor: 30_000 }, { currency: 'USD', amountMinor: 300 }],
      paid: [],
    });
    expect(JSON.stringify(r)).not.toContain(a.email);
    expect(JSON.stringify(r)).not.toContain(a.id);
  });

  it('a partner never earns on their own purchases', async () => {
    const p = await signUp();
    const { code } = await partnerOf(p);
    // Their own link or code: refused.
    const own = await p.call('POST', '/me/referral/redeem', { code });
    expect(own.statusCode).toBe(400);
    expect(own.json().error).toBe('cannot_refer_self');
    expect(await attributeReferral(p.id, code, 'coupon', null)).toBe('self_referral');
    await expect(couponAffiliate(code, p.id)).rejects.toMatchObject({ code: 'invalid_coupon' });
    // Even a referral row written some other way earns nothing.
    const aff = await affRow(code);
    await sql`insert into affiliate_referrals (user_id, affiliate_id, source) values (${p.id}, ${aff.id}, 'web_link')`;
    expect(await charge(p.id)).toBe('self_referral');
    expect((await sql`select 1 from affiliate_commissions where affiliate_id = ${aff.id}`).length).toBe(0);
  });

  it('paused or ended by the admin: no new referrals, no commissions, and joining again does not reactivate', async () => {
    const p = await signUp();
    const { code } = await partnerOf(p);
    const aff = await affRow(code);
    const before = await signUp(fresh(), { ref_code: code });
    for (const status of ['paused', 'ended']) {
      const r = await admin.call('PATCH', `/admin/affiliates/${aff.id}`, { status });
      expect(r.statusCode, r.body).toBe(200);
      expect(await charge(before.id)).toBe('inactive');
      const late = await signUp(fresh(), { ref_code: code });
      expect(await referral(late.id)).toBeNull();
      const again = await join(p);
      expect(again.json()).toMatchObject({ created: false, partner: { code, status } });
      expect((await affRow(code)).status).toBe(status);
    }
    expect((await sql`select 1 from affiliate_commissions where affiliate_id = ${aff.id}`).length).toBe(0);
  });

  it('a self-signed-up partner banned or deleted later: no new referrals and no commissions', async () => {
    for (const how of ['banned', 'deleted']) {
      const p = await signUp();
      const { code } = await partnerOf(p);
      const before = await signUp(fresh(), { ref_code: code });
      await sql`update users set ${sql(how === 'banned' ? 'banned_at' : 'deleted_at')} = now() where id = ${p.id}`;
      expect(await charge(before.id), how).toBe('inactive');
      const late = await signUp(fresh(), { ref_code: code });
      expect(await referral(late.id), how).toBeNull();
    }
  });

  it('a member\'s friend-invite code is never made equal to a partner code', async () => {
    const { ensureInviteCode } = await import('../../lib/referral.js');
    const p = await signUp(), q = await signUp();
    const { code } = await partnerOf(p);
    const queue = [code, 'INV2NEW9'];
    expect(await ensureInviteCode(q.id, () => queue.shift()!)).toBe('INV2NEW9');
    expect((await sql`select referral_code from users where id = ${q.id}`)[0].referralCode).toBe('INV2NEW9');
  });

  it('a referral loop is refused: B came through A, so B\'s code can\'t make A B\'s referral', async () => {
    const a = await signUp();
    const { code: codeA } = await partnerOf(a);
    const b = await signUp(fresh(), { ref_code: codeA });
    expect(await referral(b.id)).toMatchObject({ code: codeA });
    const { code: codeB } = await partnerOf(b);
    const typed = await a.call('POST', '/me/referral/redeem', { code: codeB });
    expect(typed.statusCode).toBe(400);
    expect(typed.json().error).toBe('referral_loop');
    expect(await attributeReferral(a.id, codeB, 'coupon', null)).toBe('referral_loop');
    await expect(couponAffiliate(codeB, a.id)).rejects.toMatchObject({ code: 'invalid_coupon' });
    expect(await referral(a.id)).toBeNull();
  });
});

describe('payout details', () => {
  it('not a partner yet: 404', async () => {
    const p = await signUp();
    expect((await p.call('PUT', '/me/partner/payout', { method: 'upi', upiId: 'asha@okaxis' })).statusCode).toBe(404);
  });

  it('UPI or bank, stored encrypted, shown masked to the partner and in full only to the admin', async () => {
    const p = await signUp();
    const { code } = await partnerOf(p);
    const aff = await affRow(code);
    const r = await p.call('PUT', '/me/partner/payout', { method: 'upi', upiId: 'asha.rao@okaxis' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().payout).toMatchObject({ method: 'upi', masked: 'as' + '•'.repeat(5) + 'o@okaxis' });
    const raw = (await sql`select * from affiliate_payout_details where affiliate_id = ${aff.id}`)[0];
    expect(JSON.stringify(raw)).not.toContain('asha.rao');
    const mine = (await p.call('GET', '/me/partner')).json().partner;
    expect(mine.payout.masked).toBe('as' + '•'.repeat(5) + 'o@okaxis');
    expect(JSON.stringify(mine)).not.toContain('asha.rao');
    // Changed to a bank account.
    const bank = await p.call('PUT', '/me/partner/payout', { method: 'bank', accountName: 'Asha Rao', accountNumber: '50100123456789', ifsc: 'HDFC0001234' });
    expect(bank.statusCode, bank.body).toBe(200);
    expect(bank.json().payout.masked).toBe('Bank ••••6789 (HDFC0001234)');
    const d = (await admin.call('GET', `/admin/affiliates/${aff.id}`)).json().affiliate;
    expect(d).toMatchObject({ source: 'self', payout: { method: 'bank', masked: 'Bank ••••6789 (HDFC0001234)', details: { accountName: 'Asha Rao', accountNumber: '50100123456789', ifsc: 'HDFC0001234' } } });
    // The overview (a list) shows the masked form only.
    const list = (await admin.call('GET', '/admin/affiliates')).json().affiliates.find((x: any) => x.id === aff.id);
    expect(list).toMatchObject({ source: 'self', payout: { masked: 'Bank ••••6789 (HDFC0001234)' } });
    expect(JSON.stringify(list)).not.toContain('50100123456789');
  });

  it('injection and junk are refused, and nothing is stored', async () => {
    const p = await signUp();
    const { code } = await partnerOf(p);
    const aff = await affRow(code);
    for (const body of [
      { method: 'upi', upiId: "x' or '1'='1@okaxis" },
      { method: 'upi', upiId: '<script>alert(1)</script>@ybl' },
      { method: 'bank', accountName: "Robert'); drop table affiliates;--", accountNumber: '123456789012', ifsc: 'HDFC0001234' },
      { method: 'bank', accountName: 'Asha', accountNumber: '1234', ifsc: 'HDFC0001234' },
      { method: 'upi', upiId: 'asha@okaxis', extra: 1 },
      { method: 'upi' },
    ]) {
      const r = await p.call('PUT', '/me/partner/payout', body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect((await sql`select 1 from affiliate_payout_details where affiliate_id = ${aff.id}`).length).toBe(0);
    expect((await sql`select to_regclass('affiliates') is not null as ok`)[0].ok).toBe(true);
  });

  it('a partner sees only their own partner, and names with markup stay as text', async () => {
    const p = await signUp(), q = await signUp();
    await sql`update users set name = ${'<img src=x onerror=alert(1)>'} where id = ${p.id}`;
    const mine = await partnerOf(p);
    const theirs = await partnerOf(q);
    expect(mine.code).not.toBe(theirs.code);
    expect((await affRow(mine.code)).name).toBe('<img src=x onerror=alert(1)>');
    // There is no way to ask for another partner's stats.
    expect((await q.call('GET', `/me/partner?code=${mine.code}`)).json().partner.code).toBe(theirs.code);
  });
});

describe('admin', () => {
  it('sees self sign-ups in the list, and can pause one', async () => {
    const p = await signUp();
    const { code } = await partnerOf(p);
    const list = (await admin.call('GET', '/admin/affiliates')).json().affiliates;
    const a = list.find((x: any) => x.code === code);
    expect(a).toMatchObject({ source: 'self', status: 'active', percent: 30, userId: p.id });
    expect(a.termsAcceptedAt).toBeTruthy();
    const r = await admin.call('PATCH', `/admin/affiliates/${a.id}`, { status: 'paused' });
    expect(r.json().affiliate.status).toBe('paused');
    expect((await p.call('GET', '/me/partner')).json().partner.status).toBe('paused');
  });

  it('a member is not an admin', async () => {
    const p = await signUp();
    expect((await p.call('GET', '/admin/affiliates')).statusCode).toBe(403);
  });
});
