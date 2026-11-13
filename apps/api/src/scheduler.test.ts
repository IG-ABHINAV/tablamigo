// The in-process scheduler (lib/scheduler.ts) and the jobs it runs (lib/plan-jobs.ts): plan reminders and the next session of
// recurring plans. Every call says what time it is (the plans are in 2031, so nothing here can touch another test file's
// plans, and their real-time runs can't touch these), the timers are faked, and pushes are recorded instead of sent.
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';

const pushes: { to: string[]; title: string; data?: Record<string, string>; tag?: string }[] = [];
vi.mock('./lib/push.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./lib/push.js')>()),
  notify: (to: string[], p: { title: string; data?: Record<string, string>; tag?: string }) => { if (to.length) pushes.push({ to: [...to], title: p.title, data: p.data, tag: p.tag }); return Promise.resolve(); },
}));

const { sql } = await import('./lib/db.js');
const { config, schedulerEnabled } = await import('./lib/config.js');
const { runSchedulerTick, startScheduler, startSchedulerIfEnabled, SCHEDULER_LOCK } = await import('./lib/scheduler.js');
/** runSchedulerTick, retried while another test file's tick holds the scheduler's advisory lock (they share one database). */
const tickWhenUnlocked = async (...a: Parameters<typeof runSchedulerTick>) => {
  let r = await runSchedulerTick(...a);
  for (let i = 0; i < 50 && !r.ran; i++) { await new Promise(res => setTimeout(res, 100)); r = await runSchedulerTick(...a); }
  return r;
};
const { processPlanReminders, processDueRecurring, RECURRING_LOOKBACK_DAYS } = await import('./lib/plan-jobs.js');

const D = '@sched.tablamigo';
const T = new Date('2031-03-01T08:00:00Z');
const at = (offsetMin: number) => new Date(T.getTime() + offsetMin * 60_000);
const HOUR = 60, DAY = 24 * HOUR;
const user: Record<string, string> = {};

beforeAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  for (const n of ['host', 'going', 'maybe', 'waitlist']) user[n] = (await sql`insert into users (email, name) values (${n + D}, ${n}) returning id`)[0].id;
});
// Each test starts from no plans of its own, so what one test creates (a next session, say) is never due in the next.
beforeEach(async () => { await sql`delete from activities where host_id = ${user.host}`; });
afterAll(async () => {
  await sql`delete from users where email like ${'%' + D}`;
  await sql.end();
});

/** A plan in Berlin starting `min` minutes after T, with a chat and the host, a going, a maybe and a waitlisted member. */
async function plan(title: string, min: number, extra: { status?: string; recurrence?: string; autoAdvance?: boolean; chat?: boolean; members?: boolean } = {}) {
  const [a] = await sql`insert into activities (host_id, title, emoji, category, place_name, location, city, starts_at, status, recurrence, occurrence_number, auto_advance)
    values (${user.host}, ${title}, '⏰', 'culture', 'Old Town Hall', ST_SetSRID(ST_MakePoint(13.405, 52.52), 4326)::geography, 'Berlin', ${at(min)},
      ${extra.status ?? 'active'}, ${extra.recurrence ?? null}, 1, ${extra.autoAdvance ?? true}) returning id`;
  await sql`update activities set series_id = id where id = ${a.id} and recurrence is not null`;
  let chatId: string | null = null;
  if (extra.chat !== false) chatId = (await sql`insert into chats (kind, activity_id, title) values ('activity', ${a.id}, ${title}) returning id`)[0].id;
  if (extra.members !== false) {
    await sql`insert into activity_members (activity_id, user_id, rsvp_status) values (${a.id}, ${user.host}, 'going'), (${a.id}, ${user.going}, 'going'), (${a.id}, ${user.maybe}, 'maybe'), (${a.id}, ${user.waitlist}, 'waitlist')`;
  }
  return { id: a.id as string, chatId };
}
/** Opens the pool's connections: a race only happens when every caller has a connection the moment it starts. */
const warmPool = () => Promise.all(Array.from({ length: 9 }, () => sql`select pg_sleep(0.1)`));
const systemLines = async (chatId: string | null) => chatId ? (await sql`select body from messages where chat_id = ${chatId} and kind = 'system' order by id`).map(m => m.body as string) : [];
const reminded = async (id: string) => (await sql`select reminded_2h_at, reminded_15m_at from activities where id = ${id}`)[0];

describe('plan reminders, with the time given', () => {
  it('reminds each plan once per kind, only the plans in the window, and only the people who are going', async () => {
    const p2h = await plan('Reminder 2h', 2 * HOUR), p15 = await plan('Reminder 15m', 10);
    const far = await plan('Reminder far', 3 * HOUR), mid = await plan('Reminder between windows', 30);
    const cancelled = await plan('Reminder cancelled', 2 * HOUR, { status: 'cancelled' }), noChat = await plan('Reminder no chat', 2 * HOUR, { chat: false });
    pushes.length = 0;

    expect(await processPlanReminders(T)).toEqual({ reminded2h: 2, reminded15m: 1 });
    expect(await systemLines(p2h.chatId)).toEqual(['⏰ Reminder: "Reminder 2h" starts in ~2 hours at Old Town Hall! Check your route.']);
    expect(await systemLines(p15.chatId)).toEqual(['📍 Meetup starting in 15 minutes at Old Town Hall! Tap "I\'m here" once you arrive to check in.']);
    for (const p of [far, mid, cancelled]) expect(await systemLines(p.chatId), 'not due').toEqual([]);
    expect((await reminded(p2h.id)).reminded2hAt).toEqual(T);                      // the time it was given, not the clock's
    expect((await reminded(noChat.id)).reminded2hAt).toEqual(T);                   // claimed, nothing to post in
    expect((await reminded(far.id)).reminded2hAt).toBeNull();
    expect((await reminded(cancelled.id)).reminded2hAt).toBeNull();

    // Pushes go to the host and the going member, not to maybe or waitlist; a tap opens the plan's chat.
    const forP2h = pushes.find(p => p.title === 'Starts in 2 hours: Reminder 2h')!;
    expect([...forP2h.to].sort()).toEqual([user.host, user.going].sort());
    expect(forP2h.data).toEqual({ chatId: p2h.chatId });
    expect(forP2h.tag).toBe(p2h.chatId);
    expect(pushes.find(p => p.title === 'Starting in 15 minutes!')!.data).toEqual({ chatId: p15.chatId });

    // A second run at the same time does nothing.
    pushes.length = 0;
    expect(await processPlanReminders(T)).toEqual({ reminded2h: 0, reminded15m: 0 });
    expect(pushes).toEqual([]);

    // Later the same plans come into the other windows: the far plan is now 90 minutes away, then 15.
    expect(await processPlanReminders(at(90))).toEqual({ reminded2h: 1, reminded15m: 0 });
    expect(await systemLines(far.chatId)).toEqual(['⏰ Reminder: "Reminder far" starts in ~2 hours at Old Town Hall! Check your route.']);
    expect(await processPlanReminders(at(2 * HOUR + 45))).toEqual({ reminded2h: 0, reminded15m: 1 });
    expect((await systemLines(far.chatId)).length).toBe(2);
    expect((await systemLines(p2h.chatId)).length).toBe(1);                         // the 2-hour plan's 15-minute reminder comes when T is two hours on
    expect(await processPlanReminders(at(2 * HOUR - 10))).toEqual({ reminded2h: 0, reminded15m: 2 });   // the 2-hour plan and the one without a chat
    expect((await systemLines(p2h.chatId)).length).toBe(2);
  });

  it('exploit: processes running at once never remind a plan twice', async () => {
    const p = await plan('Reminder race', 2 * HOUR + 5 * DAY);
    const now = at(5 * DAY);
    pushes.length = 0;
    await warmPool();
    const runs = await Promise.all(Array.from({ length: 6 }, () => processPlanReminders(now)));
    expect(runs.reduce((n, r) => n + r.reminded2h, 0)).toBe(1);
    expect(await systemLines(p.chatId)).toHaveLength(1);
    expect(pushes.filter(x => x.title === 'Starts in 2 hours: Reminder race')).toHaveLength(1);
  });
});

describe('recurring plans, with the time given', () => {
  it('creates the next session two hours before the current one starts, for the series that are due and no others', async () => {
    const due = await plan('Series due', 60, { recurrence: 'weekly' });
    const missed = await plan('Series missed', -5 * DAY, { recurrence: 'weekly' });
    const later = await plan('Series later', 3 * HOUR, { recurrence: 'weekly' });
    const paused = await plan('Series paused', 60, { recurrence: 'weekly', autoAdvance: false });
    const dormant = await plan('Series dormant', -(RECURRING_LOOKBACK_DAYS + 3) * DAY, { recurrence: 'weekly' });
    const cancelled = await plan('Series cancelled', 60, { recurrence: 'weekly', status: 'cancelled' });
    const done = await plan('Series done', 60, { recurrence: 'weekly' });
    const [next] = await sql`insert into activities (host_id, title, category, place_name, location, city, starts_at, series_id) values (${user.host}, 'Series done', 'culture', 'x', ST_SetSRID(ST_MakePoint(13.4, 52.5), 4326)::geography, 'Berlin', ${at(8 * DAY)}, ${done.id}) returning id`;
    await sql`update activities set next_activity_id = ${next.id} where id = ${done.id}`;

    const res = await processDueRecurring(T);
    expect(res.processed).toBe(2);
    expect(res.items.map(i => i.id).sort()).toEqual([due.id, missed.id].sort());
    const nextOf = async (id: string) => (await sql`select starts_at, occurrence_number from activities where parent_activity_id = ${id}`)[0];
    expect((await nextOf(due.id)).startsAt).toEqual(at(60 + 7 * DAY));                    // a week after, on the same clock time (no clock change in March in Berlin)
    expect((await nextOf(missed.id)).startsAt).toEqual(at(-5 * DAY + 7 * DAY));           // the first session that is not in the past
    for (const p of [later, paused, dormant, cancelled]) expect(await nextOf(p.id), 'not due').toBeUndefined();
    expect(await processDueRecurring(T)).toEqual({ processed: 0, items: [] });          // each series once
  });
});

describe('runSchedulerTick', () => {
  it('runs both jobs for what is due', async () => {
    const r = await plan('Tick reminder', 2 * HOUR + 10 * DAY), s = await plan('Tick series', 30 + 10 * DAY, { recurrence: 'weekly' });   // 30 min: due for its next session, not yet for a reminder
    const result = await tickWhenUnlocked(at(10 * DAY));
    expect(result).toMatchObject({ ran: true, reminders: { reminded2h: 1, reminded15m: 0 }, recurring: { processed: 1 } });
    expect(await systemLines(r.chatId)).toHaveLength(1);
    expect((await sql`select count(*)::int as n from activities where parent_activity_id = ${s.id}`)[0].n).toBe(1);
  });

  it('exploit: a tick that cannot get the lock does nothing (another API process has it), and works once it is free', async () => {
    const p = await plan('Tick locked', 2 * HOUR + 20 * DAY);
    const now = at(20 * DAY);
    const other = await sql.reserve();                       // "the other process": holds the scheduler's advisory lock on its own connection
    try {
      expect((await other`select pg_try_advisory_lock(${SCHEDULER_LOCK}) as locked`)[0].locked).toBe(true);
      expect(await runSchedulerTick(now)).toEqual({ ran: false });
      expect(await systemLines(p.chatId)).toEqual([]);
      expect((await reminded(p.id)).reminded2hAt).toBeNull();
    } finally {
      await other`select pg_advisory_unlock(${SCHEDULER_LOCK})`;
      other.release();
    }
    // Other test files tick the same database (play-ack.test.ts), so "free" can mean "free once their tick ends": retry briefly.
    const tickWhenFree = () => tickWhenUnlocked(now);
    expect(await tickWhenFree()).toMatchObject({ ran: true, reminders: { reminded2h: 1 } });
    expect(await systemLines(p.chatId)).toHaveLength(1);
    // The lock was released with the tick: another one can take it.
    expect(await tickWhenFree()).toMatchObject({ ran: true, reminders: { reminded2h: 0 } });
  });

  it('exploit: two ticks at once send a reminder once', async () => {
    const p = await plan('Tick twice', 2 * HOUR + 30 * DAY);
    pushes.length = 0;
    await warmPool();
    // Three at once; if another test file's tick holds the lock right then, none runs and the three are tried again.
    let results: Awaited<ReturnType<typeof runSchedulerTick>>[] = [];
    for (let i = 0; i < 50 && !results.some(r => r.ran); i++) {
      if (i) await new Promise(res => setTimeout(res, 100));
      results = await Promise.all([runSchedulerTick(at(30 * DAY)), runSchedulerTick(at(30 * DAY)), runSchedulerTick(at(30 * DAY))]);
    }
    expect(results.some(r => r.ran)).toBe(true);
    expect(await systemLines(p.chatId)).toHaveLength(1);
    expect(pushes.filter(x => x.title === 'Starts in 2 hours: Tick twice')).toHaveLength(1);
  });

  it('a job that fails does not stop the other', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const s = await plan('Tick failing reminders', 60 + 40 * DAY, { recurrence: 'weekly' });
      const r = await tickWhenUnlocked(at(40 * DAY), { processPlanReminders: async () => { throw new Error('boom'); }, processDueRecurring });
      expect(r).toMatchObject({ ran: true, reminders: { error: 'boom' }, recurring: { processed: 1 } });
      expect((await sql`select count(*)::int as n from activities where parent_activity_id = ${s.id}`)[0].n).toBe(1);
    } finally { quiet.mockRestore(); }
  });
});

describe('startScheduler (timers faked)', () => {
  afterEach(() => { vi.useRealTimers(); });
  const fakeTimers = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

  it('runs every 60 seconds until stopped', async () => {
    fakeTimers();
    const run = vi.fn(async () => {});
    const stop = startScheduler({ run });
    await vi.advanceTimersByTimeAsync(59_999);
    expect(run).toHaveBeenCalledTimes(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it('a tick that is still running makes the next one skip, so work never piles up', async () => {
    fakeTimers();
    let finish = () => {};
    const run = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const stop = startScheduler({ run });
    await vi.advanceTimersByTimeAsync(60_000 * 4);
    expect(run).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it('a failing tick is reported and the next one still runs', async () => {
    fakeTimers();
    const errors: string[] = [];
    const run = vi.fn(async () => { throw new Error('database is down'); });
    const stop = startScheduler({ run, onError: m => errors.push(m) });
    await vi.advanceTimersByTimeAsync(60_000 * 2);
    expect(run).toHaveBeenCalledTimes(2);
    expect(errors).toEqual(['scheduler tick failed: database is down', 'scheduler tick failed: database is down']);
    stop();
  });
});

describe('the SCHEDULER=off switch', () => {
  afterEach(() => { vi.useRealTimers(); config.scheduler = true; });

  it('reads the environment variable: only "off" (any case) turns it off', () => {
    for (const off of ['off', 'OFF', ' off ']) expect(schedulerEnabled(off), JSON.stringify(off)).toBe(false);
    for (const on of [undefined, '', 'on', 'true', 'yes', '0']) expect(schedulerEnabled(on), JSON.stringify(on)).toBe(true);
    expect(config.scheduler).toBe(true);                       // on by default
  });

  it('starts no timer when it is off, one when it is on', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      config.scheduler = false;
      expect(startSchedulerIfEnabled()).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
      expect(log).toHaveBeenCalledWith('scheduler: off (SCHEDULER=off)');
      config.scheduler = true;
      const stop = startSchedulerIfEnabled()!;
      expect(vi.getTimerCount()).toBe(1);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally { log.mockRestore(); }
  });
});

// The retention purge (lib/retention.ts) runs from the same tick, once a UTC day. These ticks share the lock with the tests above,
// so they live in this file: two test files taking the same database lock at once would make each other's ticks skip.
describe('the daily retention purge in the tick', () => {
  const idle = { processPlanReminders: async () => ({ reminded2h: 0, reminded15m: 0 }), processDueRecurring: async () => ({ processed: 0, items: [] }) };
  const counts = { otpCodes: 1, refreshTokens: 2, notifications: 3, analyticsEvents: 4, chatLocations: 5, planShares: 6 };

  it('purges once on the first tick of a UTC day, not on the others', async () => {
    let calls = 0;
    const state = { day: null as string | null };
    const jobs = { ...idle, purgeExpired: async () => { calls++; return counts; } };
    const first = await tickWhenUnlocked(new Date(), jobs, state);
    expect(first).toMatchObject({ ran: true, purge: counts });
    expect(state.day).toBe(new Date().toISOString().slice(0, 10));
    expect(await tickWhenUnlocked(new Date(), jobs, state)).toMatchObject({ ran: true, purge: null });
    expect(calls).toBe(1);
    state.day = '2000-01-01';                                   // "yesterday": due again
    await tickWhenUnlocked(new Date(), jobs, state);
    expect(calls).toBe(2);
  });

  it('a failed purge is reported and tried again on the next tick; a made-up time never purges', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let calls = 0, fail = true;
      const state = { day: null as string | null };
      const jobs = { ...idle, purgeExpired: async () => { calls++; if (fail) throw new Error('disk full'); return counts; } };
      expect(await tickWhenUnlocked(new Date(), jobs, state)).toMatchObject({ ran: true, purge: { error: 'disk full' } });
      expect(state.day).toBeNull();
      fail = false;
      expect(await tickWhenUnlocked(new Date(), jobs, state)).toMatchObject({ purge: counts });
      expect(calls).toBe(2);
      // Ticks given a time that isn't the clock's (every scheduler test does) don't purge at all.
      const other = { day: null as string | null };
      expect(await tickWhenUnlocked(new Date('2031-03-01T08:00:00Z'), jobs, other)).toMatchObject({ ran: true, purge: null });
      expect(calls).toBe(2);
    } finally { quiet.mockRestore(); }
  });
});
