// Push routing: FCM for android/ios tokens, Web Push for browser subscriptions. Both senders are mocked.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { sendNotification, fcmRequest } = vi.hoisted(() => ({ sendNotification: vi.fn(async () => ({})), fcmRequest: vi.fn(async () => ({ data: {} })) }));
vi.mock('web-push', () => ({ default: { sendNotification } }));
vi.mock('google-auth-library', async orig => ({ ...(await orig<any>()), GoogleAuth: class { async getClient() { return { request: fcmRequest }; } } }));
const sa = path.join(os.tmpdir(), `tablamigo-fcm-${process.pid}.json`);
fs.writeFileSync(sa, JSON.stringify({ project_id: 'fcm-test' }));
process.env.FIREBASE_SERVICE_ACCOUNT_JSON = sa;
process.env.WEBPUSH_PUBLIC_KEY = 'BPublicKeyForTests';
process.env.WEBPUSH_PRIVATE_KEY = 'private-key-for-tests';
process.env.REVIEW_EMAILS = 'gus@push.tablamigo';
process.env.REVIEW_CODE = '424242';
const { build } = await import('./server.js');
const { sql } = await import('./lib/db.js');
const { notify } = await import('./lib/push.js');

let app: Awaited<ReturnType<typeof build>>;
const SUB = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc123', expirationTime: null, keys: { auth: 'authsecret123', p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM' } };

async function login(email: string) {
  await app.inject({ method: 'POST', url: '/auth/email/start', payload: { email } });
  const r = await app.inject({ method: 'POST', url: '/auth/email/verify', payload: { email, code: '424242' } });
  const tok = r.json().accessToken as string;
  return (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${tok}` } });
}

beforeAll(async () => { app = await build(); await sql`delete from users where email like '%@push.tablamigo'`; });
afterAll(async () => { await sql`delete from users where email like '%@push.tablamigo'`; await app.close(); await sql.end(); fs.rmSync(sa, { force: true }); });

describe('push', () => {
  it('serves the VAPID key and stores web subscriptions in one canonical shape', async () => {
    expect((await app.inject({ method: 'GET', url: '/push/vapid-public-key' })).json()).toEqual({ key: 'BPublicKeyForTests' });
    const gus = await login('gus@push.tablamigo');
    expect((await gus('POST', '/me/push-token', { token: 'not json at all', platform: 'web' })).json().error).toBe('bad_subscription');
    expect((await gus('POST', '/me/push-token', { token: JSON.stringify({ ...SUB, endpoint: 'http://evil.test/x' }), platform: 'web' })).json().error).toBe('bad_subscription');
    expect((await gus('POST', '/me/push-token', { token: JSON.stringify(SUB), platform: 'web' })).json().ok).toBe(true);
    // re-registering the same subscription (keys in another order) does not add a row
    expect((await gus('POST', '/me/push-token', { token: JSON.stringify({ keys: { p256dh: SUB.keys.p256dh, auth: SUB.keys.auth }, endpoint: SUB.endpoint }), platform: 'web' })).json().ok).toBe(true);
    expect((await gus('POST', '/me/push-token', { token: 'android-fcm-token-123', platform: 'android' })).json().ok).toBe(true);
    const rows = await sql`select token, platform from push_tokens t join users u on u.id = t.user_id where u.email = 'gus@push.tablamigo' order by platform`;
    expect(rows).toEqual([
      { token: 'android-fcm-token-123', platform: 'android' },
      { token: JSON.stringify({ endpoint: SUB.endpoint, keys: { p256dh: SUB.keys.p256dh, auth: SUB.keys.auth } }), platform: 'web' },
    ]);
  });

  it('notify sends FCM to android and Web Push to browsers, and drops gone subscriptions', async () => {
    const [u] = await sql`select id from users where email = 'gus@push.tablamigo'`;
    await notify([u.id], { title: 'Dana', body: 'See you at 8', data: { chatId: 'chat-1' }, tag: 'chat-1' });
    expect(fcmRequest).toHaveBeenCalledTimes(1);
    expect((fcmRequest.mock.calls[0] as any)[0]).toMatchObject({ url: 'https://fcm.googleapis.com/v1/projects/fcm-test/messages:send', data: { message: { token: 'android-fcm-token-123', data: { chatId: 'chat-1' } } } });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    const [sub, payload, opts] = sendNotification.mock.calls[0] as any;
    expect(sub).toEqual({ endpoint: SUB.endpoint, keys: { p256dh: SUB.keys.p256dh, auth: SUB.keys.auth } });
    expect(JSON.parse(payload)).toEqual({ title: 'Dana', body: 'See you at 8', data: { chatId: 'chat-1' }, tag: 'chat-1' });
    expect(opts.vapidDetails).toEqual({ subject: 'mailto:support@hookstep.in', publicKey: 'BPublicKeyForTests', privateKey: 'private-key-for-tests' });

    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    await notify([u.id], { title: 'Dana', body: 'Again' });
    expect((await sql`select platform from push_tokens where user_id = ${u.id}`).map(r => r.platform)).toEqual(['android']);
    const gone = await sql`select properties from analytics_events where user_id = ${u.id} and event_name = 'push_token_gone'`;
    expect(gone.map(g => g.properties)).toEqual([{ platform: 'web' }]);
  });
});
