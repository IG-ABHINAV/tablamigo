import { Server } from 'socket.io';
import type { Server as HttpServer } from 'node:http';
import { readAccess } from './auth.js';
import { sql } from './db.js';

let io: Server | null = null;

/** One room per chat ("chat:<id>") and one per user ("user:<id>") for inbox updates. */
export function attachRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: '*' }, path: '/rt' });
  io.use((socket, next) => {
    let userId: string;
    let imp: string | null;
    let exp: number | null;
    try { ({ sub: userId, imp, exp } = readAccess(String(socket.handshake.auth?.token ?? ''))); } catch { return next(new Error('unauthorized')); }
    socket.data.impersonated = !!imp;
    // An admin's 15-minute look (lib/auth.ts) ends on the socket too: the token is only checked here, at connect, and an idle
    // admin tab on a chat screen would otherwise keep receiving the user's live messages after it has expired.
    if (imp) socket.data.endsAt = (exp ?? Math.floor(Date.now() / 1000)) * 1000;
    // A banned or deleted account keeps a valid access token for up to 30 minutes; requireUser refuses it over HTTP, so
    // the socket must too, or a reconnect right after the ban would bring the live feed back.
    sql`select 1 from users where id = ${userId} and banned_at is null and deleted_at is null`
      .then(([u]) => { if (!u) return next(new Error('unauthorized')); socket.data.userId = userId; next(); })
      .catch(() => next(new Error('unauthorized')));
  });
  io.on('connection', async socket => {
    const userId: string = socket.data.userId;
    if (typeof socket.data.endsAt === 'number') {
      const t = setTimeout(() => socket.disconnect(true), Math.max(0, socket.data.endsAt - Date.now()));
      socket.on('disconnect', () => clearTimeout(t));
    }
    socket.join(`user:${userId}`);
    // Not a DM request they declined, and a women-only chat only while their profile says woman (as assertMember).
    const listening = () => sql`cm.user_id = ${userId} and cm.request_status <> 'declined'
      and (not c.women_only or exists(select 1 from users u where u.id = ${userId} and u.gender = 'woman'))`;
    const chats = await sql`select cm.chat_id from chat_members cm join chats c on c.id = cm.chat_id where ${listening()}`;
    chats.forEach(c => socket.join(`chat:${c.chatId}`));
    socket.on('chat:join', async (chatId: string) => {
      if (!/^[0-9a-f-]{36}$/i.test(String(chatId))) return;
      const [m] = await sql`select 1 from chat_members cm join chats c on c.id = cm.chat_id where cm.chat_id = ${chatId} and ${listening()}`;
      if (m) socket.join(`chat:${chatId}`);
    });
    socket.on('typing', (chatId: string) => {
      if (socket.data.impersonated) return;   // an admin looking (lib/auth.ts) never types as the person
      if (socket.rooms.has(`chat:${chatId}`)) socket.to(`chat:${chatId}`).emit('typing', { chatId, userId });
    });
  });
  return io;
}

// Broadcasts run after the database write has committed, so they must never throw into the request.
const safeEmit = (room: string, event: string, payload: unknown) => {
  try { io?.to(room).emit(event, payload); } catch (e) { console.error('realtime emit failed', event, (e as Error).message); }
};
export const emitToChat = (chatId: string, event: string, payload: unknown) => safeEmit(`chat:${chatId}`, event, payload);
export const emitToUser = (userId: string, event: string, payload: unknown) => safeEmit(`user:${userId}`, event, payload);
// A poll or live location changed: clients merge the patch into message `id`.
export const emitMessageUpdate = (chatId: string, id: string, patch: Record<string, unknown>) => safeEmit(`chat:${chatId}`, 'message:update', { chatId, id, ...patch });
/**
 * A chat event for everyone in the chat except people on either side of a block with `actorId`, so a
 * blocked person's messages, reactions and read state never reach the other side (and the other way round).
 * `alsoHide` names more users to leave out (e.g. those blocked with the author of a quoted message).
 */
export async function emitToChatUnblocked(chatId: string, actorId: string, event: string, payload: unknown, alsoHide: string[] = []) {
  try {
    const rows = await sql`select case when blocker_id = ${actorId} then blocked_id else blocker_id end as user_id
      from blocks where blocker_id = ${actorId} or blocked_id = ${actorId}`;
    const hide = [...new Set([...rows.map(r => r.userId as string), ...alsoHide])].map(u => `user:${u}`);
    if (!io) return;
    (hide.length ? io.to(`chat:${chatId}`).except(hide) : io.to(`chat:${chatId}`)).emit(event, payload);
  } catch (e) { console.error('realtime emit failed', event, (e as Error).message); }
}
/** A message:update (edited text, a live location) for everyone in the chat except people on either side of a block with the author. */
export const emitMessageUpdateUnblocked = (chatId: string, actorId: string, id: string, patch: Record<string, unknown>) =>
  emitToChatUnblocked(chatId, actorId, 'message:update', { chatId, id, ...patch });
/** The same event to a few named users (their own rooms), e.g. a variant payload or a read receipt. */
export const emitToUsers = (userIds: string[], event: string, payload: unknown) => {
  if (!userIds.length) return;
  try { io?.to(userIds.map(u => `user:${u}`)).emit(event, payload); } catch (e) { console.error('realtime emit failed', event, (e as Error).message); }
};
export const joinUserToChat = (userId: string, chatId: string) => io?.in(`user:${userId}`).socketsJoin(`chat:${chatId}`);

/** Takes every open socket of these users out of a chat's room, so no live event of that chat reaches them. */
export const leaveUsersFromChat = (userIds: string[], chatId: string) => {
  if (!userIds.length) return;
  try { io?.in(userIds.map(u => `user:${u}`)).socketsLeave(`chat:${chatId}`); } catch (e) { console.error('realtime leave failed', (e as Error).message); }
};

/** Closes every open socket of a user (ban, account deletion); they can't come back while the account is banned or deleted. */
export const disconnectUser = (userId: string) => {
  try { io?.in(`user:${userId}`).disconnectSockets(true); } catch (e) { console.error('realtime disconnect failed', (e as Error).message); }
};

/**
 * Who may listen to a chat changed: drops the sockets of members who no longer may (a DM request they declined, or a
 * women-only chat when their profile doesn't say woman). Edits, deletes, pins, polls and live-location updates go to
 * the whole room, so leaving the room is what stops them; the same rule applies when a socket connects or joins.
 */
export async function dropNonListeners(chatId: string) {
  try {
    const rows = await sql`select cm.user_id from chat_members cm join chats c on c.id = cm.chat_id join users u on u.id = cm.user_id
      where cm.chat_id = ${chatId} and (cm.request_status = 'declined' or (c.women_only and u.gender is distinct from 'woman'))`;
    leaveUsersFromChat(rows.map(r => r.userId as string), chatId);
  } catch (e) { console.error('realtime leave failed', (e as Error).message); }
}

/** After a profile edit: leaves every women-only chat the user's sockets may no longer listen to. */
export async function dropFromWomenOnlyChats(userId: string) {
  try {
    const rows = await sql`select cm.chat_id from chat_members cm join chats c on c.id = cm.chat_id join users u on u.id = cm.user_id
      where cm.user_id = ${userId} and c.women_only and u.gender is distinct from 'woman'`;
    for (const r of rows) leaveUsersFromChat([userId], r.chatId as string);
  } catch (e) { console.error('realtime leave failed', (e as Error).message); }
}
