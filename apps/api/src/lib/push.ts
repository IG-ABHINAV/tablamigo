import fs from 'node:fs';
import { GoogleAuth } from 'google-auth-library';
import webpush from 'web-push';
import { config } from './config.js';
import { sql } from './db.js';

// Firebase Cloud Messaging (HTTP v1). Off until FIREBASE_SERVICE_ACCOUNT_JSON points at a
// service-account key with FCM rights on the Firebase project whose google-services.json is in
// the app. FIREBASE_PROJECT_ID names that project when the key lives in another one.
let auth: GoogleAuth | null = null;
let projectId = '';
function fcm() {
  if (!config.firebaseServiceAccount) return null;
  if (!auth) {
    const creds = JSON.parse(fs.readFileSync(config.firebaseServiceAccount, 'utf8'));
    projectId = config.firebaseProjectId || creds.project_id;
    auth = new GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/firebase.messaging'] });
  }
  return auth;
}

type Push = { title: string; body: string; data?: Record<string, string>; tag?: string };
const webOn = () => !!(config.webPush.publicKey && config.webPush.privateKey);

/** Fire-and-forget: never let a push failure break the request that caused it. */
export function notify(userIds: string[], p: Push) {
  if (!userIds.length || (!fcm() && !webOn())) return Promise.resolve();
  return send(userIds, p).catch(e => console.error('push failed', e?.message));
}

async function send(userIds: string[], p: Push) {
  const tokens = await sql`select token, platform from push_tokens where user_id in ${sql(userIds)}`;
  const client = fcm() && tokens.some(t => t.platform !== 'web') ? await fcm()!.getClient() : null;
  await Promise.all(tokens.map(async ({ token, platform }) => {
    if (platform === 'web') return webOn() && sendWeb(token, p);
    if (!client) return;
    try {
      await client.request({
        method: 'POST',
        url: `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`,
        data: { message: {
          token,
          notification: { title: p.title, body: p.body },
          data: p.data ?? {},
          // Same tag = newer message replaces the older one for that chat.
          android: { priority: 'high', notification: { channel_id: 'default', tag: p.tag, color: '#FF5A36' } },
        } },
      });
    } catch (e: any) {
      const code = e?.response?.data?.error?.details?.[0]?.errorCode ?? e?.response?.status;
      if (code === 'UNREGISTERED' || code === 404) await forget(token);
      else throw e;
    }
  }));
}

// Web tokens are the browser's PushSubscription JSON; the service worker shows {title, body, data, tag}.
async function sendWeb(token: string, p: Push) {
  const { publicKey, privateKey, subject } = config.webPush;
  try {
    await webpush.sendNotification(JSON.parse(token), JSON.stringify({ title: p.title, body: p.body, data: p.data ?? {}, tag: p.tag }),
      { vapidDetails: { subject, publicKey, privateKey }, TTL: 86400, urgency: 'high' });
  } catch (e: any) {
    if (e?.statusCode === 404 || e?.statusCode === 410) await forget(token);
    else throw e;
  }
}

// FCM or the browser says this device takes no more pushes: almost always the app was uninstalled (or the site's
// permission withdrawn). The token goes; a push_token_gone event stays, so an account with no token can be told apart:
// had one and lost it (uninstalled) or never sent one (said no to the prompt, or the phone gave none; the app reports that
// as push_registration).
async function forget(token: string) {
  const [gone] = await sql`delete from push_tokens where token = ${token} returning user_id, platform`;
  if (gone) await sql`insert into analytics_events (user_id, event_name, properties)
    values (${gone.userId}, 'push_token_gone', ${sql.json({ platform: gone.platform })})`.catch(() => {});
}
