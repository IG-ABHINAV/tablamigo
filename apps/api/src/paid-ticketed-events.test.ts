// Paid event tickets. Off by default (config.features.paidEvents); when on, a ticket needs a Razorpay payment the
// server has verified against an order made for that user and plan. Razorpay is a fake: fetch is stubbed.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'node:crypto';

const PEOPLE = ['tkt_host', 'tkt_buyer', 'tkt_buyer2', 'tkt_buyer3', 'tkt_man'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@tkt.tablamigo`).join(',');
process.env.REVIEW_CODE = '777777';
process.env.RAZORPAY_KEY_ID = 'rzp_test_tkt';
process.env.RAZORPAY_KEY_SECRET = 'tkt-secret';

const rz = { orders: new Map<string, any>(), payments: new Map<string, any>(), captures: [] as string[], n: 0 };
vi.stubGlobal('fetch', vi.fn(async (url: string, init: any = {}) => {
  const u = new URL(url);
  // Plan creation reverse-geocodes; answer like Nominatim with no address.
  if (u.host === 'nominatim.openstreetmap.org') return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.host !== 'api.razorpay.com') throw new Error(`unexpected fetch ${url}`);
  const method = init.method ?? 'GET', body = init.body ? JSON.parse(init.body) : {};
  const [, , kind, id, action] = u.pathname.split('/');
  const json = (o: any, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (method === 'POST' && kind === 'orders' && !id) {
    const o = { id: `order_t${++rz.n}`, entity: 'order', status: 'created', amount: body.amount, currency: body.currency, notes: body.notes };
    rz.orders.set(o.id, o); return json(o);
  }
  const o = (kind === 'orders' ? rz.orders : rz.payments).get(id);
  if (!o) return json({ error: { description: 'not found' } }, 400);
  if (action === 'capture') { o.status = 'captured'; rz.captures.push(id); }
  return json(o);
}));

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config } = await import('./lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;
const sign = (orderId: string, paymentId: string) => crypto.createHmac('sha256', 'tkt-secret').update(`${orderId}|${paymentId}`).digest('hex');
const pay = (id: string, orderId: string, amount: number) => rz.payments.set(id, { id, entity: 'payment', order_id: orderId, amount, currency: 'INR', status: 'authorized' });

let ip = 3400;
async function login(name: string, gender = 'woman'): Promise<Api> {
  const email = `${name}@tkt.tablamigo`;
  const remoteAddress = `10.99.14.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '777777' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` }, remoteAddress });
  await call('PATCH', '/me', { name, birthdate: '1996-05-15', gender, homeCountry: 'IN' });
  return call;
}
const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@tkt.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};
const KOCHI = { lat: 9.965, lng: 76.242 };
const soon = () => new Date(Date.now() + 48 * 3600_000).toISOString();
const paidPlan = (extra: Record<string, unknown> = {}) => ({
  title: 'Heritage Street Food Walk', category: 'food', placeName: 'Fort Kochi Clock Tower', ...KOCHI, startsAt: soon(),
  maxPeople: 15, isPaid: true, ticketPricePaise: 49900, maxTickets: 5, payoutUpiId: 'travelhost@oksbi', ...extra,
});
/** A paid plan as it would exist in the database (made while the feature was live, or with the flag on). */
async function legacyPaidPlan(hostName: string, extra: Record<string, unknown> = {}) {
  config.features.paidEvents = true;
  const r = await u[hostName]('POST', '/activities', paidPlan(extra));
  config.features.paidEvents = false;
  expect(r.statusCode).toBe(200);
  return r.json().id as string;
}
const tickets = async (activityId: string) => (await sql`select count(*)::int as n from activity_tickets where activity_id = ${activityId}`)[0].n as number;

beforeAll(async () => {
  app = await build();
  await sql`delete from activities where host_id in (select id from users where email like '%@tkt.tablamigo')`;
  await sql`delete from users where email like '%@tkt.tablamigo'`;
  u.tkt_host = await login('tkt_host');
  u.tkt_buyer = await login('tkt_buyer');
  u.tkt_buyer2 = await login('tkt_buyer2');
  u.tkt_buyer3 = await login('tkt_buyer3');
  u.tkt_man = await login('tkt_man', 'man');
  await sql`update users set plus_until = now() + interval '30 days' where email = 'tkt_host@tkt.tablamigo'`;
});

afterAll(async () => {
  config.features.paidEvents = false;
  await sql`delete from activities where host_id in (select id from users where email like '%@tkt.tablamigo')`;
  await sql`delete from users where email like '%@tkt.tablamigo'`;
  await app.close();
  vi.unstubAllGlobals();
});

describe('Paid events are switched off by default', () => {
  it('refuses to create a paid event', async () => {
    expect(config.features.paidEvents).toBe(false);
    const res = await u.tkt_host('POST', '/activities', paidPlan());
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('paid_events_unavailable');
    // Free plans are unaffected.
    expect((await u.tkt_host('POST', '/activities', { ...paidPlan(), isPaid: false })).statusCode).toBe(200);
  });

  it('exploit: no ticket is issued for an existing paid plan, whatever the request carries', async () => {
    const id = await legacyPaidPlan('tkt_host');
    // The app's own call ({ orderId } only) used to get a valid pay_mock_ ticket while live keys were loaded.
    for (const body of [{ orderId: 'order_whatever' }, { orderId: 'order_x', paymentId: 'pay_x', signature: 'sig_test_12345' }, {}]) {
      const r = await u.tkt_buyer('POST', `/activities/${id}/ticket/verify`, body);
      expect(r.statusCode).toBe(404);
      expect(r.json().error).toBe('paid_events_unavailable');
    }
    expect((await u.tkt_buyer('POST', `/activities/${id}/ticket/order`)).json().error).toBe('paid_events_unavailable');
    expect(await tickets(id)).toBe(0);
    // And the plan can't be joined around the ticket, by /join or by an RSVP.
    expect((await u.tkt_buyer('POST', `/activities/${id}/join`, { rsvp: 'going' })).json().error).toBe('ticket_required');
    expect((await u.tkt_buyer('POST', `/activities/${id}/rsvp`, { rsvp: 'maybe' })).json().error).toBe('ticket_required');
    expect((await u.tkt_buyer('GET', `/activities/${id}`)).json().joined).toBe(false);
    expect(rz.captures).toEqual([]);
  });

  it("exploit: the host's payout UPI ID is shown to the host only", async () => {
    const id = await legacyPaidPlan('tkt_host');
    expect((await u.tkt_host('GET', `/activities/${id}`)).json().payoutUpiId).toBe('travelhost@oksbi');
    const seen = (await u.tkt_buyer('GET', `/activities/${id}`)).json();
    expect(seen.payoutUpiId).toBeNull();
    const list = (await u.tkt_buyer('GET', `/activities?lat=${KOCHI.lat}&lng=${KOCHI.lng}`)).json().activities;
    expect(JSON.stringify(list)).not.toContain('travelhost@oksbi');
  });
});

describe('Paid events switched on: a ticket needs a verified Razorpay payment', () => {
  let planId: string;
  beforeAll(async () => {
    config.features.paidEvents = true;
    const r = await u.tkt_host('POST', '/activities', paidPlan({ maxTickets: 2 }));
    expect(r.statusCode).toBe(200);
    planId = r.json().id;
  });
  afterAll(() => { config.features.paidEvents = false; });

  it('exploit: no payment, no signature, or no gateway means no ticket', async () => {
    for (const body of [{ orderId: 'order_t999' }, { orderId: 'order_t999', paymentId: 'pay_x' }]) {
      const r = await u.tkt_buyer('POST', `/activities/${planId}/ticket/verify`, body);
      expect(r.statusCode).toBe(400);
      expect(r.json().error).toBe('payment_required');
    }
    const keyId = config.razorpay.keyId;
    config.razorpay.keyId = '';
    try {
      expect((await u.tkt_buyer('POST', `/activities/${planId}/ticket/order`)).json().error).toBe('payments_unavailable');
      const r = await u.tkt_buyer('POST', `/activities/${planId}/ticket/verify`, { orderId: 'o', paymentId: 'p', signature: 's' });
      expect(r.json().error).toBe('payments_unavailable');
    } finally { config.razorpay.keyId = keyId; }
    expect(await tickets(planId)).toBe(0);
  });

  it('exploit: a forged signature, or another buyer\'s or another plan\'s order, is refused before anything is captured', async () => {
    const mine = (await u.tkt_buyer('POST', `/activities/${planId}/ticket/order`)).json();
    expect(rz.orders.get(mine.orderId).notes).toEqual({ service: 'tablamigo', user_id: await idOf('tkt_buyer'), product: 'activity_ticket', activity_id: planId });
    pay('pay_forged', mine.orderId, 49900);
    const forged = await u.tkt_buyer('POST', `/activities/${planId}/ticket/verify`, { orderId: mine.orderId, paymentId: 'pay_forged', signature: sign(mine.orderId, 'pay_other') });
    expect(forged.statusCode).toBe(400);
    expect(forged.json()).toMatchObject({ error: 'payment_not_verified', reason: 'bad_signature' });

    // buyer2 replays buyer's order and payment with a valid signature: the order was made for someone else.
    const stolen = await u.tkt_buyer2('POST', `/activities/${planId}/ticket/verify`, { orderId: mine.orderId, paymentId: 'pay_forged', signature: sign(mine.orderId, 'pay_forged') });
    expect(stolen.json()).toMatchObject({ error: 'payment_not_verified', reason: 'not_our_order' });

    // An order for a cheaper plan can't buy this one.
    const cheap = (await u.tkt_host('POST', '/activities', paidPlan({ ticketPricePaise: 5000, title: 'Cheap walk' }))).json().id;
    const cheapOrder = (await u.tkt_buyer2('POST', `/activities/${cheap}/ticket/order`)).json();
    pay('pay_cheap', cheapOrder.orderId, 5000);
    const swapped = await u.tkt_buyer2('POST', `/activities/${planId}/ticket/verify`, { orderId: cheapOrder.orderId, paymentId: 'pay_cheap', signature: sign(cheapOrder.orderId, 'pay_cheap') });
    expect(swapped.json()).toMatchObject({ error: 'payment_not_verified', reason: 'not_our_order' });
    expect(rz.captures).toEqual([]);
    expect(await tickets(planId)).toBe(0);
  });

  it('issues one ticket for a verified payment, idempotently', async () => {
    const o = (await u.tkt_buyer('POST', `/activities/${planId}/ticket/order`)).json();
    pay('pay_good', o.orderId, 49900);
    const body = { orderId: o.orderId, paymentId: 'pay_good', signature: sign(o.orderId, 'pay_good') };
    const r = await u.tkt_buyer('POST', `/activities/${planId}/ticket/verify`, body);
    expect(r.statusCode).toBe(200);
    const t = r.json().ticket;
    expect(t.ticketCode).toMatch(/^TM-TKT-[A-F0-9]{6}$/);
    expect(t.pricePaise).toBe(49900);
    expect(t.hostPayoutPaise).toBe(44910);
    expect(rz.captures).toEqual(['pay_good']);
    const act = (await u.tkt_buyer('GET', `/activities/${planId}`)).json();
    expect(act.myRsvp).toBe('going');
    expect(act.ticketsSold).toBe(1);

    // A retry returns the same ticket; the same payment can't buy a second one, for anyone.
    const again = await u.tkt_buyer('POST', `/activities/${planId}/ticket/verify`, body);
    expect(again.json().ticket.id).toBe(t.id);
    expect((await u.tkt_buyer2('POST', `/activities/${planId}/ticket/verify`, body)).json().error).toBe('payment_already_used');
    // A second purchase by the same person is refused before ordering.
    expect((await u.tkt_buyer('POST', `/activities/${planId}/ticket/order`)).json().error).toBe('already_has_ticket');
    expect(await tickets(planId)).toBe(1);
    expect((await u.tkt_buyer('GET', `/activities/${planId}`)).json().ticketsSold).toBe(1);

    const wallet = (await u.tkt_buyer('GET', '/me/tickets')).json().tickets;
    expect(wallet.find((x: any) => x.ticketCode === t.ticketCode)).toBeTruthy();
    const sales = (await u.tkt_host('GET', `/activities/${planId}/tickets`)).json();
    expect(sales.totalSold).toBe(1);
    expect((await u.tkt_host('POST', `/activities/${planId}/tickets/${t.id}/check-in`)).json().status).toBe('used');
  });

  it('exploit: two buyers paying for the last ticket at once get one ticket, and the loser is not charged', async () => {
    // maxTickets is 2 and one is sold.
    const a = (await u.tkt_buyer2('POST', `/activities/${planId}/ticket/order`)).json();
    const b = (await u.tkt_buyer3('POST', `/activities/${planId}/ticket/order`)).json();
    pay('pay_race_a', a.orderId, 49900); pay('pay_race_b', b.orderId, 49900);
    const [ra, rb] = await Promise.all([
      u.tkt_buyer2('POST', `/activities/${planId}/ticket/verify`, { orderId: a.orderId, paymentId: 'pay_race_a', signature: sign(a.orderId, 'pay_race_a') }),
      u.tkt_buyer3('POST', `/activities/${planId}/ticket/verify`, { orderId: b.orderId, paymentId: 'pay_race_b', signature: sign(b.orderId, 'pay_race_b') }),
    ]);
    expect([ra.statusCode, rb.statusCode].sort()).toEqual([200, 400]);
    expect([ra.json().error, rb.json().error]).toContain('tickets_sold_out');
    expect(await tickets(planId)).toBe(2);
    expect(rz.captures.filter(c => c.startsWith('pay_race_'))).toHaveLength(1);
    expect((await u.tkt_buyer3('POST', `/activities/${planId}/ticket/order`)).json().error).toMatch(/tickets_sold_out|already_has_ticket/);
  });

  it('exploit: a ticket goes through the same gates as joining (women-only, blocks, closed)', async () => {
    const wo = (await u.tkt_host('POST', '/activities', paidPlan({ title: 'Women only cooking class', womenOnly: true }))).json().id;
    const r = await u.tkt_man('POST', `/activities/${wo}/ticket/order`);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('women_only');
    // Even with an order made for him by hand (as if the order step had been skipped), verify refuses before capture.
    const forged = { id: `order_t${++rz.n}`, entity: 'order', status: 'created', amount: 49900, currency: 'INR',
      notes: { service: 'tablamigo', user_id: await idOf('tkt_man'), product: 'activity_ticket', activity_id: wo } };
    rz.orders.set(forged.id, forged); pay('pay_man', forged.id, 49900);
    const v = await u.tkt_man('POST', `/activities/${wo}/ticket/verify`, { orderId: forged.id, paymentId: 'pay_man', signature: sign(forged.id, 'pay_man') });
    expect(v.json().error).toBe('women_only');

    const open = (await u.tkt_host('POST', '/activities', paidPlan({ title: 'Blocked and closed test' }))).json().id;
    await u.tkt_host('POST', `/blocks/${await idOf('tkt_buyer3')}`);
    expect((await u.tkt_buyer3('POST', `/activities/${open}/ticket/order`)).statusCode).toBe(403);
    await u.tkt_host('DELETE', `/blocks/${await idOf('tkt_buyer3')}`);
    await u.tkt_host('POST', `/activities/${open}/close`, { closed: true });
    expect((await u.tkt_buyer3('POST', `/activities/${open}/ticket/order`)).json().error).toBe('event_closed');
    expect(rz.captures).not.toContain('pay_man');
    expect(await tickets(wo)).toBe(0);
  });

  it('keeps the old guards: price floor, own event', async () => {
    expect((await u.tkt_host('POST', '/activities', paidPlan({ ticketPricePaise: 2000 }))).json().error).toBe('invalid_input');
    expect((await u.tkt_host('POST', `/activities/${planId}/ticket/order`)).json().error).toBe('cannot_buy_own_event');
  });
});
