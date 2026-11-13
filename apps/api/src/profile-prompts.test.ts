import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const PEOPLE = ['prompt_a', 'prompt_b'];
process.env.REVIEW_EMAILS = PEOPLE.map(p => `${p}@prompt.tablamigo`).join(',');
process.env.REVIEW_CODE = '424242';

const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

let app: Awaited<ReturnType<typeof build>>;
type Api = (method: string, url: string, payload?: unknown) => Promise<import('light-my-request').Response>;

let ip = 600;
async function login(name: string): Promise<Api> {
  const email = `${name}@prompt.tablamigo`;
  const remoteAddress = `10.90.0.${++ip}`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email }, remoteAddress });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' }, remoteAddress });
  expect(r.statusCode).toBe(200);
  const tok = r.json().accessToken as string;
  const call: Api = (method, url, payload) => app.inject({
    method: method as any,
    url,
    payload: payload as any,
    headers: { authorization: `Bearer ${tok}` },
    remoteAddress
  });
  await call('PATCH', '/me', { name, birthdate: '1996-06-06', gender: 'woman', homeCountry: 'de' });
  return call;
}

const idOf = async (name: string) => (await sql`select id from users where email = ${name + '@prompt.tablamigo'}`)[0].id as string;

const u: Record<string, Api> = {};

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like '%@prompt.tablamigo'`;
  for (const p of PEOPLE) u[p] = await login(p);
});

afterAll(async () => {
  await sql`delete from users where email like '%@prompt.tablamigo'`;
  await app.close();
  await sql.end();
});

describe('Profile Prompts & Travel Style', () => {
  it('/meta returns travel styles and prompts lists', async () => {
    const res = await u.prompt_a('GET', '/meta');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.travelStyles).toContain('foodie');
    expect(body.travelStyles).toContain('hiker');
    expect(body.prompts).toContain("Next trip I'm dreaming of…");
  });

  it('can set travel style tags (up to 5) and rejects unknown tags', async () => {
    // Valid tags
    const ok = await u.prompt_a('PATCH', '/me', { travelStyle: ['foodie', 'hiker', 'early bird'] });
    expect(ok.statusCode).toBe(200);

    const me = (await u.prompt_a('GET', '/me')).json();
    expect(me.travelStyle).toEqual(['foodie', 'hiker', 'early bird']);

    // Unknown tag rejected
    const bad = await u.prompt_a('PATCH', '/me', { travelStyle: ['unknown_tag_xyz'] });
    expect(bad.statusCode).toBe(400);
  });

  it('can answer up to 3 prompts, 4th is rejected', async () => {
    const p1 = await u.prompt_a('POST', '/me/prompts', {
      prompt: "Next trip I'm dreaming of…",
      answer: "Exploring the ancient temples of Kyoto in autumn."
    });
    expect(p1.statusCode).toBe(200);
    expect(p1.json().prompt.position).toBe(0);

    const p2 = await u.prompt_a('POST', '/me/prompts', {
      prompt: "Best street food I've had…",
      answer: "Mango sticky rice from a night market in Chiang Mai."
    });
    expect(p2.statusCode).toBe(200);
    expect(p2.json().prompt.position).toBe(1);

    const p3 = await u.prompt_a('POST', '/me/prompts', {
      prompt: "My ideal day on a trip…",
      answer: "Sunrise hike, local coffee, afternoon reading, sunset dinner."
    });
    expect(p3.statusCode).toBe(200);
    expect(p3.json().prompt.position).toBe(2);

    // 4th prompt rejected
    const p4 = await u.prompt_a('POST', '/me/prompts', {
      prompt: "A travel rule I live by…",
      answer: "Never pack more than a carry-on."
    });
    expect(p4.statusCode).toBe(400);
    expect(p4.json().error).toBe('max_prompts_reached');
  });

  it('answering the same prompt updates the existing answer without creating a duplicate', async () => {
    const update = await u.prompt_a('POST', '/me/prompts', {
      prompt: "Next trip I'm dreaming of…",
      answer: "Road trip through Iceland's ring road!"
    });
    expect(update.statusCode).toBe(200);

    const list = (await u.prompt_a('GET', '/me/prompts')).json().prompts;
    expect(list).toHaveLength(3);
    const updated = list.find((x: any) => x.prompt === "Next trip I'm dreaming of…");
    expect(updated.answer).toBe("Road trip through Iceland's ring road!");
  });

  it('reordering prompts updates positions', async () => {
    const list = (await u.prompt_a('GET', '/me/prompts')).json().prompts;
    const reorderedIds = [list[2].id, list[0].id, list[1].id];

    const res = await u.prompt_a('PUT', '/me/prompts/reorder', { promptIds: reorderedIds });
    expect(res.statusCode).toBe(200);

    const after = (await u.prompt_a('GET', '/me/prompts')).json().prompts;
    expect(after[0].id).toBe(list[2].id);
    expect(after[0].position).toBe(0);
    expect(after[1].id).toBe(list[0].id);
    expect(after[1].position).toBe(1);
    expect(after[2].id).toBe(list[1].id);
    expect(after[2].position).toBe(2);
  });

  it('deleting a prompt removes it and reindexes positions', async () => {
    const list = (await u.prompt_a('GET', '/me/prompts')).json().prompts;
    const toDelete = list[0];

    const del = await u.prompt_a('DELETE', `/me/prompts/${toDelete.id}`);
    expect(del.statusCode).toBe(200);

    const remaining = (await u.prompt_a('GET', '/me/prompts')).json().prompts;
    expect(remaining).toHaveLength(2);
    expect(remaining[0].position).toBe(0);
    expect(remaining[1].position).toBe(1);
  });

  it('viewing another profile displays prompts and calculates shared travel styles', async () => {
    // User B sets travel style with overlap ('foodie', 'party')
    await u.prompt_b('PATCH', '/me', { travelStyle: ['foodie', 'party'] });

    const userAId = await idOf('prompt_a');
    const view = (await u.prompt_b('GET', `/users/${userAId}`)).json();

    expect(view.prompts).toHaveLength(2);
    expect(view.travelStyle).toEqual(['foodie', 'hiker', 'early bird']);
    expect(view.sharedTravelStyle).toEqual(['foodie']);
  });
});
