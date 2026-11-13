import { sql } from './db.js';
import { emitToUser } from './realtime.js';

export type NoticeKind = 'join' | 'vouch' | 'profile_view' | 'verified' | 'verify_rejected' | 'cancelled' | 'connection' | 'plus' | 'moment_like' | 'moment_comment' | 'trip_chat' | 'recurring_next' | 'plan_comment' | 'buddy_request' | 'buddy_accepted' | 'photo_reaction' | 'rsvp_update' | 'running_late' | 'id_verification_approved' | 'id_verification_rejected' | 'ticket_purchased' | 'plan_views' | 'connection_request' | 'connection_accepted';
type Notice = { kind: NoticeKind; actorId?: string; activityId?: string; chatId?: string; momentId?: string; body: string | ((actorName: string) => string) };

/**
 * Inbox rows for each recipient, minus the actor themselves and anyone either side has blocked.
 * Runs after the action it describes has committed, so it logs failures instead of throwing.
 */
export async function addNotice(userIds: string[], n: Notice) {
  try {
    const actor = n.actorId ?? null;
    const ids = userIds.filter(u => u !== actor);
    if (!ids.length) return;
    let body = n.body;
    if (typeof body === 'function') body = body((actor && (await sql`select name from users where id = ${actor}`)[0]?.name) || 'Someone');
    const rows = await sql`insert into notifications (user_id, kind, actor_id, activity_id, chat_id, moment_id, body)
      select r, ${n.kind}, ${actor}, ${n.activityId ?? null}, ${n.chatId ?? null}, ${n.momentId ?? null}, ${body.slice(0, 300)} from unnest(${ids}::uuid[]) r
      where ${actor}::uuid is null or not exists (select 1 from blocks b where (b.blocker_id = r and b.blocked_id = ${actor}) or (b.blocker_id = ${actor} and b.blocked_id = r))
      returning id, user_id`;
    // Only the id and kind go over the socket: a free account must not get a locked viewer's name this way.
    rows.forEach(r => emitToUser(r.userId, 'inbox:new', { id: r.id, kind: n.kind }));
  } catch (e) { console.error('inbox failed', n.kind, (e as Error).message); }
}
