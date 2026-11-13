// AI plan ideas: coordinates only from a real geocoder hit near the user, and the daily quota the map checks first.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
process.env.REVIEW_EMAILS = 'ida@ai.tablamigo';
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { config } = await import('./lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
let call: (method: string, url: string) => Promise<import('light-my-request').Response>;
const BKK = { lat: 13.7466, lng: 100.5346 };

const IDEAS = [
  { emoji: '🍜', title: 'Street food crawl', category: 'food', placeName: 'Yaowarat Road', why: 'Chinatown at night' },
  { emoji: '🌅', title: 'Sunset drinks', category: 'drinks|nightlife', placeName: 'Far Away Bar', why: 'Rooftop' },
  { emoji: '🏛️', title: 'Temple walk', category: 'culture', placeName: 'Nowhere Temple', why: 'Quiet' },
];
// OpenAI returns the ideas; Photon finds Yaowarat in Bangkok, "Far Away Bar" only in Chiang Mai, and nothing for the temple.
function fakeFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.hostname === 'api.openai.com') return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ ideas: IDEAS }) } }] }));
    if (url.hostname === 'photon.komoot.io') {
      const q = url.searchParams.get('q');
      const at = q === 'Yaowarat Road' ? [100.5096, 13.7398] : q === 'Far Away Bar' ? [98.9853, 18.7883] : null;
      return new Response(JSON.stringify({ features: at ? [{ geometry: { coordinates: at }, properties: { name: q } }] : [] }));
    }
    throw new Error(`unexpected fetch ${url.hostname}`);
  });
}

beforeAll(async () => {
  app = await build();
  await sql`delete from users where email = 'ida@ai.tablamigo'`;
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email: 'ida@ai.tablamigo' }, remoteAddress: '10.66.0.1' });
  const tok = (await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email: 'ida@ai.tablamigo', code: '424242' }, remoteAddress: '10.66.0.1' })).json().accessToken;
  call = (method, url) => app.inject({ method: method as any, url, headers: { authorization: `Bearer ${tok}` }, remoteAddress: '10.66.0.1' });
});
afterAll(async () => { await sql`delete from users where email = 'ida@ai.tablamigo'`; config.openaiKey = ''; await app.close(); await sql.end(); });

describe('AI ideas on the map', () => {
  it('pins ideas only where the geocoder finds the place nearby, and counts the free quota', async () => {
    config.openaiKey = 'sk-test';
    const f = fakeFetch();
    expect((await call('GET', '/ai/quota')).json()).toEqual({ limit: 3, used: 0, remaining: 3 });

    const r = (await call('GET', `/ai/suggest?city=Bangkok&lat=${BKK.lat}&lng=${BKK.lng}`)).json();
    expect(r.remaining).toBe(2);
    expect(r.ideas).toHaveLength(3);
    expect(r.ideas[0]).toMatchObject({ title: 'Street food crawl', lat: 13.7398, lng: 100.5096 });
    // 600 km away and not found: no coordinates, nothing invented
    expect(r.ideas[1]).toMatchObject({ category: 'drinks' });
    expect(r.ideas[1].lat).toBeUndefined();
    expect(r.ideas[2].lat).toBeUndefined();

    // without a position no geocoding happens at all
    const calls = f.mock.calls.length;
    const plain = (await call('GET', '/ai/suggest?city=Bangkok')).json();
    expect(plain.ideas.every((i: any) => i.lat === undefined)).toBe(true);
    expect(f.mock.calls.length).toBe(calls + 1);

    await call('GET', '/ai/suggest?city=Bangkok');
    expect((await call('GET', '/ai/quota')).json()).toEqual({ limit: 3, used: 3, remaining: 0 });
    const over = await call('GET', '/ai/suggest?city=Bangkok');
    expect(over.statusCode).toBe(402);
    expect(over.json()).toMatchObject({ error: 'plus_required', feature: 'ai_suggestions' });
    f.mockRestore();
  });
});
