import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const PEOPLE = ['rem_host', 'rem_attendee', 'rem_stranger'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@reminders.tablamigo`).join(',');
process.env.REVIEW_CODE = '555555';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { clock } = await import('./lib/clock.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 980;
async function login(name: string): Promise<Api> {
  const email = `${name}@reminders.tablamigo`;
  const remoteAddress = `10.99.1.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '555555' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1996-06-06', gender: 'woman', homeCountry: 'TH' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@reminders.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@reminders.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
  await sql`update users set role = 'admin' where email = 'rem_host@reminders.tablamigo'`;
});

afterAll(async () => {
  await sql`delete from users where email like '%@reminders.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Plan Reminders & Running Late Status', () => {
  let activityId: string;
  let chatId: string;

  it('sets up a plan and allows attendee to report running late', async () => {
    const startsAt = new Date(Date.now() + 30 * 60_000).toISOString(); // 30 min from now
    const createRes = await u.rem_host('POST', '/activities', {
      title: 'Sunset Drinks & Tapas',
      emoji: '🍹',
      category: 'drinks',
      placeName: 'Sky Bar Rooftop',
      lat: 13.7563,
      lng: 100.5018,
      startsAt,
    });
    expect(createRes.statusCode).toBe(200);
    activityId = createRes.json().id;
    chatId = createRes.json().chatId;

    // Attendee joins
    const joinRes = await u.rem_attendee('POST', `/activities/${activityId}/join`);
    expect(joinRes.statusCode).toBe(200);

    // Stranger tries to report running late -> 403
    const strangerRes = await u.rem_stranger('POST', `/activities/${activityId}/running-late`, { minutes: 15 });
    expect(strangerRes.statusCode).toBe(403);

    // Attendee reports running late
    const lateRes = await u.rem_attendee('POST', `/activities/${activityId}/running-late`, { minutes: 10 });
    expect(lateRes.statusCode).toBe(200);
    expect(lateRes.json().ok).toBe(true);
    expect(lateRes.json().minutes).toBe(10);

    // Verify system announcement in chat
    const messagesRes = await u.rem_host('GET', `/chats/${chatId}/messages`);
    expect(messagesRes.statusCode).toBe(200);
    const msgs = messagesRes.json().messages;
    expect(msgs.some((m: any) => m.body.includes('running about 10 minutes late'))).toBe(true);
  });

  it('processes 2h and 15m plan reminders via admin endpoint', async () => {
    // The endpoint reminds every due plan in the database, and the integration files share one database and run in
    // parallel: at the real time, another file's plan starting about 2 hours out could be counted by either call (CI run
    // 40317277764), and this test would post reminders into that file's chats. So the endpoint's clock is pinned to an
    // instant no other test file uses, and the checks are on this test's own plans, not on the database-wide counts.
    const T = new Date('2037-05-20T09:00:00Z');
    const at = (min: number) => new Date(T.getTime() + min * 60_000);
    const now = vi.spyOn(clock, 'now').mockReturnValue(T);
    try {
      const plan = async (title: string, startsAt: Date) => {
        const [a] = await sql`
          insert into activities (host_id, title, emoji, category, place_name, location, city, starts_at, status)
          values (
            ${await idOf('rem_host')}, ${title}, '☕', 'drinks', 'Cafe Central',
            ST_SetSRID(ST_MakePoint(100.5, 13.7), 4326)::geography, 'Bangkok', ${startsAt}, 'active'
          ) returning id
        `;
        const [c] = await sql`insert into chats (kind, activity_id, title) values ('activity', ${a.id}, ${title}) returning id`;
        return { id: a.id as string, chatId: c.id as string };
      };
      const p15 = await plan('Quick Coffee', at(10));             // due for the 15-minute reminder
      const p2h = await plan('Dinner & Night Market', at(120));   // due for the 2-hour reminder
      const reminders = (chatId: string) => sql`select body from messages where chat_id = ${chatId} and kind = 'system' order by id`;
      const marks = (id: string) => sql`select reminded_2h_at as r2h, reminded_15m_at as r15m from activities where id = ${id}`;

      const procRes = await u.rem_host('POST', '/admin/activities/process-reminders');
      expect(procRes.statusCode).toBe(200);
      const body = procRes.json();
      expect(body.ok).toBe(true);
      expect(body.reminded2h).toBeGreaterThanOrEqual(1);
      expect(body.reminded15m).toBeGreaterThanOrEqual(1);

      const once15 = await reminders(p15.chatId), once2h = await reminders(p2h.chatId);
      expect(once15.map(m => m.body)).toEqual([expect.stringContaining('starting in 15 minutes')]);
      expect(once2h.map(m => m.body)).toEqual([expect.stringContaining('starts in ~2 hours')]);
      const [marks15] = await marks(p15.id), [marks2h] = await marks(p2h.id);
      expect(marks15).toEqual({ r2h: null, r15m: T });
      expect(marks2h).toEqual({ r2h: T, r15m: null });

      // Running again is idempotent: no second reminder in either chat, and neither plan is claimed again.
      const procRes2 = await u.rem_host('POST', '/admin/activities/process-reminders');
      expect(procRes2.statusCode).toBe(200);
      expect(await reminders(p15.chatId)).toEqual(once15);
      expect(await reminders(p2h.chatId)).toEqual(once2h);
      expect(await marks(p15.id)).toEqual([marks15]);
      expect(await marks(p2h.id)).toEqual([marks2h]);
    } finally {
      now.mockRestore();
    }
  });
});
