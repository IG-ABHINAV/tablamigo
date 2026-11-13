import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { issueTokens, sha256, requireUser, newLoginCode, storeLoginCode, unsendLoginCode, checkLoginCode, consumeLoginCode, RESEND_COOLDOWN_SEC } from '../lib/auth.js';
import { sendLoginCode } from '../lib/mail.js';
import { config } from '../lib/config.js';
import { HttpError } from '../lib/errors.js';
import { verifyGoogleIdToken } from '../lib/google-signin.js';
import { grantLaunchPlus } from '../lib/play.js';
import { looksLikeTeamName } from '../lib/team-identity.js';
import { autoRedeemAtSignup, refCodeFrom } from '../lib/referral.js';
import { attributeAtSignup } from '../lib/affiliate-ledger.js';

import type { FastifyRequest } from 'fastify';

/**
 * The Play Store install referrer the Android app sends with the sign-in that creates the account ("utm_source=invite&utm_medium=
 * app&utm_campaign=…", or Play's "utm_source=google-play&utm_medium=organic"): its utm_* values, when the body has none of its
 * own. Without it every Android sign-up read 'Google Play' with no campaign, so neither the Meta ad nor invites could be seen.
 */
export function installReferrerUtm(raw: unknown): Record<string, string> {
  if (typeof raw !== 'string' || !raw) return {};
  const out: Record<string, string> = {};
  try {
    for (const [k, v] of new URLSearchParams(raw.slice(0, 500))) if (/^utm_(source|medium|campaign|content|term)$/.test(k) && v) out[k] = v.slice(0, 100);
  } catch { /* not a query string */ }
  if (out.utm_source === 'google-play') out.utm_source = 'Google Play';   // Play's own value for an organic install, same label as before
  return out;
}

function parseAttribution(req: FastifyRequest, extra?: Record<string, any>) {
  const ir = installReferrerUtm(extra?.install_referrer);
  extra = { ...ir, ...Object.fromEntries(Object.entries(extra ?? {}).filter(([, v]) => v != null && v !== '')) };
  const ua = ((req.headers['user-agent'] as string) || '').toLowerCase();
  const ref = ((req.headers['referer'] as string) || extra?.referrer || extra?.ref || '').toString();
  const country = ((req.headers['cf-ipcountry'] as string) || '').toString();
  const rawIp = ((req.headers['x-forwarded-for'] as string) || req.ip || '').toString();
  const ip = rawIp.split(',')[0].trim();

  let source = extra?.utm_source || 'Direct';
  let medium = extra?.utm_medium || 'web';
  let device = 'Web';

  if (ua.includes('okhttp') || ua.includes('android')) {
    device = 'Android';
    if (!extra?.utm_source) {
      source = 'Google Play';
      medium = 'app';
    }
  } else if (ua.includes('iphone') || ua.includes('ipad')) {
    device = 'iOS';
  } else if (ua.includes('windows')) {
    device = 'Web (Windows)';
  } else if (ua.includes('macintosh')) {
    device = 'Web (Mac)';
  }

  if (ref.includes('linkedin.com')) {
    source = 'LinkedIn';
    medium = 'social';
  } else if (ref.includes('google.com') || ref.includes('google.')) {
    source = 'Google Search';
    medium = 'organic';
  } else if (ref.includes('instagram.com') || ref.includes('facebook.com')) {
    source = 'Meta / Instagram';
    medium = 'social';
  } else if (ref.includes('reddit.com')) {
    source = 'Reddit';
    medium = 'social';
  }

  return {
    source: extra?.utm_source || source,
    medium: extra?.utm_medium || medium,
    campaign: extra?.utm_campaign || null,
    referrer: ref || null,
    landing: typeof extra?.landing === 'string' ? extra.landing.slice(0, 300) : null,
    // The invite code the person arrived with (invite page -> Play referrer `ref`, or the web app's `?ref=`): redeemed at sign-up.
    refCode: refCodeFrom(extra),
    installReferrer: typeof extra?.install_referrer === 'string' ? extra.install_referrer.slice(0, 500) : null,
    device,
    country: country || null,
    ip: ip || null,
  };
}

/** Signs in the account for an already-proven email, creating it on first sign-in. Email code and Google share this,
 *  so a person who signed up one way and comes back the other lands in the same account. Never the Tablamigo Host team
 *  account (users.account_kind 'team', lib/host.ts): nobody signs in as it, whatever proves the address. */
async function signInByEmail(e: string, name?: string, attribution?: Record<string, any>) {
  let [user] = await sql`select id, onboarded, deleted_at, banned_at, attribution, account_kind from users where email = ${e}`;
  if (user?.accountKind === 'team') throw new HttpError(403, 'team_account');
  if (user?.bannedAt) throw new HttpError(403, 'banned');
  // A Google name only prefills onboarding; one that reads like the team account's (lib/team-identity.ts) is not kept.
  if (name && looksLikeTeamName(name)) name = undefined;
  if (!user || user.deletedAt) {
    if (user?.deletedAt) await sql`delete from users where id = ${user.id}`;   // a deleted account restarts clean
    // Google hands us a name; it only prefills onboarding, which still asks for it.
    [user] = await sql`insert into users (email, name, attribution) values (${e}, ${name?.trim().slice(0, 40) || null}, ${sql.json(attribution || {})}) returning id, onboarded`;
    await sql`insert into analytics_events (user_id, event_name, properties) values (${user.id}, 'signup', ${sql.json(attribution || {})})`.catch(() => {});
    // The launch offer (Plus free until LAUNCH_PLUS_UNTIL), when one is running. A failure here never stops a sign-up:
    // scripts/grant-launch-plus.ts gives it to anyone who missed it.
    await grantLaunchPlus(user.id).catch(e => console.error('launch plus grant failed', (e as Error).message));
    // Arrived through a friend's invite link: both get the invite days now, without typing the code. Never blocks the sign-up.
    await autoRedeemAtSignup(user.id, attribution?.refCode ?? null);
    // Or a creator partner's code (their ?ref= link or Play link): the account becomes their referral (lib/affiliate-ledger.ts).
    await attributeAtSignup(user.id, attribution);
  } else if (attribution && (!user.attribution || Object.keys(user.attribution).length === 0)) {
    await sql`update users set attribution = ${sql.json(attribution)} where id = ${user.id}`.catch(() => {});
  }
  return { ...(await issueTokens(user.id)), isNew: !user.onboarded };
}

export default async function auth(app: FastifyInstance) {
  app.post('/auth/email/start', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async req => {
    const { email } = z.object({ email: z.string().email().max(200) }).parse(req.body);
    const e = email.toLowerCase();
    // The Tablamigo Host team account: no code is stored (or sent), so there is nothing to guess. Same answer as for anyone.
    const [team] = await sql`select 1 from users where email = ${e} and account_kind = 'team'`;
    if (team) { console.warn('sign-in code refused: team account'); return { ok: true, resent: true, resendIn: RESEND_COOLDOWN_SEC }; }
    const review = config.reviewEmails.includes(e) && !!config.reviewCode;
    const code = review ? config.reviewCode : newLoginCode();
    const stored = await storeLoginCode(e, code);
    if (stored.result === 'limit') throw new HttpError(429, 'too_many_codes');
    // Asked again within seconds (a double tap, the keyboard's Go and the button): the code on its way still works.
    if (stored.result === 'cooldown') return { ok: true, resent: false, resendIn: stored.retryIn };
    if (!review) {
      try { await sendLoginCode(e, code); }
      catch (err) { await unsendLoginCode(e, code).catch(() => {}); throw err; }   // the cooldown starts only with a real send
    }
    return { ok: true, resent: true, resendIn: RESEND_COOLDOWN_SEC };
  });

  app.post('/auth/email/verify', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async req => {
    const { email, code, ...extra } = z.object({ email: z.string().email(), code: z.string().regex(/^\d{6}$/) }).passthrough().parse(req.body);
    const e = email.toLowerCase();
    await checkLoginCode(e, code);
    await consumeLoginCode(e);
    const attr = parseAttribution(req, extra);
    return signInByEmail(e, undefined, attr);
  });

  // "Continue with Google": the Android app (Credential Manager) and the web app (Google Identity Services) both send
  // an ID token minted for our web client id. Same rate limit as asking for an email code.
  app.post('/auth/google', { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } }, async req => {
    const { idToken, ...extra } = z.object({ idToken: z.string().min(20).max(4096) }).passthrough().parse(req.body);
    const g = await verifyGoogleIdToken(idToken);
    const attr = parseAttribution(req, extra);
    return signInByEmail(g.email, g.name, attr);
  });


  app.post('/auth/refresh', async req => {
    const { refreshToken } = z.object({ refreshToken: z.string().min(20) }).parse(req.body);
    const [row] = await sql`select r.id, r.user_id from refresh_tokens r join users u on u.id = r.user_id
      where r.token_hash = ${sha256(refreshToken)} and r.revoked_at is null and r.expires_at > now() and u.account_kind = 'person'`;
    if (!row) throw new HttpError(401, 'unauthorized');
    await sql`update refresh_tokens set revoked_at = now() where id = ${row.id}`;   // rotate on every use
    return issueTokens(row.userId);
  });

  app.post('/auth/logout', async req => {
    const uid = await requireUser(req);
    const { refreshToken } = z.object({ refreshToken: z.string().optional() }).parse(req.body ?? {});
    if (refreshToken) await sql`update refresh_tokens set revoked_at = now() where token_hash = ${sha256(refreshToken)} and user_id = ${uid}`;
    return { ok: true };
  });
}
