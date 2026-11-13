// The engagement worker (lib/ai-engagement.ts), which main.ts starts on every boot and runs every 15 minutes, and its admin
// trigger (POST /admin/ai-engagement/run). It had no test. It reads and writes across the whole database (any quiet plan,
// any unanswered city-chat message), so it lives in the e2e project: one file at a time, after all integration files.
// What is pinned: which plans and messages it picks, the fallback text when OpenAI is missing or failing, that it acts once,
// the advisory lock, the admin route, and that it joins a plan only the way a person could (lib/plans.ts assertCanJoin).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@aieng.tablamigo';
const DEMO = '@demo.tablamigo';
process.env.REVIEW_EMAILS = ['host', 'wen', 'chat', 'boss', 'blk'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
process.env.ADMIN_EMAILS = `boss${D}`;
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { runAiEngagement, AI_ENGAGEMENT_LOCK } = await import('../../lib/ai-engagement.js');
const { signIn, onboard, createPlan } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
let host: Person, wen: Person, chatter: Person, boss: Person, blk: Person;
let mona: string, marco: string;   // demo personas: a woman and a man
const realFetch = globalThis.fetch;
const CITY_KEY = 'aieng-testopolis-zz';

const persona = async (local: string, name: string, gender: 'woman' | 'man') =>
  (await sql`insert into users ${sql({ email: local + DEMO, name, gender, birthdate: '1996-01-01', homeCountry: 'PT', onboarded: true, city: 'Testopolis' } as any)} returning id`)[0].id as string;
const age = (planId: string, minutes = 5) => sql`update activities set created_at = now() - ${minutes + ' minutes'}::interval where id = ${planId}`;
const members = async (planId: string) => (await sql`select u.email from activity_members m join users u on u.id = m.user_id where m.activity_id = ${planId}`).map(r => r.email as string).sort();
const ours = (r: Awaited<ReturnType<typeof runAiEngagement>>, ids: string[]) => r.actions.filter(a => ids.includes(a.targetId));
const cleanup = async () => {
  await sql`delete from users where email like ${'%' + D} or email in ${sql(['aieng-mona' + DEMO, 'aieng-marco' + DEMO])}`;
  await sql`delete from chats where city_key in ${sql([CITY_KEY, CITY_KEY + ':women'])}`;
};

beforeAll(async () => {
  app = await build();
  await cleanup();
  config.adminEmails = [`boss${D}`];
  host = await onboard(await signIn(app, 'host' + D, '424242', 81), { name: 'Hari', gender: 'man' });
  wen = await onboard(await signIn(app, 'wen' + D, '424242', 81), { name: 'Wen', gender: 'woman' });
  chatter = await onboard(await signIn(app, 'chat' + D, '424242', 81), { name: 'Chae', gender: 'woman' });
  boss = await onboard(await signIn(app, 'boss' + D, '424242', 81), { name: 'Boss', gender: 'woman' });
  blk = await onboard(await signIn(app, 'blk' + D, '424242', 81), { name: 'Bela', gender: 'woman' });
  await sql`update users set comp_until = now() + interval '1 day', plus_until = now() + interval '1 day' where email like ${'%' + D}`;
  // Leave nothing else for the worker to pick: this is a throwaway test database and this file runs alone.
  await sql`update activities set created_at = now() where status = 'active' and created_at < now() - interval '2 minutes'`;
  await sql`update messages set created_at = now() - interval '4 days' where chat_id in (select id from chats where kind = 'city') and created_at > now() - interval '72 hours'`;
  mona = await persona('aieng-mona', 'Mona', 'woman');
  marco = await persona('aieng-marco', 'Marco', 'man');
});
afterAll(async () => { globalThis.fetch = realFetch; await cleanup(); await app.close(); await sql.end(); });
beforeEach(() => { config.openaiKey = ''; delete process.env.OPENAI_API_KEY; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.OPENAI_API_KEY; });

describe('quiet plans', () => {
  it('a plan older than 2 minutes with only its host gets one persona, a greeting in its chat, and only once', async () => {
    const plan = await createPlan(host, { title: 'Quiet dinner', city: 'Testopolis' });
    const fresh = await createPlan(host, { title: 'Just posted' });
    await age(plan.id);
    const r = await runAiEngagement();
    expect(r.ran).toBe(true);
    const acts = ours(r, [plan.id, fresh.id]);
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ type: 'plan_joined', targetId: plan.id, recipientName: 'Hari', message: 'Hey Hari! Count me in, looking forward to meeting up 🙌' });
    expect((await members(plan.id)).filter(e => e.endsWith(DEMO))).toHaveLength(1);
    expect(await members(fresh.id)).toEqual([`host${D}`]);   // under 2 minutes old: left alone
    const [msg] = await sql`select m.body, u.email from messages m join users u on u.id = m.sender_id where m.chat_id = ${plan.chatId} and m.kind = 'text'`;
    expect(msg.body).toBe(acts[0].message);
    expect(msg.email.endsWith(DEMO)).toBe(true);
    expect(ours(await runAiEngagement(), [plan.id])).toEqual([]);   // already has a persona
  });

  it('leaves alone: cancelled plans, plans with 2+ people, plans by admins, plans that ended over 4 hours ago', async () => {
    const cancelled = await createPlan(host, { title: 'Cancelled one' });
    await host.call('POST', `/activities/${cancelled.id}/cancel`);
    const busy = await createPlan(host, { title: 'Busy one' });
    await wen.call('POST', `/activities/${busy.id}/join`);
    const admins = await createPlan(boss, { title: 'Admin plan' });
    await sql`update users set role = 'admin' where id = ${boss.id}`;
    const old = await createPlan(host, { title: 'Long gone' });
    await sql`update activities set starts_at = now() - interval '5 hours' where id = ${old.id}`;
    const ids = [cancelled.id, busy.id, admins.id, old.id];
    for (const id of ids) await age(id);
    expect(ours(await runAiEngagement(), ids)).toEqual([]);
    await sql`update users set role = 'user' where id = ${boss.id}`;
    await sql`update activities set status = 'cancelled' where id = ${admins.id}`;   // or the next runs would pick it
  });

  it('uses the OpenAI reply when there is one, and the fallback when OpenAI fails', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let reply = () => new Response(JSON.stringify({ choices: [{ message: { content: '  ooh count me in! what time works?  ' } }] }), { status: 200 });
    globalThis.fetch = vi.fn(async (u: any, i: any) => (String(u).startsWith('https://api.openai.com/') ? reply() : realFetch(u, i))) as any;
    const a = await createPlan(wen, { title: 'Sunset walk' });
    await age(a.id);
    expect(ours(await runAiEngagement(), [a.id])[0].message).toBe('ooh count me in! what time works?');
    reply = () => new Response('upstream error', { status: 503 });
    const b = await createPlan(wen, { title: 'Coffee crawl' });
    await age(b.id);
    expect(ours(await runAiEngagement(), [b.id])[0].message).toBe('Hey Wen! Count me in, looking forward to meeting up 🙌');
  });

  // Until 22 Oct 2026 the worker inserted into activity_members directly and skipped the join route's rules: with only a male
  // persona free to pick, he joined a women-only plan and posted in its chat (and the same for a host who blocked him). It now
  // joins through lib/plans.ts assertCanJoin, the rules POST /activities/:id/join applies.
  it('women-only plans only ever get a woman, and never someone the host blocked', async () => {
    await sql`update users set email = 'aieng-mona-away@example.invalid' where id = ${mona}`;   // only Marco is a persona now
    try {
      const wo = await createPlan(wen, { title: 'Women-only brunch', womenOnly: true });
      await blk.call('POST', `/blocks/${marco}`);
      const blocked = await createPlan(blk, { title: 'Blocked host plan' });
      for (const p of [wo, blocked]) await age(p.id);
      await runAiEngagement();
      expect(await members(wo.id)).not.toContain('aieng-marco' + DEMO);
      expect(await members(blocked.id)).not.toContain('aieng-marco' + DEMO);
      expect((await sql`select 1 from messages where chat_id in ${sql([wo.chatId, blocked.chatId])} and sender_id = ${marco}`).length).toBe(0);
    } finally { await sql`update users set email = ${'aieng-mona' + DEMO} where id = ${mona}`; }
    // With a woman persona back, the women-only plan gets her.
    const wo2 = await createPlan(wen, { title: 'Women-only picnic', womenOnly: true });
    await age(wo2.id);
    expect(ours(await runAiEngagement(), [wo2.id])).toHaveLength(1);
    const demo = (await members(wo2.id)).filter(e => e.endsWith(DEMO));
    expect(demo).toHaveLength(1);
    expect(demo).not.toContain('aieng-marco' + DEMO);
  });

  it('a plan a person could not join is left alone: closed to new people, or started over 2 hours ago', async () => {
    const closed = await createPlan(host, { title: 'Closed one' });
    await sql`update activities set closed = true where id = ${closed.id}`;
    const started = await createPlan(host, { title: 'Started 3 h ago' });
    await sql`update activities set starts_at = now() - interval '3 hours' where id = ${started.id}`;
    for (const p of [closed, started]) await age(p.id);
    expect(ours(await runAiEngagement(), [closed.id, started.id])).toEqual([]);
    for (const p of [closed, started]) expect((await members(p.id)).filter(e => e.endsWith(DEMO))).toEqual([]);
    await sql`update activities set status = 'cancelled' where id in ${sql([closed.id, started.id])}`;   // or the next runs would pick them
  });
});

describe('unanswered city-chat messages', () => {
  it('a real person\'s last message, 2 minutes to 72 hours old, gets one reply; then the chat is answered', async () => {
    const [chat] = await sql`insert into chats (kind, city_key, title) values ('city', ${CITY_KEY}, 'Testopolis travelers') returning id`;
    await sql`insert into chat_members (chat_id, user_id) values (${chat.id}, ${chatter.id})`;
    await sql`insert into messages (chat_id, sender_id, kind, body, created_at) values (${chat.id}, ${chatter.id}, 'text', 'anyone around tonight?', now() - interval '5 minutes')`;
    const r = ours(await runAiEngagement(), [chat.id]);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ type: 'chat_reply', recipientName: 'Chae', city: 'Testopolis', message: 'Hey Chae! Welcome 👋 Are you traveling around here right now?' });
    const msgs = await sql`select u.email from messages m join users u on u.id = m.sender_id where m.chat_id = ${chat.id} order by m.created_at`;
    expect(msgs.map(m => m.email.endsWith(DEMO))).toEqual([false, true]);
    expect(ours(await runAiEngagement(), [chat.id])).toEqual([]);
  });

  it('ignores messages under 2 minutes or over 72 hours old', async () => {
    const [chat] = await sql`select id from chats where city_key = ${CITY_KEY}`;
    await sql`insert into messages (chat_id, sender_id, kind, body) values (${chat.id}, ${chatter.id}, 'text', 'just now')`;
    expect(ours(await runAiEngagement(), [chat.id])).toEqual([]);
    await sql`update messages set created_at = now() - interval '73 hours' where chat_id = ${chat.id} and body = 'just now'`;
    expect(ours(await runAiEngagement(), [chat.id])).toEqual([]);
  });
});

describe('running it', () => {
  it('two runs at once: one does the work, the other sees the lock and does nothing', async () => {
    const held = sql.reserve();
    const conn = await held;
    try {
      await conn`begin`;
      await conn`select pg_advisory_xact_lock(${AI_ENGAGEMENT_LOCK})`;
      expect(await runAiEngagement()).toEqual({ ran: false, actions: [] });
      await conn`rollback`;
    } finally { conn.release(); }
    expect((await runAiEngagement()).ran).toBe(true);
  });

  // Until 22 Oct 2026 every write sat in the worker's one transaction: a plan it had joined stayed row-locked through its later
  // OpenAI calls (up to 9 of up to 10 s), and a person's Join on that plan waited the whole time. Each join now commits at once.
  it('a plan the worker has joined is free for a person while the worker still waits on OpenAI for the next one', async () => {
    process.env.OPENAI_API_KEY = 'sk-test';
    let lockCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    globalThis.fetch = vi.fn(async (u: any, i: any) => {
      if (!String(u).startsWith('https://api.openai.com/')) return realFetch(u, i);
      // The first of this test's two plans is answered at once; the second waits until the test lets it go.
      if (String(i?.body).includes('Lock test') && lockCalls++ >= 1) await gate;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'count me in!' } }] }), { status: 200 });
    }) as any;
    const plans = [await createPlan(host, { title: 'Lock test one' }), await createPlan(host, { title: 'Lock test two' })];
    for (const p of plans) await age(p.id);
    const run = runAiEngagement();
    try {
      let joinedId: string | undefined;
      for (let i = 0; i < 100 && !joinedId; i++) {
        for (const p of plans) if ((await members(p.id)).some(e => e.endsWith(DEMO))) joinedId = p.id;
        if (!joinedId) await new Promise(r => setTimeout(r, 50));
      }
      expect(joinedId, 'the first join is committed while the worker waits on OpenAI').toBeDefined();
      const t0 = Date.now();
      const r = await wen.call('POST', `/activities/${joinedId}/join`);
      expect(r.statusCode).toBe(200);
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally { release(); }
    expect((await run).ran).toBe(true);
  });

  it('admins can trigger a run; members cannot', async () => {
    expect((await host.call('POST', '/admin/ai-engagement/run', {})).statusCode).toBe(403);
    const plan = await createPlan(chatter, { title: 'Admin-triggered' });
    await age(plan.id);
    const r = await boss.call('POST', '/admin/ai-engagement/run', {});
    expect(r.statusCode).toBe(200);
    expect(r.json().ran).toBe(true);
    expect(r.json().actions.map((a: any) => a.targetId)).toContain(plan.id);
  });
});
