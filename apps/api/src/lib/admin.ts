import type { FastifyRequest } from 'fastify';
import { config } from './config.js';
import { sql } from './db.js';
import { requireUser } from './auth.js';
import { forbidden } from './errors.js';

// The team account (users.account_kind = 'team', the Tablamigo Host) has role 'admin' only so the AI engagement worker leaves
// its plans alone (migration 059). It is never an admin: nobody signs in as it, and this refuses it if anyone ever did.
export const isAdmin = (u: { role?: string | null; email?: string | null; accountKind?: string | null } | undefined) =>
  !!u && u.accountKind !== 'team' && (u.role === 'admin' || (!!u.email && config.adminEmails.includes(String(u.email).toLowerCase())));

/** Signed-in user with users.role = 'admin' or an email listed in ADMIN_EMAILS; otherwise 403. Returns the admin's id. */
export async function requireAdmin(req: FastifyRequest) {
  const uid = await requireUser(req);
  const [me] = await sql`select role, email, account_kind from users where id = ${uid}`;
  if (!isAdmin(me)) throw forbidden();
  return uid;
}
