/**
 * Posting a chat message the way every sender does it (people in routes/chats.ts, the Tablamigo Host in lib/host.ts and the
 * admin Host inbox): store it, broadcast it, push it, and move the sender's read position. Moved here unchanged from
 * routes/chats.ts so the Host goes through exactly the same rules (declined requests, blocks, muted chats) as a person.
 */
import type postgres from 'postgres';
import { sql } from './db.js';
import { notify } from './push.js';
import { emitToUsers, emitToChatUnblocked } from './realtime.js';

export type Chat = { id: string; kind: string; title: string | null; activityId?: string | null };
/** The quoted message a reply shows. `unavailable` when it was deleted or its author is blocked (either way) by the viewer. */
export type Quote = { id: string; senderId: string | null; senderName: string | null; kind: string; body: string; unavailable: boolean };

// "Either of these two users has blocked the other"; each side is a column fragment (sql`x.user_id`) or a user id.
export const blockPair = (a: postgres.PendingQuery<any> | string, b: postgres.PendingQuery<any> | string) =>
  sql`exists (select 1 from blocks bl where (bl.blocker_id = ${a} and bl.blocked_id = ${b}) or (bl.blocker_id = ${b} and bl.blocked_id = ${a}))`;

// Store, broadcast and push a message. `attach` writes the poll/location row in the same transaction. `opts.analytics` false
// leaves out the 'message_sent' event: the team account's messages (lib/host.ts) are not a person's activity.
export async function post(chat: Chat, uid: string, kind: string, body: string, preview: string, attach?: (tx: postgres.TransactionSql, mid: string) => Promise<Record<string, unknown>>, replyTo?: Quote | null, opts: { analytics?: boolean } = {}) {
  const [m, extra] = await sql.begin(async tx => {
    const [m] = await tx`insert into messages (chat_id, sender_id, kind, body, reply_to_id) values (${chat.id}, ${uid}, ${kind}, ${body}, ${replyTo?.id ?? null})
      returning id, chat_id, kind, body, created_at, sender_id`;
    return [m, attach ? await attach(tx, String(m.id)) : {}] as const;
  });
  await sql`update chats set last_message_at = now() where id = ${chat.id}`;
  if (opts.analytics !== false) await sql`insert into analytics_events (user_id, event_name, properties)
    values (${uid}, 'message_sent', ${sql.json({ chatId: chat.id, kind: chat.kind } as any)})`.catch(() => {});
  await markRead(chat.id, uid);
  const [u] = await sql`select name, photo_url from users where id = ${uid}`;
  const msg = { ...m, id: String(m.id), senderName: u.name, senderPhoto: u.photoUrl, replyTo: replyTo ?? null, reactions: [], ...extra };
  // Members who must not get it at all: they declined this DM request (it stays declined), or it's a women-only chat
  // and their profile no longer says woman (gender is editable).
  const silent = (await sql`select cm.user_id from chat_members cm join chats c on c.id = cm.chat_id join users u on u.id = cm.user_id
      where cm.chat_id = ${chat.id} and cm.user_id <> ${uid}
        and (cm.request_status = 'declined' or (c.women_only and u.gender is distinct from 'woman'))`).map(r => r.userId as string);
  // Nobody on either side of a block with the sender gets it. Members blocked with the quoted author get the quote hidden.
  const quoteHidden = replyTo?.senderId ? (await sql`select cm.user_id from chat_members cm where cm.chat_id = ${chat.id} and cm.user_id <> ${uid}
      and ${blockPair(sql`cm.user_id`, replyTo.senderId)} and not ${blockPair(sql`cm.user_id`, uid)}`).map(r => r.userId as string).filter(u => !silent.includes(u)) : [];
  await emitToChatUnblocked(chat.id, uid, 'message:new', msg, [...quoteHidden, ...silent]);
  if (replyTo) emitToUsers(quoteHidden, 'message:new', { ...msg, replyTo: { ...replyTo, senderId: null, senderName: null, body: '', unavailable: true } });
  // Everyone else in the chat, except people on either side of a block, the silent ones above and anyone who muted the chat.
  const to = (await sql`select cm.user_id from chat_members cm where cm.chat_id = ${chat.id} and cm.user_id <> ${uid} and not cm.muted
    and not exists (select 1 from blocks b where (b.blocker_id = cm.user_id and b.blocked_id = ${uid}) or (b.blocker_id = ${uid} and b.blocked_id = cm.user_id))`)
    .filter(r => !silent.includes(r.userId));
  notify(to.map(r => r.userId), {
    title: chat.kind === 'dm' ? (u.name ?? 'New message') : (chat.title ?? 'New message'),
    body: chat.kind === 'dm' ? preview : `${u.name ?? 'Someone'}: ${preview}`,
    data: { chatId: chat.id }, tag: chat.id,
  });
  return msg;
}

/**
 * Moves the caller's read position to the newest message in the chat. When it moves, the senders of the
 * newly read messages hear about it ("Seen"), except people on either side of a block with the reader.
 */
export async function markRead(chatId: string, uid: string) {
  const [member] = await sql`select request_status from chat_members where chat_id = ${chatId} and user_id = ${uid}`;
  if (member?.requestStatus === 'pending') return;

  const [r] = await sql`with old as (select last_read_message_id as v from chat_members where chat_id = ${chatId} and user_id = ${uid}),
      top as (select max(id) as v from messages where chat_id = ${chatId})
    update chat_members set last_read_at = now(), last_read_message_id = greatest(last_read_message_id, (select v from top))
    where chat_id = ${chatId} and user_id = ${uid}
    returning (select v from old) as old_id, last_read_message_id as new_id`;
  if (!r?.newId || (r.oldId != null && BigInt(r.oldId) >= BigInt(r.newId))) return;
  const to = await sql`select distinct m.sender_id from messages m where m.chat_id = ${chatId} and m.id > ${r.oldId ?? 0} and m.id <= ${r.newId}
      and m.sender_id is not null and m.sender_id <> ${uid} and not ${blockPair(sql`m.sender_id`, uid)} limit 200`;
  emitToUsers(to.map(x => x.senderId as string), 'chat:read', { chatId, userId: uid, lastReadId: String(r.newId) });
}

