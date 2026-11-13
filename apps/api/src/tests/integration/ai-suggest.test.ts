// AI plan ideas (GET /ai/suggest, GET /ai/quota): 3 a day free, 200 Plus, against a mocked OpenAI and geocoder. Covers quota
// exhaustion, what an OpenAI failure costs the person (nothing), and how the model's loose output is cleaned before the app
// posts it straight to POST /activities.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Person } from '../helpers.js';
const D = '@aisuggest.tablamigo';
process.env.REVIEW_EMAILS = ['fia', 'gil', 'hux', 'ivy', 'jax'].map(p => p + D).join(',');
process.env.REVIEW_CODE = '424242';
const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { signIn, onboard } = await import('../helpers.js');

let app: Awaited<ReturnType<typeof build>>;
const realFetch = globalThis.fetch;
let openai: { status: number; content: string } = { status: 200, content: '' };
let openaiCalls = 0;
const IDEAS = [
  { emoji: '🍜', title: 'Street food crawl on Yaowarat', category: 'food|explore', placeName: 'Yaowarat Road', why: 'Chinatown after dark' },
  { emoji: '🌅', title: 'T'.repeat(120), category: 'EXPLORE', placeName: 'Wat Arun', why: 'River view' },
  { emoji: '🎲', title: 'No place given', category: 'other' },
  { emoji: '🍺', title: 'Rooftop drinks', category: 'party', placeName: 'Octave Rooftop', why: 'x'.repeat(300) },
];
const ok = () => { openai = { status: 200, content: JSON.stringify({ ideas: IDEAS }) }; };

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email like ${'%' + D}`;
  config.openaiKey = 'sk-test-ai';
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.openai.com/v1/chat/completions')) {
      openaiCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: openai.content } }] }), { status: openai.status });
    }
    // Photon/Nominatim geocoding: nothing found, so no idea gets coordinates unless a test says so.
    if (/photon|nominatim/.test(url)) return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 });
    return realFetch(input, init);
  }) as typeof fetch;
});
afterEach(() => { ok(); });
afterAll(async () => { globalThis.fetch = realFetch; config.openaiKey = ''; await sql`delete from users where email like ${'%' + D}`; await app.close(); await sql.end(); });

const person = async (name: string) => onboard(await signIn(app, name + D, '424242', 73), { name, gender: 'woman', interests: ['food', 'coffee'] });
const suggest = (p: Person, q = 'city=Bangkok') => p.call('GET', `/ai/suggest?${q}`);
const quota = async (p: Person) => (await p.call('GET', '/ai/quota')).json();

describe('AI plan ideas', () => {
  it('cleans the model output: one known category, titles cut to 80, ideas without a place dropped, max 5', async () => {
    ok();
    const p = await person('fia');
    const r = await suggest(p, 'city=Bangkok&vibe=chill');
    expect(r.statusCode).toBe(200);
    const { ideas, remaining } = r.json();
    expect(remaining).toBe(2);
    expect(ideas.map((i: any) => i.placeName)).toEqual(['Yaowarat Road', 'Wat Arun', 'Octave Rooftop']);
    expect(ideas.map((i: any) => i.category)).toEqual(['food', 'explore', 'other']);
    expect(ideas[1].title).toHaveLength(80);
    expect(ideas[2].why.length).toBeLessThanOrEqual(140);
    for (const i of ideas) { expect(i.lat).toBeUndefined(); expect(i.lng).toBeUndefined(); }
  });

  it('free: 3 a day, then a Plus paywall without calling OpenAI; /ai/quota agrees', async () => {
    ok();
    const p = await person('gil');
    expect(await quota(p)).toEqual({ limit: 3, used: 0, remaining: 3 });
    for (let i = 0; i < 3; i++) expect((await suggest(p)).statusCode).toBe(200);
    expect(await quota(p)).toEqual({ limit: 3, used: 3, remaining: 0 });
    const before = openaiCalls;
    const fourth = await suggest(p);
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json()).toMatchObject({ error: 'plus_required', feature: 'ai_suggestions' });
    expect(openaiCalls).toBe(before);
  });

  it('Plus: 200 a day', async () => {
    const p = await person('hux');
    await sql`update users set comp_until = now() + interval '3 days', plus_until = now() + interval '3 days' where id = ${p.id}`;
    expect(await quota(p)).toEqual({ limit: 200, used: 0, remaining: 200 });
    expect((await suggest(p)).json().remaining).toBe(199);
  });

  it('an OpenAI error is ai_failed and does not use up a suggestion', async () => {
    const p = await person('ivy');
    openai = { status: 500, content: '' };
    const r = await suggest(p);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('ai_failed');
    expect((await quota(p)).used).toBe(0);
  });

  // Until 22 Oct 2026 a reply that wasn't JSON was a 500 server_error ("Something went wrong on our side").
  // An ideas list with no usable idea (each one missing its title or place) was an empty answer that still cost an idea.
  it('a reply that is not JSON, JSON without an ideas list, or a list with no usable idea is ai_failed and uses up nothing', async () => {
    const p = await person('jax');
    for (const content of ['Sorry, I cannot help with that.', '{"ideas": [{"title": "cut off', '{"suggestions": []}', '{"ideas": []}',
      '{"ideas": [{"title": "No place given"}, {"placeName": "Wat Arun"}]}']) {
      openai = { status: 200, content };
      const r = await suggest(p);
      expect(r.statusCode, content).toBe(400);
      expect(r.json().error, content).toBe('ai_failed');
    }
    expect((await quota(p)).used).toBe(0);
  });

  it('without an OpenAI key: ai_not_configured', async () => {
    const p = await person('jax');
    config.openaiKey = '';
    try { expect((await suggest(p)).json().error).toBe('ai_not_configured'); } finally { config.openaiKey = 'sk-test-ai'; }
  });

  it('validates the query', async () => {
    const p = await person('jax');
    expect((await suggest(p, '')).statusCode).toBe(400);
    expect((await suggest(p, `city=${'x'.repeat(81)}`)).statusCode).toBe(400);
    expect((await suggest(p, 'city=Goa&lat=91&lng=0')).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/ai/suggest?city=Goa' })).statusCode).toBe(401);
  });
});
