// AI moderation of group and city chats (lib/moderation.ts) against a mocked OpenAI. It fails open by design: no key, an
// error or a slow answer lets the message through, so chat never stops when OpenAI does. These tests pin that, and pin which
// categories block.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../../lib/config.js';
import { isBlocked, assertClean } from '../../lib/moderation.js';

const answer = (categories: Record<string, boolean>, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify({ results: [{ flagged: Object.values(categories).some(Boolean), categories }] }), { status }));

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; config.openaiKey = 'sk-unit-test'; vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { globalThis.fetch = realFetch; config.openaiKey = ''; vi.restoreAllMocks(); });

describe('isBlocked', () => {
  it.each(['harassment', 'harassment/threatening', 'hate', 'hate/threatening', 'sexual', 'sexual/minors', 'violence/graphic', 'self-harm/instructions'])(
    'blocks %s', async cat => {
      globalThis.fetch = answer({ [cat]: true }) as any;
      expect(await isBlocked('text')).toBe(true);
    });

  it.each(['violence', 'self-harm', 'self-harm/intent', 'illicit'])('lets %s through (travel talk: "that hike nearly killed me")', async cat => {
    globalThis.fetch = answer({ [cat]: true }) as any;
    expect(await isBlocked('text')).toBe(false);
  });

  it('sends the text to the moderations endpoint with the key, and nothing else', async () => {
    const f = answer({});
    globalThis.fetch = f as any;
    await isBlocked('hello there');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.openai.com/v1/moderations');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-unit-test');
    expect(JSON.parse(String(init.body))).toEqual({ model: 'omni-moderation-latest', input: 'hello there' });
  });

  it('fails open without a key (no request made)', async () => {
    config.openaiKey = '';
    const f = vi.fn();
    globalThis.fetch = f as any;
    expect(await isBlocked('anything')).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('fails open on OpenAI 5xx, 429, a network error, bad JSON and an empty result', async () => {
    for (const status of [500, 503, 429, 401]) {
      globalThis.fetch = answer({ harassment: true }, status) as any;
      expect(await isBlocked('x'), `HTTP ${status}`).toBe(false);
    }
    globalThis.fetch = vi.fn(async () => { throw new TypeError('fetch failed'); }) as any;
    expect(await isBlocked('x')).toBe(false);
    globalThis.fetch = vi.fn(async () => new Response('not json', { status: 200 })) as any;
    expect(await isBlocked('x')).toBe(false);
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 200 })) as any;
    expect(await isBlocked('x')).toBe(false);
  });

  it('gives up after 2.5 s (a hung OpenAI never holds a chat message)', async () => {
    globalThis.fetch = vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('timeout', 'TimeoutError')));
    })) as any;
    const t0 = Date.now();
    expect(await isBlocked('x')).toBe(false);
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(2400);
    expect(took).toBeLessThan(15_000);   // generous: a loaded CI box; without the timeout this would hang until the test's 30 s
  });
});

describe('assertClean', () => {
  it('throws message_blocked (400) when flagged, and checks every text in one request', async () => {
    const f = answer({ hate: true });
    globalThis.fetch = f as any;
    await expect(assertClean('poll question', 'option a')).rejects.toMatchObject({ status: 400, code: 'message_blocked' });
    expect(JSON.parse(String((f.mock.calls[0] as any)[1].body)).input).toBe('poll question\noption a');
  });

  it('passes clean text', async () => {
    globalThis.fetch = answer({ harassment: false }) as any;
    await expect(assertClean('see you at 7')).resolves.toBeUndefined();
  });
});
