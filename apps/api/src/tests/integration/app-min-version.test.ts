// GET /app/min-version: the one thing the Android app asks before anyone has signed in (apps/mobile/src/lib/update-prompt.ts).
// It must answer the same number to everyone, signed in or not, and nothing else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
const { build } = await import('../../server.js');
const { config } = await import('../../lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
const saved = config.androidMinVersionCode;

beforeAll(async () => { app = await build(); });
afterAll(async () => { config.androidMinVersionCode = saved; await app.close(); });

describe('GET /app/min-version', () => {
  it('answers null while no floor is set, which is how it normally stands', async () => {
    config.androidMinVersionCode = null;
    const r = await app.inject({ method: 'GET', url: '/app/min-version' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ androidMinVersionCode: null });
  });

  it('answers the floor once one is set, and says nothing else', async () => {
    config.androidMinVersionCode = 14;
    const r = await app.inject({ method: 'GET', url: '/app/min-version' });
    expect(r.json()).toEqual({ androidMinVersionCode: 14 });
    expect(Object.keys(r.json())).toEqual(['androidMinVersionCode']);
  });

  it('needs no sign-in and refuses nobody: an app that cannot read it never forces an update', async () => {
    config.androidMinVersionCode = 14;
    const anon = await app.inject({ method: 'GET', url: '/app/min-version' });
    const bogus = await app.inject({ method: 'GET', url: '/app/min-version', headers: { authorization: 'Bearer not-a-token' } });
    expect(anon.statusCode).toBe(200);
    expect(bogus.statusCode).toBe(200);
    expect(bogus.json()).toEqual(anon.json());
  });

  it('is cacheable for five minutes, so a cold start costs Play nothing', async () => {
    const r = await app.inject({ method: 'GET', url: '/app/min-version' });
    expect(r.headers['cache-control']).toBe('public, max-age=300');
  });
});
