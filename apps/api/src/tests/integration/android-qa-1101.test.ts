// API halves of the Android pre-release QA fixes (1 Nov 2026): the Chats tab can say "You:" for your own last message, and a
// profile's journey timeline gives trip dates the way people write them, not "2026-11-07 - 2026-11-15".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const D = '@androidqa1101.tablamigo';
process.env.REVIEW_EMAILS = ['ana', 'ben'].map(p => `${p}${D}`).join(',');
process.env.REVIEW_CODE = '246810';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { tripDateRange } = await import('../../lib/date-range.js');
const { signIn, onboard, BKK } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let ana: Awaited<ReturnType<typeof signIn>>, ben: Awaited<ReturnType<typeof signIn>>;

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  ana = await onboard(await signIn(app, `ana${D}`, '246810', 81), { name: 'Ana', gender: 'woman' }, BKK);
  ben = await onboard(await signIn(app, `ben${D}`, '246810', 81), { name: 'Ben', gender: 'man' }, BKK);
});
afterAll(async () => { await sql`delete from users where email like ${'%' + D}`; await app.close(); });

describe('GET /chats lastMessage.mine', () => {
  it('is true for the caller\'s own last message and false for the other person\'s', async () => {
    const dm = await ana.call('POST', `/dm/${ben.id}`);
    expect(dm.statusCode, dm.body).toBe(200);
    const chatId = dm.json().chatId ?? dm.json().id;
    expect((await ana.call('POST', `/chats/${chatId}/messages`, { body: 'hello Ben' })).statusCode).toBe(200);
    const mine = (await ana.call('GET', '/chats')).json().chats.find((c: any) => c.id === chatId);
    expect(mine.lastMessage).toMatchObject({ body: 'hello Ben', senderName: 'Ana', mine: true });
    const theirs = (await ben.call('GET', '/chats')).json().chats.find((c: any) => c.id === chatId);
    expect(theirs.lastMessage).toMatchObject({ body: 'hello Ben', senderName: 'Ana', mine: false });
  });
});

describe('journey timeline trip dates', () => {
  it('formats a trip as "7 – 15 Nov 2026" in GET /users/:id/timeline', async () => {
    const t = await ana.call('POST', '/trips', { city: 'Lisbon', countryCode: 'PT', lat: 38.711, lng: -9.14, startDate: '2027-03-07', endDate: '2027-03-15' });
    expect(t.statusCode, t.body).toBe(200);
    const r = await ben.call('GET', `/users/${ana.id}/timeline`);
    expect(r.statusCode, r.body).toBe(200);
    const trip = r.json().timeline.find((i: any) => i.kind === 'trip');
    expect(trip.subtitle).toBe('7 – 15 Mar 2027');
  });

  it('tripDateRange across months, years and a single day', () => {
    expect(tripDateRange('2026-11-07', '2026-11-15')).toBe('7 – 15 Nov 2026');
    expect(tripDateRange('2026-11-28', '2026-12-03')).toBe('28 Nov – 3 Dec 2026');
    expect(tripDateRange('2026-12-28', '2027-01-03')).toBe('28 Dec 2026 – 3 Jan 2027');
    expect(tripDateRange('2026-11-07', '2026-11-07')).toBe('7 Nov 2026');
    expect(tripDateRange(new Date('2026-11-07T00:00:00Z'), new Date('2026-11-15T00:00:00Z'))).toBe('7 – 15 Nov 2026');
  });
});
