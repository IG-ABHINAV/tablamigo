import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['ac_host', 'ac_asker', 'ac_replier', 'ac_stranger'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@ac.tablamigo`).join(',');
process.env.REVIEW_CODE = '666666';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown, headers?: Record<string, string>) => Promise<import('light-my-request').Response>;

let ip = 2000;
async function login(name: string): Promise<Api> {
  const email = `${name}@ac.tablamigo`;
  const remoteAddress = `10.99.10.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '666666' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload, headers) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}`, ...(headers ?? {}) },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1996-06-06', gender: 'woman', homeCountry: 'PT' });
  return call;
}

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@ac.tablamigo'`;
  for (const p of PEOPLE) {
    u[p] = await login(p);
  }
});

afterAll(async () => {
  await sql`delete from users where email like '%@ac.tablamigo'`;
  await app.close();
});

describe('Feature 36: Activity Discussion & Q&A Comments', () => {
  let activityId: string;
  let questionId: string;

  it('creates an activity, allows a prospective traveler to ask a question, and notifies host', async () => {
    // 1. Host creates a plan
    const createRes = await u.ac_host('POST', '/activities', {
      title: 'Sunrise Hike & Pastel de Nata',
      emoji: '🥾',
      category: 'outdoors',
      placeName: 'Miradouro de Santa Luzia',
      lat: 38.7118,
      lng: -9.1306,
      startsAt: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
    });
    expect(createRes.statusCode).toBe(200);
    activityId = createRes.json().id;

    // 2. Asker asks a question before joining
    const commentRes = await u.ac_asker('POST', `/activities/${activityId}/comments`, {
      body: 'Is the hike steep or beginner-friendly? Bringing running shoes.',
    });
    expect(commentRes.statusCode).toBe(200);
    const comment = commentRes.json();
    expect(comment.id).toBeDefined();
    expect(comment.body).toContain('beginner-friendly');
    expect(comment.author.name).toBe('ac_asker');
    expect(comment.author.isHost).toBe(false);
    questionId = comment.id;

    // 3. Host receives inbox notification
    const hostUser = (await sql`select id from users where email = 'ac_host@ac.tablamigo'`)[0];
    const [notice] = await sql`
      select * from notifications
      where user_id = ${hostUser.id} and kind = 'plan_comment'
      order by created_at desc limit 1
    `;
    expect(notice).toBeDefined();
    expect(notice.activityId).toBe(activityId);
    expect(notice.body).toContain('asked a question');
  });

  it('allows host to reply to question and lists all comments', async () => {
    // Host replies
    const replyRes = await u.ac_host('POST', `/activities/${activityId}/comments`, {
      body: 'Totally beginner-friendly! Regular sneakers or running shoes are perfect.',
      parentCommentId: questionId,
    });
    expect(replyRes.statusCode).toBe(200);
    expect(replyRes.json().author.isHost).toBe(true);
    expect(replyRes.json().parentCommentId).toBe(questionId);

    // Fetch comments list
    const listRes = await u.ac_stranger('GET', `/activities/${activityId}/comments`);
    expect(listRes.statusCode).toBe(200);
    const { comments } = listRes.json();
    expect(comments.length).toBe(2);
    expect(comments[0].id).toBe(questionId);
    expect(comments[0].author.isHost).toBe(false);
    expect(comments[1].author.isHost).toBe(true);

    // Detail endpoint includes commentsCount = 2
    const detailRes = await u.ac_stranger('GET', `/activities/${activityId}`);
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().commentsCount).toBe(2);
  });

  it('allows author or host to delete comments', async () => {
    // Other stranger tries to delete -> 403
    const badDelete = await u.ac_stranger('DELETE', `/activities/${activityId}/comments/${questionId}`);
    expect(badDelete.statusCode).toBe(403);

    // Author deletes own comment -> 200
    const okDelete = await u.ac_asker('DELETE', `/activities/${activityId}/comments/${questionId}`);
    expect(okDelete.statusCode).toBe(200);

    // Verify it is gone
    const listAfter = await u.ac_stranger('GET', `/activities/${activityId}/comments`);
    expect(listAfter.json().comments.some((c: any) => c.id === questionId)).toBe(false);
  });
});
