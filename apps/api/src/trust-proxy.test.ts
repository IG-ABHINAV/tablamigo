// The client IP every rate limit keys on (audit-2026-10-03 review). The API trusts one hop, nginx on loopback;
// Cloudflare's ranges (which include Workers egress) must NOT be trusted, or a Worker can forge X-Forwarded-For.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const { parseTrustProxy, config } = await import('./lib/config.js');
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');

describe('parseTrustProxy', () => {
  it('defaults to loopback only, with no Cloudflare range in it', () => {
    expect(parseTrustProxy(undefined)).toEqual(['loopback']);
    expect(parseTrustProxy('')).toEqual(['loopback']);
    expect(config.trustProxy).toEqual(['loopback']);
  });
  it("maps 'true'/'false' to booleans and digits to a hop count instead of crashing or becoming an address", () => {
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy(' FALSE ')).toBe(false);
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });
  it('accepts IPs, CIDRs and the named keywords', () => {
    expect(parseTrustProxy('loopback, 10.0.0.0/8 ,2a06:98c0::/29,203.0.113.7')).toEqual(['loopback', '10.0.0.0/8', '2a06:98c0::/29', '203.0.113.7']);
  });
  it.each(['yes', 'on', 'cloudflare', '10.0.0.0/33', '::1/129', '1.2.3.4/8/9', '300.1.1.1', 'loopback,nonsense', ',', '-1'])('refuses %j at startup with a clear error', bad => {
    expect(() => parseTrustProxy(bad)).toThrow(/Invalid TRUST_PROXY/);
  });
});

describe('req.ip behind nginx', () => {
  let app: Awaited<ReturnType<typeof build>>;
  beforeAll(async () => {
    app = await build();
    app.get('/__ip', async req => ({ ip: req.ip }));
  });
  afterAll(async () => { await app.close(); });
  const ipFor = async (remoteAddress: string, xff?: string) =>
    (await app.inject({ method: 'GET', url: '/__ip', remoteAddress, headers: xff ? { 'x-forwarded-for': xff } : {} })).json().ip as string;

  it('takes the single address nginx wrote when the peer is the local nginx', async () => {
    expect(await ipFor('127.0.0.1', '198.51.100.9')).toBe('198.51.100.9');
    expect(await ipFor('::1', '2001:db8::5')).toBe('2001:db8::5');
  });

  it('exploit: a request arriving straight from Cloudflare Workers egress cannot choose its IP with X-Forwarded-For', async () => {
    // 2a06:98c0::/29 is Cloudflare Workers egress. It used to be a trusted proxy, so this forged entry became req.ip.
    expect(await ipFor('2a06:98c0::1234', '6.6.6.6')).toBe('2a06:98c0::1234');
    expect(await ipFor('2a06:98c0::1234', '6.6.6.6, 7.7.7.7')).toBe('2a06:98c0::1234');
  });

  it('exploit: any other Cloudflare edge address is not trusted by the API either (nginx is the only hop)', async () => {
    expect(await ipFor('172.64.1.1', '6.6.6.6')).toBe('172.64.1.1');
    expect(await ipFor('2606:4700::1', '6.6.6.6')).toBe('2606:4700::1');
  });

  it('exploit: nginx writes one value, so a client-supplied chain in front of it is not read as the client', async () => {
    // With nginx's proxy_set_header X-Forwarded-For $remote_addr the header is a single address. If a chain ever
    // arrives from loopback anyway, the rightmost untrusted entry wins, never the leftmost the client wrote.
    expect(await ipFor('127.0.0.1', '6.6.6.6, 198.51.100.9')).toBe('198.51.100.9');
  });

  it('exploit: the per-IP rate limit counts the real peer, not the forged header (login codes, a new email each time)', async () => {
    const hit = (i: number) => app.inject({ method: 'POST', url: '/auth/email/start', payload: { email: `nobody${i}@trustproxy.tablamigo` }, remoteAddress: '2a06:98c0::77', headers: { 'x-forwarded-for': `9.9.${i}.1` } });
    const errors: string[] = [];
    for (let i = 0; i < 8; i++) { const r = await hit(i); if (r.statusCode === 429) errors.push(r.json().error); }
    // The forged addresses all collapse onto the one real peer, so the limiter (5 per 10 minutes) trips.
    // Before, each forged address got its own bucket and nothing was ever limited.
    expect(errors).toContain('rate_limited');
  });
});

afterAll(async () => { await sql.end(); });

describe('TRUST_PROXY forms reach Fastify', () => {
  const ipWith = async (value: boolean | number | string[], remoteAddress: string, xff: string) => {
    const saved = config.trustProxy;
    config.trustProxy = value;
    const app = await build();
    try {
      app.get('/__ip', async req => ({ ip: req.ip }));
      return (await app.inject({ method: 'GET', url: '/__ip', remoteAddress, headers: { 'x-forwarded-for': xff } })).json().ip as string;
    } finally { await app.close(); config.trustProxy = saved; }
  };
  it('a hop count of 1 trusts only the direct peer, false trusts nobody, true trusts the whole chain', async () => {
    expect(await ipWith(1, '10.1.1.1', '6.6.6.6, 7.7.7.7')).toBe('7.7.7.7');
    expect(await ipWith(false, '10.1.1.1', '6.6.6.6')).toBe('10.1.1.1');
    expect(await ipWith(true, '10.1.1.1', '6.6.6.6, 7.7.7.7')).toBe('6.6.6.6');
  });
});
