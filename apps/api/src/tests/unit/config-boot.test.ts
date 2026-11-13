// config.ts refuses to boot production with development defaults, and its switches refuse typos. Each case imports a fresh
// copy of config.ts with its own environment (vi.resetModules), so nothing leaks into other files.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const saved = { ...process.env };
const STRONG = 'x'.repeat(40);
const loadConfig = async (env: Record<string, string | undefined>) => {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  return (await import('../../lib/config.js')).config;
};

const restoreEnv = () => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
};
beforeEach(restoreEnv);
afterEach(() => { restoreEnv(); vi.resetModules(); });

describe('production boot guard', () => {
  const prod = { NODE_ENV: 'production', JWT_SECRET: STRONG, RESEND_API_KEY: 're_test_key', REVIEW_EMAILS: '', REVIEW_CODE: '', RTDN_TOKEN: '', RTDN_PUSH_EMAIL: 'rtdn-push@tablamigo-test.iam.gserviceaccount.com' };

  it('boots with a strong JWT secret and a Resend key', async () => {
    const c = await loadConfig(prod);
    expect(c.isProd).toBe(true);
  });

  it('refuses the dev JWT secret, a missing one and a short one', async () => {
    await expect(loadConfig({ ...prod, JWT_SECRET: 'dev-only-secret-change-me' })).rejects.toThrow(/JWT_SECRET/);
    await expect(loadConfig({ ...prod, JWT_SECRET: undefined })).rejects.toThrow(/JWT_SECRET/);
    await expect(loadConfig({ ...prod, JWT_SECRET: 'short-secret' })).rejects.toThrow(/JWT_SECRET/);
  });

  it('refuses a review code shorter than 6 digits while review accounts are listed', async () => {
    await expect(loadConfig({ ...prod, REVIEW_EMAILS: 'reviewer@example.com', REVIEW_CODE: '123' })).rejects.toThrow(/REVIEW_CODE/);
    await expect(loadConfig({ ...prod, REVIEW_EMAILS: 'reviewer@example.com', REVIEW_CODE: '' })).rejects.toThrow(/REVIEW_CODE/);
    expect((await loadConfig({ ...prod, REVIEW_EMAILS: 'reviewer@example.com', REVIEW_CODE: '482913' })).reviewEmails).toEqual(['reviewer@example.com']);
  });

  it('refuses to start without a Resend key (sign-in codes could not be emailed)', async () => {
    await expect(loadConfig({ ...prod, RESEND_API_KEY: '' })).rejects.toThrow(/RESEND_API_KEY/);
  });

  it('refuses to start without Google Play RTDN auth; either the URL token or the push service account is enough', async () => {
    await expect(loadConfig({ ...prod, RTDN_TOKEN: '', RTDN_PUSH_EMAIL: '' })).rejects.toThrow(/RTDN_TOKEN or RTDN_PUSH_EMAIL/);
    await expect(loadConfig({ ...prod, RTDN_TOKEN: undefined, RTDN_PUSH_EMAIL: undefined })).rejects.toThrow(/RTDN/);
    expect((await loadConfig({ ...prod, RTDN_TOKEN: 'url-token', RTDN_PUSH_EMAIL: '' })).rtdnToken).toBe('url-token');
    expect((await loadConfig(prod)).rtdnPushEmail).toBe(prod.RTDN_PUSH_EMAIL);
    expect((await loadConfig({ NODE_ENV: 'development', RTDN_TOKEN: '', RTDN_PUSH_EMAIL: '' })).isProd).toBe(false);
  });

  it('review emails are trimmed and lower-cased; admin emails have no default', async () => {
    const c = await loadConfig({ ...prod, REVIEW_EMAILS: ' A@X.com , b@y.com,', REVIEW_CODE: '482913', ADMIN_EMAILS: undefined });
    expect(c.reviewEmails).toEqual(['a@x.com', 'b@y.com']);
    expect(c.adminEmails).toEqual([]);
  });

  it('CORS: production answers a cross-origin preflight from the website and from nowhere else (server.ts)', async () => {
    await loadConfig(prod);
    const { build } = await import('../../server.js');
    const app = await build();
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const { port } = app.server.address() as import('node:net').AddressInfo;
      const preflight = (origin: string) => fetch(`http://127.0.0.1:${port}/me`, {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'PATCH', 'access-control-request-headers': 'authorization,content-type' },
      });
      const site = await preflight('https://tablamigo.hookstep.in');
      expect(site.status).toBe(204);
      expect(site.headers.get('access-control-allow-origin')).toBe('https://tablamigo.hookstep.in');
      expect(site.headers.get('access-control-allow-methods')).toContain('PATCH');
      for (const other of ['https://evil.example', 'https://tablamigo.hookstep.in.evil.example', 'http://tablamigo.hookstep.in', 'null']) {
        const r = await preflight(other);
        expect(r.headers.get('access-control-allow-origin'), other).toBeNull();
      }
    } finally { await app.close(); }
  });
});

describe('switches refuse typos at boot', () => {
  it('HOST_WELCOME / STARTER_PLANS: off | dry | on, unset is dry', async () => {
    const { parseMode } = await import('../../lib/config.js');
    expect(parseMode('X', undefined)).toBe('dry');
    expect(parseMode('X', ' ON ')).toBe('on');
    expect(() => parseMode('HOST_WELCOME', 'yes')).toThrow(/HOST_WELCOME/);
    await expect(loadConfig({ HOST_WELCOME: 'enabled' })).rejects.toThrow(/HOST_WELCOME/);
    await expect(loadConfig({ HOST_WELCOME: 'off', STARTER_PLANS: 'true' })).rejects.toThrow(/STARTER_PLANS/);
  });

  it('feature flags stay off unless exactly "on"', async () => {
    const c = await loadConfig({ FEATURE_PAID_EVENTS: 'true', FEATURE_ID_VERIFICATION: '1', FEATURE_VOICE_NOTES: 'ON' });
    expect(c.features).toEqual({ paidEvents: false, idVerification: false, voiceNotes: false });
    expect((await loadConfig({ FEATURE_PAID_EVENTS: 'on' })).features.paidEvents).toBe(true);
  });

  it('ANDROID_MIN_VERSION_CODE: unset is no floor, and a typo never silently locks everyone out (or in)', async () => {
    const { parseMinVersionCode } = await import('../../lib/config.js');
    expect(parseMinVersionCode(undefined)).toBe(null);
    expect(parseMinVersionCode('  ')).toBe(null);
    expect(parseMinVersionCode(' 14 ')).toBe(14);
    // 2,100,000,000 is Play's own ceiling for a versionCode: a floor above it could never be met by any build.
    expect(parseMinVersionCode('2100000000')).toBe(2_100_000_000);
    for (const bad of ['0', '-1', '14.0', 'v14', '1.4.1', '1e3', '2100000001', '99999999999999999999']) {
      expect(() => parseMinVersionCode(bad), bad).toThrow(/ANDROID_MIN_VERSION_CODE/);
    }
    expect((await loadConfig({ ANDROID_MIN_VERSION_CODE: '14' })).androidMinVersionCode).toBe(14);
    expect((await loadConfig({ ANDROID_MIN_VERSION_CODE: undefined })).androidMinVersionCode).toBe(null);
    await expect(loadConfig({ ANDROID_MIN_VERSION_CODE: 'latest' })).rejects.toThrow(/ANDROID_MIN_VERSION_CODE/);
  });

  it('EMAIL_JOBS and ACTIVATION_EMAILS', async () => {
    expect((await loadConfig({ EMAIL_JOBS: 'off' })).emailJobs).toBe(false);
    expect((await loadConfig({ EMAIL_JOBS: undefined })).emailJobs).toBe(true);
    expect((await loadConfig({ ACTIVATION_EMAILS: 'dry' })).activationEmails).toBe('dry');
    expect((await loadConfig({ ACTIVATION_EMAILS: 'bogus' })).activationEmails).toBe('on');
  });
});
