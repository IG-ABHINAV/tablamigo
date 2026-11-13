// Who may call the two billing webhooks. Google Play RTDN (POST /billing/google/rtdn): the URL token or a Google-signed OIDC
// token from the push service account, for this URL. Razorpay (POST /billing/razorpay/webhook, forwarded by Hookpost): an
// HMAC-SHA256 of the exact raw body with TABLAMIGO_FORWARD_SECRET. Google's token check is mocked; everything else is real.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import crypto from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';

const { build } = await import('../../server.js');
const { sql } = await import('../../lib/db.js');
const { config } = await import('../../lib/config.js');

let app: Awaited<ReturnType<typeof build>>;
const saved = { rtdnToken: config.rtdnToken, rtdnPushEmail: config.rtdnPushEmail, isProd: config.isProd, forward: config.razorpay.forwardSecret };
const PUSH = 'rtdn-push@tablamigo-test.iam.gserviceaccount.com';
const AUD = () => `${config.publicUrl}/billing/google/rtdn`;
// A test "OIDC token" is its own payload as JSON; the mock checks the audience the route asks for, as Google's library does.
const oidc = (p: Record<string, unknown>) => JSON.stringify(p);
const verifyIdToken = vi.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockImplementation((async ({ idToken, audience }: { idToken: string; audience: string }) => {
  let p: any; try { p = JSON.parse(idToken); } catch { throw new Error('Wrong number of segments in token'); }
  if (p.aud !== audience) throw new Error('Wrong recipient, payload audience != requiredAudience');
  return { getPayload: () => p };
}) as any);

const ping = { message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.tablamigo.app', testNotification: { version: '1.0' } })).toString('base64'), messageId: '1' }, subscription: 'projects/x/subscriptions/y' };
const rtdn = (opts: { query?: string; bearer?: string } = {}) => app.inject({
  method: 'POST', url: `/billing/google/rtdn${opts.query ?? ''}`, payload: ping,
  headers: opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {},
});

const SECRET = 'whsec-forward-test-secret';
const sign = (raw: string, secret = SECRET) => crypto.createHmac('sha256', secret).update(raw).digest('hex');
const hook = (raw: string, signature?: string | string[]) => app.inject({
  method: 'POST', url: '/billing/razorpay/webhook', payload: raw,
  headers: { 'content-type': 'application/json', ...(signature !== undefined ? { 'x-tablamigo-signature': signature as any } : {}) },
});
const unrelated = JSON.stringify({ event: 'payment.authorized', payload: { payment: { entity: { id: 'pay_x', notes: { service: 'hookpost' } } } } });

beforeAll(async () => { app = await build(); });
afterEach(() => {
  Object.assign(config, { rtdnToken: saved.rtdnToken, rtdnPushEmail: saved.rtdnPushEmail, isProd: saved.isProd });
  config.razorpay.forwardSecret = saved.forward;
});
afterAll(async () => { verifyIdToken.mockRestore(); await app.close(); await sql.end(); });

describe('Google Play RTDN: URL token', () => {
  it('accepts the right token and refuses a wrong or missing one', async () => {
    Object.assign(config, { rtdnToken: 'rtdn-url-token-123', rtdnPushEmail: '' });
    expect((await rtdn({ query: '?token=rtdn-url-token-123' })).json()).toEqual({ ok: true });
    expect((await rtdn({ query: '?token=rtdn-url-token-124' })).statusCode).toBe(401);
    expect((await rtdn({ query: '?token=' })).statusCode).toBe(401);
    expect((await rtdn()).statusCode).toBe(401);
  });
});

describe('Google Play RTDN: OIDC push token', () => {
  const good = () => oidc({ aud: AUD(), email: PUSH, email_verified: true });
  it('accepts a token from the push service account for this URL', async () => {
    Object.assign(config, { rtdnToken: '', rtdnPushEmail: PUSH });
    expect((await rtdn({ bearer: good() })).json()).toEqual({ ok: true });
    expect(verifyIdToken).toHaveBeenLastCalledWith({ idToken: good(), audience: AUD() });
  });

  it.each([
    ['no token', undefined],
    ['another service account', oidc({ aud: AUD(), email: 'attacker@evil.iam.gserviceaccount.com', email_verified: true })],
    ['an unverified email', oidc({ aud: AUD(), email: PUSH, email_verified: false })],
    ['a token for another URL', oidc({ aud: 'https://example.com/billing/google/rtdn', email: PUSH, email_verified: true })],
    ['garbage', 'not-a-jwt'],
  ])('refuses %s', async (_what, bearer) => {
    Object.assign(config, { rtdnToken: '', rtdnPushEmail: PUSH });
    const r = await rtdn({ bearer });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'unauthorized' });
  });

  it('with both configured, either one is enough, and a wrong URL token does not block a good OIDC token', async () => {
    Object.assign(config, { rtdnToken: 'rtdn-url-token-123', rtdnPushEmail: PUSH });
    expect((await rtdn({ query: '?token=rtdn-url-token-123' })).statusCode).toBe(200);
    expect((await rtdn({ query: '?token=wrong', bearer: good() })).statusCode).toBe(200);
    expect((await rtdn({ query: '?token=wrong' })).statusCode).toBe(401);
  });

  // Production fails closed: config.ts refuses to start it without RTDN auth (tests/unit/config-boot.test.ts), and the route
  // refuses every post should both values ever be empty anyway.
  it('production refuses an unauthenticated RTDN post when no RTDN auth is configured', async () => {
    Object.assign(config, { rtdnToken: '', rtdnPushEmail: '', isProd: true });
    try {
      expect((await rtdn()).statusCode).toBe(401);
      expect((await rtdn({ query: '?token=' })).statusCode).toBe(401);
      expect((await rtdn({ bearer: 'not-a-jwt' })).statusCode).toBe(401);
    } finally { config.isProd = false; }
  });

  it('(development only) accepts any post when no RTDN auth is configured: pinned so a change is deliberate', async () => {
    Object.assign(config, { rtdnToken: '', rtdnPushEmail: '', isProd: false });
    expect((await rtdn()).statusCode).toBe(200);
  });
});

describe('Razorpay webhook forwarded by Hookpost: HMAC of the raw body', () => {
  it('accepts the exact body signed with the forward secret', async () => {
    config.razorpay.forwardSecret = SECRET;
    const r = await hook(unrelated, sign(unrelated));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, result: 'ignored' });
  });

  it.each([
    ['no signature', undefined],
    ['an empty signature', ''],
    ['a signature from another secret', sign(unrelated, 'other-secret')],
    ['an upper-case hex signature', sign(unrelated).toUpperCase()],
    ['a truncated signature', sign(unrelated).slice(0, 40)],
    ['two signature headers', [sign(unrelated), sign(unrelated)]],
  ])('refuses %s', async (_what, sig) => {
    config.razorpay.forwardSecret = SECRET;
    const r = await hook(unrelated, sig as any);
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: 'bad_signature' });
  });

  it('refuses a body changed after signing, even by whitespace', async () => {
    config.razorpay.forwardSecret = SECRET;
    const sig = sign(unrelated);
    expect((await hook(unrelated.replace('pay_x', 'pay_y'), sig)).statusCode).toBe(401);
    expect((await hook(unrelated + ' ', sig)).statusCode).toBe(401);
  });

  it('refuses everything while the forward secret is unset (no empty-key HMAC)', async () => {
    config.razorpay.forwardSecret = '';
    expect((await hook(unrelated, sign(unrelated, ''))).statusCode).toBe(401);
  });

  it('a validly signed body that is not JSON is a 400, not a 500', async () => {
    config.razorpay.forwardSecret = SECRET;
    const raw = '{"event": "subscription.cancelled",';
    expect((await hook(raw, sign(raw))).statusCode).toBe(400);
  });
});
