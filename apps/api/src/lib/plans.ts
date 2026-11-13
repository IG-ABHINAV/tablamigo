import type postgres from 'postgres';
import { sql } from './db.js';
import { addNotice } from './inbox.js';
import { emitToChat } from './realtime.js';
import { bad, forbidden, notFound } from './errors.js';

type Db = typeof sql | postgres.TransactionSql;
export type Rsvp = 'going' | 'maybe' | 'waitlist';

/**
 * Seats taken ('going') on a plan. Call it only once the plan row is locked (`for update of a`), as its own statement: a count
 * in the locking statement itself comes from the snapshot taken before the lock wait, so under READ COMMITTED every join that
 * waited behind another saw the old number (22 Oct 2026: six joins at once on the last two seats of a plan of 3 put 7 on it).
 */
export async function goingCount(db: Db, id: string): Promise<number> {
  const [{ going }] = await db`select count(*)::int as going from activity_members where activity_id = ${id} and rsvp_status = 'going'`;
  return going;
}

/**
 * The plan row a join works on (404 when there is none), locked in the caller's transaction until it commits, with its seats
 * counted after the lock.
 */
export async function lockPlanForJoin(tx: postgres.TransactionSql, id: string): Promise<postgres.Row> {
  const [a] = await tx`select a.id, a.title, a.status, a.closed, a.max_people, a.women_only, a.host_id, a.starts_at, a.is_paid as "isPaid", c.id as chat_id
    from activities a join chats c on c.activity_id = a.id where a.id = ${id} for update of a`;
  if (!a) throw notFound();
  a.going = await goingCount(tx, id);
  return a;
}

/**
 * Whether `uid` may join (or change their RSVP on) a plan, whoever adds them: a person's Join or RSVP (routes/activities.ts)
 * and the AI engagement worker (lib/ai-engagement.ts), which used to insert memberships directly and so skipped the
 * women-only and block rules. `a` comes from lockPlanForJoin in the same transaction. Throws the error the join route
 * answers with; otherwise returns the person, their current membership and the status they end up with (a 'going' on a
 * full plan by someone not already going is refused for a newcomer and a waitlist place for a member).
 */
export async function assertCanJoin(tx: postgres.TransactionSql, a: postgres.Row, uid: string, opts: { rsvp: Rsvp; ticketForMembers: boolean }) {
  if (a.status !== 'active') throw notFound();
  if (new Date(a.startsAt).getTime() < Date.now() - 2 * 3600_000) throw bad('activity_over');
  const [me] = await tx`select name, gender, onboarded from users where id = ${uid}`;
  if (!me?.onboarded) throw forbidden('profile_incomplete');
  if (a.womenOnly && me.gender !== 'woman') throw forbidden('women_only');
  const [blocked] = await tx`select 1 from blocks where (blocker_id = ${a.hostId} and blocked_id = ${uid}) or (blocker_id = ${uid} and blocked_id = ${a.hostId})`;
  if (blocked) throw forbidden();
  const [already] = await tx`select rsvp_status from activity_members where activity_id = ${a.id} and user_id = ${uid}`;
  if (a.closed && !already) throw bad('plan_closed', 'The host closed this plan to new people.');
  // A ticketed event is joined by buying a ticket. /join asks every non-host for one; /rsvp only someone not yet in the plan.
  if (a.isPaid && a.hostId !== uid && (opts.ticketForMembers || !already)) {
    const [hasTicket] = await tx`select 1 from activity_tickets where activity_id = ${a.id} and user_id = ${uid} and status in ('valid', 'used')`;
    if (!hasTicket) throw bad('ticket_required', 'This is a ticketed event. Please purchase a ticket to join.');
  }
  // Someone already going holds a seat: a repeat tap on a full plan keeps it instead of moving them to the waitlist.
  const isFull = !!a.maxPeople && a.going >= a.maxPeople && already?.rsvpStatus !== 'going';
  if (!already && isFull && opts.rsvp === 'going') throw bad('full', 'This plan is full. You can join the waitlist.');
  const finalStatus: Rsvp = isFull && opts.rsvp === 'going' ? 'waitlist' : opts.rsvp;
  return { me, already: already as { rsvpStatus: Rsvp } | undefined, finalStatus };
}

/**
 * Plans that ended because of their host's account (deleted or banned) rather than a tap on Cancel:
 * a system message in each plan chat and a 'cancelled' inbox notice for everyone else in it, the same
 * way a host's own cancel tells them. Runs after the status change has committed and never throws.
 */
export async function announceCancelled(planIds: string[], chatText: string, notice: (title: string) => string) {
  for (const id of planIds) {
    try {
      const [a] = await sql`select a.title, a.host_id, c.id as chat_id from activities a join chats c on c.activity_id = a.id where a.id = ${id}`;
      if (!a) continue;
      const [msg] = await sql`insert into messages (chat_id, kind, body) values (${a.chatId}, 'system', ${chatText}) returning id, chat_id, kind, body, created_at, sender_id`;
      await sql`update chats set last_message_at = now() where id = ${a.chatId}`;
      emitToChat(a.chatId, 'message:new', { ...msg, id: String(msg.id) });
      const members = await sql`select user_id from activity_members where activity_id = ${id} and user_id <> ${a.hostId}`;
      await addNotice(members.map(m => m.userId), { kind: 'cancelled', activityId: id, chatId: a.chatId, body: notice(a.title) });
    } catch (e) { console.error('plan cancel notice failed', id, (e as Error).message); }
  }
}
