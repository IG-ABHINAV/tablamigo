import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { sql } from './db.js';
import { bad, HttpError } from './errors.js';

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export function signAccess(userId: string) {
  return jwt.sign({ sub: userId }, config.jwtSecret, { expiresIn: config.accessTtlSec });
}

/**
 * Admin "Login as user" (POST /admin/users/:id/impersonate). The token says who is looking (`imp`, the admin's id), lives 15
 * minutes and has no refresh token. It used to be a normal session: the admin's browser kept refreshing it for days (69
 * refresh tokens on one account), wrote the admin's GPS into users' locations, moved the admin's web push subscription onto
 * them and sent them "viewed your profile" notices. Every write is now refused or skipped (impersonationGuard).
 */
export const IMPERSONATION_TTL_SEC = 15 * 60;
export function signImpersonation(userId: string, adminId: string) {
  return jwt.sign({ sub: userId, imp: adminId }, config.jwtSecret, { expiresIn: IMPERSONATION_TTL_SEC });
}

export async function issueTokens(userId: string) {
  const refresh = crypto.randomBytes(48).toString('base64url');
  await sql`insert into refresh_tokens (user_id, token_hash, expires_at)
            values (${userId}, ${sha256(refresh)}, now() + ${config.refreshTtlDays + ' days'}::interval)`;
  return { accessToken: signAccess(userId), refreshToken: refresh, expiresIn: config.accessTtlSec };
}

/** The user id, for an impersonation token the admin looking (`imp`), and when the token expires (`exp`, epoch seconds). 401 for anything else. */
export function readAccess(token: string): { sub: string; imp: string | null; exp: number | null } {
  try {
    const p = jwt.verify(token, config.jwtSecret) as { sub: string; imp?: string; exp?: number };
    return { sub: p.sub, imp: typeof p.imp === 'string' ? p.imp : null, exp: typeof p.exp === 'number' ? p.exp : null };
  } catch {
    throw new HttpError(401, 'unauthorized');
  }
}
export const verifyAccess = (token: string): string => readAccess(token).sub;

const bearer = (req: FastifyRequest) => { const h = req.headers.authorization ?? ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };

/** The admin behind this request when it carries an impersonation token, else null. Never throws. */
export function impersonatorOf(req: FastifyRequest): string | null {
  const t = bearer(req);
  if (!t) return null;
  try { return readAccess(t).imp; } catch { return null; }
}

// Writes the app makes on its own just by being open: under impersonation they are answered as if done, and nothing is written.
// Anything else that writes is refused, so looking at someone's account can't change it.
const SILENT_WRITES = new Set(['POST /me/location', 'POST /me/push-token', 'POST /analytics/events', 'POST /analytics/event',
  'POST /chats/:id/read', 'POST /inbox/read', 'POST /auth/logout']);

/** Registers the read-only rule for impersonation tokens (server.ts). GET/HEAD/OPTIONS pass; routes skip their own side effects. */
export function impersonationGuard(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
    const imp = impersonatorOf(req);
    if (!imp) return;
    const route = `${req.method} ${req.routeOptions?.url ?? ''}`;
    if (route === 'POST /me/location') {
      const [u] = await sql`select city from users where id = ${verifyAccess(bearer(req))}`;
      return reply.send({ city: u?.city ?? null });
    }
    if (SILENT_WRITES.has(route)) return reply.send({ ok: true, impersonating: true });
    return reply.status(403).send({ error: 'impersonation_read_only', message: 'Impersonation is read-only.' });
  });
}

/** Resolve the signed-in user id from the Authorization header, or 401. The Tablamigo Host team account is refused (403):
 *  it only ever acts from the server (lib/host.ts), never with a token. */
export async function requireUser(req: FastifyRequest): Promise<string> {
  const token = bearer(req);
  if (!token) throw new HttpError(401, 'unauthorized');
  const { sub: id, imp } = readAccess(token);
  const [u] = await sql`select id, banned_at, deleted_at, account_kind from users where id = ${id}`;
  if (!u || u.deletedAt) throw new HttpError(401, 'unauthorized');
  if (u.accountKind === 'team') throw new HttpError(403, 'team_account');
  if (u.bannedAt) throw new HttpError(403, 'banned');
  // An admin looking at the account is not the person being active.
  if (!imp) sql`update users set last_seen_at = now() where id = ${id}`.catch(() => {});
  return id;
}

// ---- email sign-in codes (shared by the app's sign-in and the admin sign-in) ----------------------
export const newLoginCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');

/** A second request this soon after a send sends nothing: the code on its way is still good (a double tap counts once). */
export const RESEND_COOLDOWN_SEC = 30;

/**
 * Stores a fresh 10-minute code for `email`. 'cooldown' (with the seconds left) when a code went out less than
 * RESEND_COOLDOWN_SEC ago: nothing is stored or sent, and that code still works. 'limit' when the address already had 5 codes
 * this hour. A new code doesn't kill the one before it: that one stays good until it expires (prev_code_hash), so the code in
 * an email that arrived late still works.
 */
export async function storeLoginCode(email: string, code: string): Promise<{ result: 'stored' } | { result: 'cooldown'; retryIn: number } | { result: 'limit' }> {
  const [row] = await sql`select sent_count, window_start, expires_at > now() as live,
      ceil(extract(epoch from last_sent_at + make_interval(secs => ${RESEND_COOLDOWN_SEC}) - now()))::int as cooldown_left
    from otp_codes where email = ${email}`;
  if (row?.live && row.cooldownLeft > 0) return { result: 'cooldown', retryIn: row.cooldownLeft };
  if (row && row.sentCount >= 5 && Date.now() - new Date(row.windowStart).getTime() < 3600_000) return { result: 'limit' };
  if (!(await writeLoginCode(email, code))) return { result: 'cooldown', retryIn: RESEND_COOLDOWN_SEC };
  return { result: 'stored' };
}

/**
 * Stores the code unless one went out less than RESEND_COOLDOWN_SEC ago; false when it stored nothing. The cooldown is checked
 * again here, inside the write: two requests in the same instant (the keyboard's Go and the button) can both pass the read in
 * storeLoginCode, and the second must not replace the code the first is sending. ON CONFLICT locks the row, so the second write
 * sees the first one's last_sent_at and changes nothing. Exported for the test.
 */
export async function writeLoginCode(email: string, code: string): Promise<boolean> {
  const stored = await sql`insert into otp_codes (email, code_hash, expires_at) values (${email}, ${sha256(code)}, now() + interval '10 minutes')
    on conflict (email) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, last_sent_at = now(),
      prev_code_hash = case when otp_codes.expires_at > now() and otp_codes.code_hash <> excluded.code_hash then otp_codes.code_hash end,
      prev_expires_at = case when otp_codes.expires_at > now() and otp_codes.code_hash <> excluded.code_hash then otp_codes.expires_at end,
      sent_count = case when otp_codes.window_start < now() - interval '1 hour' then 1 else otp_codes.sent_count + 1 end,
      window_start = case when otp_codes.window_start < now() - interval '1 hour' then now() else otp_codes.window_start end
    where not (otp_codes.expires_at > now() and otp_codes.last_sent_at > now() - make_interval(secs => ${RESEND_COOLDOWN_SEC}))
    returning 1`;
  return stored.length > 0;
}

/**
 * The email with this code never went out (the provider failed). It starts no 30-second cooldown, so a retry seconds later writes
 * and sends a fresh code (before, the retry answered "sent" and nothing ever arrived). The code itself is withdrawn: the code
 * before it is the current one again while it is unexpired, otherwise no code is live, so nobody can guess a code nobody got.
 * The failed send still counts toward the 5 codes an hour, so failing sends never buy more rounds of guesses.
 */
export const unsendLoginCode = (email: string, code: string) =>
  sql`update otp_codes set last_sent_at = now() - make_interval(secs => ${RESEND_COOLDOWN_SEC}),
      code_hash = coalesce(prev_code_hash, code_hash),
      expires_at = case when prev_code_hash is not null and prev_expires_at > now() then prev_expires_at else now() end,
      prev_code_hash = null, prev_expires_at = null
    where email = ${email} and code_hash = ${sha256(code)}`;

/** Throws code_expired, too_many_attempts or wrong_code (counting the attempt). The latest code or the one before it, while
 *  each is unexpired. Does not use the code up. */
export async function checkLoginCode(email: string, code: string) {
  const [row] = await sql`select code_hash, expires_at, prev_code_hash, prev_expires_at, attempts from otp_codes where email = ${email}`;
  const now = new Date(), h = sha256(code);
  const latest = !!row && new Date(row.expiresAt) > now;
  const previous = !!row?.prevCodeHash && !!row.prevExpiresAt && new Date(row.prevExpiresAt) > now;
  if (!latest && !previous) throw bad('code_expired');
  if (row.attempts >= 5) throw bad('too_many_attempts');
  if ((latest && row.codeHash === h) || (previous && row.prevCodeHash === h)) return;
  await sql`update otp_codes set attempts = attempts + 1 where email = ${email}`;
  throw bad('wrong_code');
}
export const consumeLoginCode = (email: string) => sql`delete from otp_codes where email = ${email}`;
