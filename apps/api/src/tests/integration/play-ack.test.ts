// The Google Play acknowledgement safety net (lib/play-ack.ts, migration 070) through the real verify route and the scheduler
// job, against a fake Play Developer API behind google-auth-library and a mail recorder. Nothing leaves the machine.
// Proven: a purchase Google reports unacknowledged is tracked until it is acknowledged; an in-line failure no longer vanishes
// (the customer still gets Plus, the row says pending with the error); the job retries only once due, with backoff; Google's
// own state wins (already acknowledged, refunded, unknown token, payment still pending); the owner gets exactly one email once
// the purchase is a day old and still failing, and one more when it is finally acknowledged; no purchase token in any email or
// error column; with no Play credentials the job does nothing.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const D = '@pack.tablamigo';
process.env.REVIEW_EMAILS = ['ana', 'bo', 'cy'].map(n => n + D).join(',');
process.env.REVIEW_CODE = '424242';
const OWNER = 'owner-pack@owner.example';
const saFile = path.join(os.tmpdir(), `tablamigo-pack-sa-${process.pid}.json`);
fs.writeFileSync(saFile, '{}');
process.env.PLAY_SERVICE_ACCOUNT_JSON = saFile;

// ---- Google Play Developer API (fake) ------------------------------------------------------------------------------------
const play = vi.hoisted(() => {
  const subs = new Map<string, any>(), passes = new Map<string, any>();
  /** token -> how many more acknowledge/consume calls fail with a 500; Infinity = until healed. */
  const failAck = new Map<string, number>();
  const calls: string[] = [];
  const status = (s: number, m: string) => Object.assign(new Error(`Request failed with status code ${s} for https://androidpublisher.googleapis.com/x/${m}`), { response: { status: s, data: { error: { message: m } } } });
  const request = async (o: { url: string; method?: string }) => {
    const u = o.url.replace(/^.*\/applications\/[^/]+\//, '');
    calls.push(`${o.method ?? 'GET'} ${u}`);
    let m = u.match(/^purchases\/subscriptions\/[^/]+\/tokens\/(.+):acknowledge$/) ?? u.match(/^purchases\/products\/tablamigo_trip_pass\/tokens\/(.+):consume$/);
    if (m) {
      const t = decodeURIComponent(m[1]);
      const left = failAck.get(t) ?? 0;
      if (left > 0) { failAck.set(t, left - 1); throw status(500, `backend error for ${t}`); }
      if (subs.has(t)) subs.get(t).acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
      if (passes.has(t)) Object.assign(passes.get(t), { consumptionState: 1, acknowledgementState: 1 });
      return { data: {} };
    }
    m = u.match(/^purchases\/subscriptionsv2\/tokens\/(.+)$/);
    if (m) { const s = subs.get(decodeURIComponent(m[1])); if (!s) throw status(404, 'not found'); return { data: structuredClone(s) }; }
    m = u.match(/^purchases\/products\/tablamigo_trip_pass\/tokens\/(.+)$/);
    if (m) { const p = passes.get(decodeURIComponent(m[1])); if (!p) throw status(404, 'not found'); return { data: { ...p } }; }
    if (/^orders\//.test(u)) throw status(404, 'not found');
    throw new Error(`play: unexpected ${o.method ?? 'GET'} ${o.url}`);
  };
  return { subs, passes, failAck, calls, request };
});
vi.mock('google-auth-library', async importOriginal => ({
  ...(await importOriginal<typeof import('google-auth-library')>()),
  GoogleAuth: class { async getClient() { return { request: play.request }; } },
}));

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { setMailTransport } = await import('../../lib/mail.js');
const { processPlayAcks, ACK_RETRY_MS, tokenRef, playAcksSettled } = await import('../../lib/play-ack.js');
const { runSchedulerTick } = await import('../../lib/scheduler.js');
type Person = import('../helpers.js').Person;
const { signIn, onboard } = await import('../helpers.js');

const H = 3_600_000;
const R = crypto.randomBytes(4).toString('hex');
let app: Awaited<ReturnType<typeof build>>;
let ana: Person, bo: Person, cy: Person;
const mails: { to: string; subject: string; text: string; html: string }[] = [];
let mailDown = false;
const ownerMails = () => mails.filter(m => m.to === OWNER);
let n = 0;
const tok = (what: string) => `pack-${what}-${R}-${++n}-${'x'.repeat(24)}`;
const sub = (over: Record<string, unknown> = {}) => ({
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', startTime: new Date().toISOString(),
  lineItems: [{ productId: 'tablamigo_plus', expiryTime: new Date(Date.now() + 30 * 86400_000).toISOString(), offerDetails: { basePlanId: 'monthly' } }], ...over,
});
// The acknowledge runs after the answer (acknowledgeInBackground); wait for it so the row says how it went.
const verify = async (p: Person, productId: string, purchaseToken: string) => { const r = await p.call('POST', '/billing/google/verify', { productId, purchaseToken }); await playAcksSettled(); return r; };
const row = async (token: string, table: 'subscriptions' | 'passes' = 'subscriptions') =>
  (await sql`select ack_state, ack_since, ack_attempts, ack_next_at, ack_error, acknowledged_at, ack_alerted_at from ${sql(table)} where purchase_token = ${token}`)[0];
const ackCalls = (token: string) => play.calls.filter(c => c.startsWith('POST') && c.includes(token)).length;
/** Make a tracked purchase look `hours` old (Google's clock starts at the purchase). */
const age = (token: string, hours: number, table: 'subscriptions' | 'passes' = 'subscriptions') =>
  sql`update ${sql(table)} set ack_since = now() - ${hours * 3600 + ' seconds'}::interval, ack_next_at = null where purchase_token = ${token}`;
const at = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * H);

beforeAll(async () => {
  ACK_RETRY_MS.splice(0, ACK_RETRY_MS.length, 5, 5);
  config.ownerSalesAlerts = { valid: [OWNER], invalid: 0 };
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  setMailTransport(async m => {
    if (mailDown) throw new Error('resend 503: service unavailable');
    mails.push({ to: m.to, subject: m.subject, text: m.text, html: m.html });
    return { id: 'rec' };
  });
  ana = await onboard(await signIn(app, `ana${D}`, '424242', 71), { name: 'Ana Pack', gender: 'woman' });
  bo = await onboard(await signIn(app, `bo${D}`, '424242', 71), { name: 'Bo Pack', gender: 'man' });
  cy = await onboard(await signIn(app, `cy${D}`, '424242', 71), { name: 'Cy Pack', gender: 'nonbinary' });
});

afterAll(async () => {
  setMailTransport(null);
  config.ownerSalesAlerts = { valid: [], invalid: 0 };
  await sql`delete from users where email like ${'%' + D}`;
  await app.close(); await sql.end(); fs.rmSync(saFile, { force: true });
});

describe('in-line acknowledge on verify', () => {
  it('acknowledges a new subscription and records it', async () => {
    const t = tok('ok'); play.subs.set(t, sub());
    const r = await verify(ana, 'tablamigo_plus', t);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().active).toBe(true);
    expect(await row(t)).toMatchObject({ ackState: 'acknowledged', ackAttempts: 0, ackError: null });
    expect((await row(t)).acknowledgedAt).toBeInstanceOf(Date);
    expect(ackCalls(t)).toBe(1);
  });

  it('a failing acknowledge is retried in-line, then left pending with the error: Plus still applies, the call still succeeds', async () => {
    const t = tok('fail'); play.subs.set(t, sub()); play.failAck.set(t, Infinity);
    const r = await verify(bo, 'tablamigo_plus', t);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().active).toBe(true);
    expect((await bo.call('GET', '/billing/me')).json().plus).toBe(true);
    const x = await row(t);
    expect(x).toMatchObject({ ackState: 'pending', ackAttempts: 1, ackAlertedAt: null });
    expect(x.ackError).toMatch(/^500: backend error for/);
    expect(x.ackError).not.toContain(t);                       // never the token
    expect(ackCalls(t)).toBe(3);                               // 1 + ACK_RETRY_MS.length
    expect(x.ackNextAt.getTime()).toBeGreaterThan(Date.now() + 0.9 * H);   // the safety net waits the grace period
    play.failAck.delete(t);
    await sql`update subscriptions set ack_state = null where purchase_token = ${t}`;   // out of the way of the job tests
  });

  it('one failure then success in-line: acknowledged, nothing left for the job', async () => {
    const t = tok('flaky'); play.subs.set(t, sub()); play.failAck.set(t, 1);
    await verify(cy, 'tablamigo_plus', t);
    expect(await row(t)).toMatchObject({ ackState: 'acknowledged', ackAttempts: 0 });
    expect(ackCalls(t)).toBe(2);
  });

  it('a subscription Google already reports acknowledged is not acknowledged again', async () => {
    const t = tok('already'); play.subs.set(t, sub({ acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' }));
    await verify(cy, 'tablamigo_plus', t);
    expect((await row(t)).ackState).toBe(null);
    expect(ackCalls(t)).toBe(0);
  });

  it('a payment still pending is not acknowledged or tracked yet (Google does not allow it)', async () => {
    const t = tok('unpaid'); play.subs.set(t, sub({ subscriptionState: 'SUBSCRIPTION_STATE_PENDING' }));
    await verify(cy, 'tablamigo_plus', t);
    expect((await row(t)).ackState).toBe(null);
    expect(ackCalls(t)).toBe(0);
  });

  it('a Trip Pass whose consume fails is tracked the same way, and the pass is still granted', async () => {
    const t = tok('pass'); play.passes.set(t, { purchaseState: 0, consumptionState: 0, acknowledgementState: 0, orderId: `GPA.pack-${R}`, purchaseTimeMillis: String(Date.now()) });
    play.failAck.set(t, Infinity);
    const r = await verify(cy, 'tablamigo_trip_pass', t);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().active).toBe(true);
    expect(await row(t, 'passes')).toMatchObject({ ackState: 'pending', ackAttempts: 1 });
    play.failAck.delete(t);
    // The safety net consumes it once due.
    await processPlayAcks(at(2));
    expect(await row(t, 'passes')).toMatchObject({ ackState: 'acknowledged' });
    expect(play.passes.get(t).consumptionState).toBe(1);
  });
});

describe('the safety net job', () => {
  it('does nothing before the grace period, then acknowledges once due', async () => {
    const t = tok('net'); play.subs.set(t, sub()); play.failAck.set(t, 3);   // the 3 in-line tries fail
    await verify(ana, 'tablamigo_plus', t);
    expect((await row(t)).ackState).toBe('pending');
    await processPlayAcks(new Date(Date.now() + 10 * 60_000));
    expect(ackCalls(t)).toBe(3);                               // not due yet: Google not called
    await processPlayAcks(at(1.1));
    expect(await row(t)).toMatchObject({ ackState: 'acknowledged', ackAttempts: 1 });
    expect(ackCalls(t)).toBe(4);
    expect(ownerMails().filter(m => m.text.includes(tokenRef(t)))).toEqual([]);   // fixed before a day: no email
  });

  it('picks up a purchase whose process died before the acknowledge (pending, never tried)', async () => {
    const t = tok('crash'); play.subs.set(t, sub());
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, expires_at, raw, ack_state, ack_since)
      values (${t}, ${ana.id}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', ${at(720)}, ${sql.json(sub())}, 'pending', now() - interval '2 hours')`;
    await processPlayAcks(new Date());
    expect((await row(t)).ackState).toBe('acknowledged');
  });

  it('keeps failing: retries with backoff, emails the owner once at a day old, then once more when it is finally acknowledged', async () => {
    const t = tok('stuck'); play.subs.set(t, sub()); play.failAck.set(t, Infinity);
    await verify(bo, 'tablamigo_plus', t);
    await age(t, 2);                                           // bought 2 h ago, due now
    const before = ackCalls(t);
    await processPlayAcks(new Date());
    let x = await row(t);
    expect(x).toMatchObject({ ackState: 'pending', ackAttempts: 2, ackAlertedAt: null });
    expect(ackCalls(t)).toBe(before + 1);
    expect(x.ackNextAt.getTime() - Date.now()).toBeGreaterThan(1.9 * H);    // second safety-net failure: 2 h
    await processPlayAcks(at(1));                              // not due again yet
    expect(ackCalls(t)).toBe(before + 1);
    await processPlayAcks(at(2.1));
    expect((await row(t)).ackAttempts).toBe(3);
    expect(ownerMails().filter(m => m.text.includes(tokenRef(t)))).toEqual([]);   // under a day old: no email yet

    await age(t, 25);                                          // a day old and still failing
    await processPlayAcks(new Date());
    x = await row(t);
    expect(x.ackAlertedAt).toBeInstanceOf(Date);
    let mine = ownerMails().filter(m => m.text.includes(tokenRef(t)));
    expect(mine).toHaveLength(1);
    expect(mine[0].subject).toMatch(/^Google Play purchase not acknowledged after 25 h, Google refunds it \d+ \w+ 2026, \d\d:\d\d IST$/);
    expect(mine[0].text).toContain('Customer: Bo Pack (bo@pack.tablamigo)');
    expect(mine[0].text).toContain('Last error: 500: backend error');
    expect(mine[0].text).toContain(`/admin#users?q=${bo.id}`);
    expect(mine[0].html).toContain('icon-192.png');   // the shared owner template (renderOwnerNotice), not a bare table
    expect(mine[0].html).toContain('Purchase not acknowledged');
    expect(mine[0].text).toContain('Mode: Live');
    expect(mine[0].subject).not.toMatch(/\[TEST\]|Test mode/);
    for (const m of mails) { expect(m.text).not.toContain(t); expect(m.html).not.toContain(t); expect(m.subject).not.toContain(t); }
    expect(mails.filter(m => m.text.includes(tokenRef(t))).every(m => m.to === OWNER)).toBe(true);   // the customer gets none

    await sql`update subscriptions set ack_next_at = null where purchase_token = ${t}`;
    await processPlayAcks(new Date());                         // fails again: no second email
    expect(ownerMails().filter(m => m.text.includes(tokenRef(t)))).toHaveLength(1);

    play.failAck.delete(t);
    await sql`update subscriptions set ack_next_at = null where purchase_token = ${t}`;
    await processPlayAcks(new Date());
    expect((await row(t)).ackState).toBe('acknowledged');
    mine = ownerMails().filter(m => m.text.includes(tokenRef(t)));
    expect(mine.map(m => m.subject)).toEqual([mine[0].subject, 'Google Play purchase now acknowledged']);
  });

  it('when the email provider is down, the alert is tried again on the next failing run', async () => {
    const t = tok('maildown'); play.subs.set(t, sub()); play.failAck.set(t, Infinity);
    await verify(cy, 'tablamigo_plus', t);
    await age(t, 30);
    mailDown = true;
    await processPlayAcks(new Date());
    expect((await row(t)).ackAlertedAt).toBe(null);
    mailDown = false;
    await sql`update subscriptions set ack_next_at = null where purchase_token = ${t}`;
    await processPlayAcks(new Date());
    expect((await row(t)).ackAlertedAt).toBeInstanceOf(Date);
    expect(ownerMails().filter(m => m.text.includes(tokenRef(t)))).toHaveLength(1);
    play.failAck.delete(t);
    await sql`update subscriptions set ack_state = null where purchase_token = ${t}`;
  });

  it("Google's state wins: acknowledged elsewhere, refunded, unknown token, payment pending", async () => {
    const [acked, refunded, unknown, unpaid] = ['acked', 'refunded', 'unknown', 'unpaid2'].map(tok);
    for (const t of [acked, refunded, unknown, unpaid]) {
      play.subs.set(t, sub());
      await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, raw, ack_state, ack_since)
        values (${t}, ${cy.id}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', ${sql.json({})}, 'pending', now() - interval '30 hours')`;
    }
    play.subs.get(acked).acknowledgementState = 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED';
    play.subs.get(refunded).subscriptionState = 'SUBSCRIPTION_STATE_EXPIRED';
    play.subs.delete(unknown);
    play.subs.get(unpaid).subscriptionState = 'SUBSCRIPTION_STATE_PENDING';
    await processPlayAcks(new Date());
    expect((await row(acked)).ackState).toBe('acknowledged');
    expect((await row(refunded)).ackState).toBe('gone');
    expect((await row(unknown)).ackState).toBe('gone');
    expect(await row(unpaid)).toMatchObject({ ackState: 'pending', ackAttempts: 0 });
    for (const t of [acked, refunded, unknown, unpaid]) expect(ackCalls(t)).toBe(0);
    for (const t of [acked, refunded, unknown, unpaid]) expect(ownerMails().filter(m => m.text.includes(tokenRef(t)))).toEqual([]);
    await sql`update subscriptions set ack_state = null where purchase_token = ${unpaid}`;
  });

  it('Razorpay passes and subscriptions are never sent to Google', async () => {
    const t = `rzp:pay_pack${R}`;
    await sql`insert into passes (purchase_token, user_id, product_id, expires_at, ack_state, ack_since) values (${t}, ${cy.id}, 'tablamigo_trip_pass', ${at(300)}, 'pending', now() - interval '30 hours')`;
    const st = `rzp:sub_pack${R}`;
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, ack_state, ack_since) values (${st}, ${cy.id}, 'razorpay', 'tablamigo_plus', 'active', 'pending', now() - interval '30 hours')`;
    await processPlayAcks(new Date());
    expect(play.calls.filter(c => c.includes(`pay_pack${R}`) || c.includes(`sub_pack${R}`))).toEqual([]);
    expect((await row(t, 'passes')).ackState).toBe('pending');
    await sql`delete from passes where purchase_token = ${t}`;
    await sql`delete from subscriptions where purchase_token = ${st}`;
  });

  it('runs from the scheduler tick, and does nothing without Play credentials', async () => {
    const t = tok('tick'); play.subs.set(t, sub());
    await sql`insert into subscriptions (purchase_token, user_id, platform, product_id, status, raw, ack_state, ack_since)
      values (${t}, ${ana.id}, 'google', 'tablamigo_plus', 'SUBSCRIPTION_STATE_ACTIVE', ${sql.json({})}, 'pending', now() - interval '3 hours')`;
    const saved = config.playServiceAccount;
    config.playServiceAccount = '';
    try {
      expect(await processPlayAcks(new Date())).toMatchObject({ checked: 0, skipped: 'play_not_configured' });
      expect((await row(t)).ackState).toBe('pending');
    } finally { config.playServiceAccount = saved; }
    // Other test files tick the same database, and a tick only runs when it gets the scheduler's advisory lock: retry while they hold it.
    let r: Awaited<ReturnType<typeof runSchedulerTick>> = { ran: false };
    for (let i = 0; i < 50 && !r.ran; i++) {
      if (i) await new Promise(res => setTimeout(res, 100));
      r = await runSchedulerTick(new Date(), { processPlanReminders: async () => ({ reminded2h: 0, reminded15m: 0 }), processDueRecurring: async () => ({ processed: 0, items: [] }) }, { day: new Date().toISOString().slice(0, 10) });
    }
    expect(r).toMatchObject({ ran: true });
    if (r.ran) expect(r.playAcks).toMatchObject({ acknowledged: expect.any(Number) });
    expect((await row(t)).ackState).toBe('acknowledged');
  });
});
