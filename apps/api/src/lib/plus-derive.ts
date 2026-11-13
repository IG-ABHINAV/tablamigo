/**
 * How plus_until is derived (lib/play.ts recomputePlus writes it) and whether an account is in dunning. Its own module with no
 * imports beyond the database, so lib/plus.ts (limits) and lib/play.ts (purchases) can both use it without importing each other.
 */
import { sql } from './db.js';

/**
 * plus_until is derived, never edited directly: the latest of any live subscription,
 * any unvoided Trip Pass and any hand-granted comp. So refunds take Plus away and a
 * renewal can't wipe a pass. CANCELED subs keep access until expiry; EXPIRED and ON_HOLD don't. A row with ended_reason (a
 * refund, a chargeback or a halted renewal ended it) never counts again. While the account is locked by a chargeback on a web
 * payment (users.billing_disputed_at, SC-13), only Google Play purchases count: Google takes and keeps that money, and its
 * disputes are its own. This is the one place the rule is written; `u` is the users row (or alias) it is computed for.
 * `paidOnly` leaves out subscriptions whose renewal is failing (grace period, SC-04): Plus they have is not yet paid for.
 */
export const derivedPlusUntil = ({ paidOnly = false } = {}) => sql`greatest(
    (select max(s.expires_at) from subscriptions s where s.user_id = u.id and s.ended_reason is null
      and s.status in ${sql(paidOnly ? ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_CANCELED'] : ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD', 'SUBSCRIPTION_STATE_CANCELED'])}
      and (u.billing_disputed_at is null or s.platform = 'google')),
    (select max(p.expires_at) from passes p where p.user_id = u.id and p.voided_at is null
      and (u.billing_disputed_at is null or p.purchase_token not like 'rzp:%')),
    case when u.billing_disputed_at is null then u.comp_until end)`;

/**
 * Plus, and whether the account is in dunning (SC-04): it has Plus only because a failing renewal is still being retried
 * (Razorpay pending, Play grace period). Then everything stays on except the features that cost us per use (plus.ts limitsFor).
 */
export async function plusAccess(userId: string): Promise<{ plus: boolean; dunning: boolean }> {
  const [r] = await sql`select coalesce(u.plus_until > now(), false) as plus,
      coalesce(${derivedPlusUntil({ paidOnly: true })} > now(), false) as paid
    from users u where u.id = ${userId}`;
  return { plus: !!r?.plus, dunning: !!r?.plus && !r.paid };
}

