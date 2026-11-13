// Security headers on the API's responses and the CSP report sink (lib/security-headers.ts, server.ts), through the real app.
// Proven: every kind of response (JSON, 404, 400, 429-free error path, HTML email pages, media errors, a 204) carries the
// headers; HTML pages get the policy that lets their inline style and logo render and nothing else; HSTS only in production;
// a header a route set itself is kept; /csp-report takes both report formats, logs one short line per report without query
// strings, answers 204, refuses an oversized body and is rate-limited.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');
const { API_CSP, HTML_CSP, HSTS, cspSink } = await import('../../lib/security-headers.js');

let app: Awaited<ReturnType<typeof build>>;
beforeAll(async () => { app = await build(); });
afterAll(async () => { await app.close(); await sql.end(); });

const base = (h: Record<string, unknown>) => {
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['referrer-policy']).toBe('no-referrer');
  expect(h['x-frame-options']).toBe('DENY');
};
let ipN = 0;
const ip = () => `10.177.${Math.floor(++ipN / 250)}.${ipN % 250 + 1}`;

describe('security headers', () => {
  it('JSON (200), 404, 401 and 400 responses all carry them, with the strict API policy', async () => {
    for (const [method, url, status] of [['GET', '/health', 200], ['GET', '/no-such-route', 404], ['GET', '/me', 401], ['POST', '/auth/email/start', 400]] as const) {
      const r = await app.inject({ method, url, payload: method === 'POST' ? { email: 'not-an-email' } : undefined, remoteAddress: ip() });
      expect(r.statusCode, url).toBe(status);
      base(r.headers);
      expect(r.headers['content-security-policy'], url).toBe(API_CSP);
      expect(r.headers['strict-transport-security'], url).toBeUndefined();   // not production
    }
  });

  it('the HTML email-link pages get a policy that allows their inline style and logo, nothing else', async () => {
    const r = await app.inject({ method: 'GET', url: '/alerts/off?t=bogus', remoteAddress: ip() });
    expect(r.statusCode).toBe(400);
    expect(r.headers['content-type']).toMatch(/^text\/html/);
    base(r.headers);
    expect(r.headers['content-security-policy']).toBe(HTML_CSP);
    expect(r.body).toMatch(/<style>/);
    expect(r.body).toContain('src="https://tablamigo.hookstep.in/icon-192.png"');
    expect(HTML_CSP).toContain("style-src 'unsafe-inline'");
    expect(HTML_CSP).toContain('img-src https://tablamigo.hookstep.in');
    expect(HTML_CSP).not.toMatch(/script-src/);   // default-src 'none' covers scripts
  });

  it('HSTS for a year in production, without includeSubDomains', async () => {
    const saved = config.isProd;
    (config as any).isProd = true;
    try {
      const r = await app.inject({ method: 'GET', url: '/health', remoteAddress: ip() });
      expect(r.headers['strict-transport-security']).toBe(HSTS);
      expect(HSTS).toBe('max-age=31536000');
    } finally { (config as any).isProd = saved; }
  });

  it("keeps a header a route set itself (the media route's nosniff) and adds the rest", async () => {
    const r = await app.inject({ method: 'GET', url: '/media/../../etc/passwd', remoteAddress: ip() });
    expect(r.statusCode).toBeGreaterThanOrEqual(400);
    base(r.headers);
    expect(String(r.headers['x-content-type-options']).split(',')).toHaveLength(1);
  });
});

describe('POST /csp-report', () => {
  const report = (over: Record<string, unknown> = {}) => ({ 'csp-report': {
    'document-uri': 'https://tablamigo.hookstep.in/app/chat/123?token=secret#x', 'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://evil.example/x.js?session=abc', disposition: 'report', ...over } });

  it('report-uri format: 204, one short log line, no query string or fragment', async () => {
    const warn = vi.spyOn(cspSink, 'write');
    try {
      const r = await app.inject({ method: 'POST', url: '/csp-report', headers: { 'content-type': 'application/csp-report' }, payload: JSON.stringify(report()), remoteAddress: ip() });
      expect(r.statusCode).toBe(204);
      base(r.headers);
      const lines = warn.mock.calls.map(c => String(c[1])).filter(l => l.startsWith('csp '));
      expect(lines).toEqual(['csp report-only: script-src-elem blocked https://evil.example on tablamigo.hookstep.in/app/chat/123']);
      expect(lines.join()).not.toMatch(/secret|abc|#x/);
    } finally { warn.mockRestore(); }
  });

  it('Reporting API format (several reports, other types ignored) and inline/eval keywords', async () => {
    const warn = vi.spyOn(cspSink, 'write');
    try {
      const body = [
        { type: 'csp-violation', body: { documentURL: 'https://tablamigo.hookstep.in/', effectiveDirective: 'script-src-elem', blockedURL: 'inline', disposition: 'report' } },
        { type: 'deprecation', body: { message: 'x' } },
        { type: 'csp-violation', body: { documentURL: 'https://tablamigo.hookstep.in/app/', effectiveDirective: 'frame-ancestors', blockedURL: 'https://framer.example/p', disposition: 'enforce' } },
      ];
      const r = await app.inject({ method: 'POST', url: '/csp-report', headers: { 'content-type': 'application/reports+json' }, payload: JSON.stringify(body), remoteAddress: ip() });
      expect(r.statusCode).toBe(204);
      expect(warn.mock.calls.map(c => String(c[1])).filter(l => l.startsWith('csp '))).toEqual([
        'csp report-only: script-src-elem blocked inline on tablamigo.hookstep.in/',
        'csp enforced: frame-ancestors blocked https://framer.example on tablamigo.hookstep.in/app/',
      ]);
    } finally { warn.mockRestore(); }
  });

  it('junk is answered 204 and logs nothing; an oversized body is refused', async () => {
    const warn = vi.spyOn(cspSink, 'write');
    try {
      for (const [type, payload] of [['application/csp-report', 'not json'], ['application/json', '{"a":1}'], ['application/reports+json', '[]']]) {
        const r = await app.inject({ method: 'POST', url: '/csp-report', headers: { 'content-type': type }, payload, remoteAddress: ip() });
        expect(r.statusCode, payload).toBe(204);
      }
      expect(warn.mock.calls.filter(c => String(c[1]).startsWith('csp '))).toEqual([]);
    } finally { warn.mockRestore(); }
    const big = await app.inject({ method: 'POST', url: '/csp-report', headers: { 'content-type': 'application/csp-report' }, payload: JSON.stringify(report({ 'script-sample': 'x'.repeat(20_000) })), remoteAddress: ip() });
    expect(big.statusCode).toBe(413);
  });

  it('is rate-limited per address (30 a minute)', async () => {
    const from = ip();
    const codes: number[] = [];
    for (let i = 0; i < 32; i++) codes.push((await app.inject({ method: 'POST', url: '/csp-report', headers: { 'content-type': 'application/csp-report' }, payload: JSON.stringify(report()), remoteAddress: from })).statusCode);
    expect(codes.slice(0, 30).every(c => c === 204)).toBe(true);
    expect(codes.slice(30)).toEqual([429, 429]);
  });
});
