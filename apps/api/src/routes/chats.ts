import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { z } from 'zod';
import { sql } from '../lib/db.js';
import { requireUser } from '../lib/auth.js';
import { assertClean } from '../lib/moderation.js';
import { assertCanDm, assertCanOpenDm, assertNoContacts, dmGate } from '../lib/chat-gate.js';
import { emitToUser, emitToChat, emitToChatUnblocked, emitMessageUpdate, emitMessageUpdateUnblocked, joinUserToChat, leaveUsersFromChat } from '../lib/realtime.js';
import { blockPair, post, markRead, type Chat, type Quote } from '../lib/chat-post.js';
import { bad, forbidden, notFound, voiceNotesOff } from '../lib/errors.js';
import { isOwnUpload, AUDIO_EXTS } from '../lib/storage.js';
import { config } from '../lib/config.js';

export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

async function assertMember(chatId: string, uid: string) {
  const [m] = await sql`select c.women_only from chat_members cm join chats c on c.id = cm.chat_id where cm.chat_id = ${chatId} and cm.user_id = ${uid}`;
  if (!m) throw forbidden('not_a_member');
  if (m.womenOnly) {
    const [u] = await sql`select gender from users where id = ${uid}`;
    if (u?.gender !== 'woman') throw forbidden('women_only');
  }
}

async function memberChat(chatId: string, uid: string) {
  const [c] = await sql<(Chat & { womenOnly?: boolean })[]>`select c.id, c.kind, c.title, c.activity_id, c.women_only from chats c join chat_members cm on cm.chat_id = c.id and cm.user_id = ${uid} where c.id = ${chatId}`;
  if (!c) throw forbidden('not_a_member');
  if (c.womenOnly) {
    const [u] = await sql`select gender from users where id = ${uid}`;
    if (u?.gender !== 'woman') throw forbidden('women_only');
  }
  return c;
}

// Per-row json for poll and location messages; `m` is the messages alias.
const pollOf = (uid: string) => sql`(select json_build_object('question', p.question, 'options', p.options,
    'counts', (select json_agg((select count(*) from chat_poll_votes v where v.message_id = p.message_id and v.option = i)::int order by i) from generate_series(0, cardinality(p.options) - 1) i),
    'myVote', (select v.option from chat_poll_votes v where v.message_id = p.message_id and v.user_id = ${uid}))
  from chat_polls p where p.message_id = m.id)`;
// Reactions on message `m` as the viewer sees them: people on either side of a block with the viewer are left out.
const reactionsOf = (uid: string) => sql`(select coalesce(json_agg(json_build_object('emoji', e.emoji, 'count', e.n, 'mine', e.mine, 'users', e.users) order by e.first), '[]'::json)
  from (select r.emoji, count(*)::int as n, bool_or(r.user_id = ${uid}) as mine, min(r.created_at) as first,
          json_agg(json_build_object('id', r.user_id, 'name', ru.name) order by r.created_at) as users
        from message_reactions r join users ru on ru.id = r.user_id
        where r.message_id = m.id and not ${blockPair(sql`r.user_id`, uid)}
        group by r.emoji) e)`;
// The message `m` quotes, if any.
const replyOf = (uid: string) => sql`(select json_build_object('id', q.id::text, 'kind', q.kind,
    'senderId', case when x.hidden then null else q.sender_id end,
    'senderName', case when x.hidden then null else qu.name end,
    'body', case when x.hidden then '' else left(q.body, 300) end,
    'unavailable', x.hidden)
  from messages q left join users qu on qu.id = q.sender_id
  cross join lateral (select q.deleted_at is not null or (q.sender_id is not null and ${blockPair(sql`q.sender_id`, uid)}) as hidden) x
  where q.id = m.reply_to_id)`;
// Coordinates only while the share is live. Once it has expired or was stopped (stopping moves expires_at to now) the message keeps
// an inert location with no position: { lat: 0, lng: 0, expiresAt, updatedAt, ended: true }. Same shape as a live one, because the
// installed app (1.2.1, ChatLocationCard) dereferences loc.lat, loc.lng and loc.expiresAt on every location message and decides
// "Ended" from expiresAt; newer clients can read `ended`. The last real position is never served again.
const endedLocation = () => sql`json_build_object('lat', 0, 'lng', 0, 'expiresAt', l.expires_at, 'updatedAt', l.updated_at, 'ended', true)`;
const locationOf = () => sql`(select case when l.expires_at > now()
    then json_build_object('lat', ST_Y(l.location::geometry), 'lng', ST_X(l.location::geometry), 'expiresAt', l.expires_at, 'updatedAt', l.updated_at, 'ended', false)
    else ${endedLocation()} end
  from chat_locations l where l.message_id = m.id)`;
const voiceOf = () => sql`(select json_build_object('audioUrl', v.audio_url, 'durationSeconds', v.duration_seconds)
  from chat_voice_notes v where v.message_id = m.id)`;

/** The message a new one replies to: must be a visible, non-system message in the same chat. */
async function quoteFor(chatId: string, uid: string, replyTo: string | undefined): Promise<Quote | null> {
  if (!replyTo) return null;
  const [q] = await sql`select q.id::text as id, q.sender_id, u.name as sender_name, q.kind, left(q.body, 300) as body from messages q left join users u on u.id = q.sender_id
    where q.id = ${replyTo} and q.chat_id = ${chatId} and q.deleted_at is null and q.kind <> 'system'
      and (q.sender_id is null or not ${blockPair(sql`q.sender_id`, uid)})`;
  if (!q) throw bad('reply_not_in_chat');
  return { id: q.id, senderId: q.senderId, senderName: q.senderName, kind: q.kind, body: q.body, unavailable: false };
}

// A live location the caller shared in this chat.
async function ownShare(chatId: string, messageId: string, uid: string) {
  await assertMember(chatId, uid);
  const [l] = await sql`select l.user_id from chat_locations l join messages m on m.id = l.message_id
    where l.message_id = ${messageId} and m.chat_id = ${chatId}`;
  if (!l) throw notFound();
  if (l.userId !== uid) throw forbidden('not_sender');
}

const msgParams = z.object({ id: z.string().uuid(), messageId: z.string().regex(/^\d+$/) });
const point = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) };

export default async function chats(app: FastifyInstance) {
  app.get('/chats', async req => {
    const uid = await requireUser(req);
    const rows = await sql`
      select c.id, c.kind, c.activity_id, c.city_key, c.women_only as "womenOnly", c.last_message_at,
        coalesce(case when c.kind = 'dm' then (select u.name from chat_members cm2 join users u on u.id = cm2.user_id where cm2.chat_id = c.id and cm2.user_id <> ${uid} limit 1) end,
                 a.title, c.title) as title,
        coalesce(a.emoji, case when c.women_only then '🌸' when c.kind = 'city' then '🏙️' when c.kind = 'trip' then '✈️' else null end) as emoji,
        case when c.kind = 'dm' then (select u.photo_url from chat_members cm2 join users u on u.id = cm2.user_id where cm2.chat_id = c.id and cm2.user_id <> ${uid} limit 1) end as photo_url,
        a.starts_at, (select count(*)::int from chat_members x where x.chat_id = c.id) as member_count,
        (select json_build_object('body', m.body, 'kind', m.kind, 'createdAt', m.created_at, 'senderName', su.name, 'mine', coalesce(m.sender_id::text = ${uid}, false))
           from messages m left join users su on su.id = m.sender_id where m.chat_id = c.id and m.deleted_at is null order by m.id desc limit 1) as last_message,
        (select count(*)::int from messages m where m.chat_id = c.id and m.created_at > cm.last_read_at and coalesce(m.sender_id::text, '') <> ${uid}) as unread,
        case when c.kind = 'dm' then (
          cm.request_status = 'pending' or (
            not exists(select 1 from messages m where m.chat_id = c.id and m.sender_id = ${uid} and m.deleted_at is null)
            and exists(select 1 from messages m where m.chat_id = c.id and m.sender_id <> ${uid} and m.deleted_at is null)
            and cm.request_status <> 'accepted'
          )
        ) else false end as is_request
      from chat_members cm join chats c on c.id = cm.chat_id left join activities a on a.id = c.activity_id
      where cm.user_id = ${uid} and cm.request_status <> 'declined'
        -- A women-only chat (and its last message) only for women, as assertMember enforces for reading it.
        and (not c.women_only or exists(select 1 from users me where me.id = ${uid} and me.gender = 'woman'))
      order by c.last_message_at desc nulls last limit 200`;
    return { chats: rows };
  });

  app.get('/chats/:id/messages', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { before } = z.object({ before: z.string().regex(/^\d+$/).optional() }).parse(req.query);
    await assertMember(id, uid);
    const rows = await sql`
      select m.id, m.chat_id, m.kind, case when m.deleted_at is null then m.body else '' end as body, m.created_at, m.edited_at,
        m.sender_id, u.name as sender_name, u.photo_url as sender_photo, ${pollOf(uid)} as poll, ${locationOf()} as location,
        ${voiceOf()} as voice_note, ${replyOf(uid)} as reply_to, ${reactionsOf(uid)} as reactions
      from messages m left join users u on u.id = m.sender_id
      where m.chat_id = ${id} and (${before ?? null}::bigint is null or m.id < ${before ?? null}::bigint)
        and (m.sender_id is null or not exists (select 1 from blocks b where (b.blocker_id = ${uid} and b.blocked_id = m.sender_id) or (b.blocker_id = m.sender_id and b.blocked_id = ${uid})))
      order by m.id desc limit 50`;
    // For a DM the header is the other person, not the chat row.
    const [chat] = await sql`select c.id, c.kind, c.activity_id, a.emoji, a.starts_at, a.place_name, c.pinned_message_id,
        coalesce(a.title, case when c.kind = 'dm' then o.name end, c.title) as title,
        case when c.kind = 'dm' then o.photo_url end as photo_url,
        case when c.kind = 'dm' then o.id end as other_user_id,
        (select count(*)::int from chat_members x where x.chat_id = c.id) as member_count,
        coalesce((select a.host_id = ${uid} from activities a where a.id = c.activity_id), false) as is_host
      from chats c left join activities a on a.id = c.activity_id
      left join lateral (select u.id, u.name, u.photo_url from chat_members cm join users u on u.id = cm.user_id
        where cm.chat_id = c.id and cm.user_id <> ${uid} limit 1) o on c.kind = 'dm'
      where c.id = ${id}`;
    let pinnedMessage = null;
    if (chat?.pinnedMessageId) {
      const [pm] = await sql`
        select m.id, m.kind, m.body, m.created_at, m.sender_id, u.name as sender_name
        from messages m left join users u on u.id = m.sender_id
        where m.id = ${chat.pinnedMessageId} and m.chat_id = ${id} and m.deleted_at is null
          and (m.sender_id is null or not ${blockPair(sql`m.sender_id`, uid)})`;
      if (pm) pinnedMessage = { ...pm, id: String(pm.id) };
    }
    const [membership] = await sql`select request_status from chat_members where chat_id = ${id} and user_id = ${uid}`;
    if (chat?.kind === 'dm') {
      chat.isRequest = membership?.requestStatus === 'pending';
    }
    // DMs: what the free tier allows next, so the app can show "2 messages left" before anyone hits a wall.
    if (chat?.kind === 'dm') chat.gate = await dmGate(id, uid);
    // Read receipts: members (other than me, and not blocked either way) who have read up to my last message.
    // New reads arrive as 'chat:read' events; the app shows "Seen" in a DM and "Seen by N" in a group.
    const readRows = await sql`select cm.user_id, cm.last_read_message_id::text as last_read_id from chat_members cm
      where cm.chat_id = ${id} and cm.user_id <> ${uid}
        and cm.last_read_message_id >= (select max(x.id) from messages x where x.chat_id = ${id} and x.sender_id = ${uid})
        and not ${blockPair(sql`cm.user_id`, uid)}
      limit 500`;
    const reads = Object.fromEntries(readRows.map(r => [r.userId, r.lastReadId]));
    return { chat: { ...chat, pinnedMessage }, reads, messages: rows.reverse().map(r => ({ ...r, id: String(r.id) })) };
  });

  app.post('/chats/:id/messages', { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } }, async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { body, kind, replyTo, durationSeconds } = z.object({
      body: z.string().trim().min(1).max(2000),
      kind: z.enum(['text', 'image', 'audio', 'voice']).default('text'),
      replyTo: z.string().regex(/^\d+$/).optional(),
      durationSeconds: z.number().int().min(0).max(3600).optional(),
    }).parse(req.body);
    if ((kind === 'audio' || kind === 'voice') && !config.features.voiceNotes) throw voiceNotesOff();
    const chat = await memberChat(id, uid);
    // A voice note's body is its audio URL: only a file the sender uploaded here (POST /uploads/audio/direct). Any other
    // URL would skip the contact shield as "voice" text and make every reader's player fetch a host the sender chose.
    if ((kind === 'audio' || kind === 'voice') && !isOwnUpload(body, uid, ['audio'], AUDIO_EXTS)) throw bad('bad_audio', 'That voice note did not upload properly.');
    // An image's body is its URL too: only the sender's own upload.
    if (kind === 'image' && !isOwnUpload(body, uid, ['chat'])) throw bad('bad_photo');
    const quote = await quoteFor(id, uid, replyTo);
    // A reply is a message like any other: the DM limits, the contact shield and moderation all apply to its text.
    const dm = chat.kind === 'dm' ? await assertCanDm(id, uid) : null;
    if (kind === 'text') await assertNoContacts(chat, uid, [body], dm?.gate);
    if (kind === 'text' && chat.kind !== 'dm') await assertClean(body);
    const preview = kind === 'image' ? '📷 Photo' : (kind === 'audio' || kind === 'voice') ? '🎤 Voice note' : body.slice(0, 140);
    await sql`update chat_members set request_status = 'accepted' where chat_id = ${id} and user_id = ${uid} and request_status = 'pending'`;
    const attach = (kind === 'audio' || kind === 'voice')
      ? async (tx: postgres.TransactionSql, mid: string) => {
          await tx`insert into chat_voice_notes (message_id, audio_url, duration_seconds) values (${Number(mid)}, ${body}, ${durationSeconds ?? 0})`;
          return { voiceNote: { audioUrl: body, durationSeconds: durationSeconds ?? 0 } };
        }
      : undefined;
    const msg = await post(chat, uid, kind, body, preview, attach, quote);
    await dm?.sent();
    return msg;
  });

  // Group chats only: a single-choice poll whose vote can be changed.
  app.post('/chats/:id/polls', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { question, options } = z.object({
      question: z.string().trim().min(1).max(200),
      options: z.array(z.string().trim().min(1).max(80)).min(2).max(6).refine(o => new Set(o.map(s => s.toLowerCase())).size === o.length, 'duplicate options'),
    }).parse(req.body);
    const chat = await memberChat(id, uid);
    if (chat.kind === 'dm') throw bad('group_only');
    await assertNoContacts(chat, uid, [question, ...options]);
    await assertClean(question, ...options);
    return post(chat, uid, 'poll', `📊 ${question}`, `📊 ${question}`.slice(0, 140), async (tx, mid) => {
      await tx`insert into chat_polls (message_id, question, options) values (${mid}, ${question}, ${tx.array(options)})`;
      return { poll: { question, options, counts: options.map(() => 0), myVote: null } };
    });
  });

  app.post('/chats/:id/polls/:messageId/vote', async req => {
    const uid = await requireUser(req);
    const { id, messageId } = msgParams.parse(req.params);
    const { option } = z.object({ option: z.number().int().min(0).max(5) }).parse(req.body);
    await assertMember(id, uid);
    const [p] = await sql`select cardinality(p.options) as n from chat_polls p join messages m on m.id = p.message_id
      where p.message_id = ${messageId} and m.chat_id = ${id} and m.deleted_at is null`;
    if (!p) throw notFound();
    if (option >= p.n) throw bad('invalid_input');
    await sql`insert into chat_poll_votes (message_id, user_id, option) values (${messageId}, ${uid}, ${option})
      on conflict (message_id, user_id) do update set option = excluded.option, voted_at = now()`;
    const [{ poll }] = await sql`select ${pollOf(uid)} as poll from messages m where m.id = ${messageId}`;
    emitMessageUpdate(id, messageId, { poll: { counts: poll.counts }, voterId: uid, option });
    return { id: messageId, poll };
  });

  // Live location for 15 min, 1 h or 8 h. The sender's app PATCHes a fresh fix while the chat is open.
  app.post('/chats/:id/locations', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { lat, lng, minutes } = z.object({ ...point, minutes: z.union([z.literal(15), z.literal(60), z.literal(480)]) }).parse(req.body);
    const chat = await memberChat(id, uid);
    // Never broadcast someone's live position to a crowd of strangers: plan chats and DMs only. Trip circles are open to
    // anyone with a trip to the same city that month, so they count as strangers too.
    if (chat.kind === 'city') throw bad('no_location_in_city_chat');
    if (chat.kind === 'trip') throw bad('no_location_in_trip_chat');
    const dm = chat.kind === 'dm' ? await assertCanDm(id, uid) : null;
    const msg = await post(chat, uid, 'location', '📍 Live location', '📍 Sharing live location', async (tx, mid) => {
      const [l] = await tx`insert into chat_locations (message_id, user_id, location, expires_at)
        values (${mid}, ${uid}, ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, now() + make_interval(mins => ${minutes}))
        returning expires_at, updated_at`;
      return { location: { lat, lng, expiresAt: l.expiresAt, updatedAt: l.updatedAt, ended: false } };
    });
    await dm?.sent();
    return msg;
  });

  app.patch('/chats/:id/locations/:messageId', async req => {
    const uid = await requireUser(req);
    const { id, messageId } = msgParams.parse(req.params);
    const { lat, lng } = z.object(point).parse(req.body);
    await ownShare(id, messageId, uid);
    const [l] = await sql`update chat_locations set location = ST_SetSRID(ST_MakePoint(${lng}, ${lat}), 4326)::geography, updated_at = now()
      where message_id = ${messageId} and expires_at > now() returning expires_at, updated_at`;
    if (!l) throw bad('location_ended');
    const location = { lat, lng, expiresAt: l.expiresAt, updatedAt: l.updatedAt, ended: false };
    // Not to anyone on either side of a block with the sharer: they never get these coordinates.
    await emitMessageUpdateUnblocked(id, uid, messageId, { location });
    return { id: messageId, location };
  });

  app.post('/chats/:id/locations/:messageId/stop', async req => {
    const uid = await requireUser(req);
    const { id, messageId } = msgParams.parse(req.params);
    await ownShare(id, messageId, uid);
    // A stopped share has no coordinates anywhere: the response and the socket patch carry the inert ended location.
    const [l] = await sql`update chat_locations set expires_at = least(expires_at, now()) where message_id = ${messageId}
      returning expires_at, updated_at`;
    const location = { lat: 0, lng: 0, expiresAt: l.expiresAt, updatedAt: l.updatedAt, ended: true };
    await emitMessageUpdateUnblocked(id, uid, messageId, { location });
    return { id: messageId, location };
  });

  // Emoji reactions. Same emoji again removes it, another emoji replaces it. Not a message: no DM limit, no push.
  app.post('/chats/:id/messages/:messageId/react', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async req => {
    const uid = await requireUser(req);
    const { id, messageId } = msgParams.parse(req.params);
    const { emoji } = z.object({ emoji: z.enum(REACTIONS) }).parse(req.body);
    await assertMember(id, uid);
    // Only messages the caller can see: not deleted, not a system line, not from someone on either side of a block.
    const [m] = await sql`select 1 from messages m where m.id = ${messageId} and m.chat_id = ${id} and m.deleted_at is null and m.kind <> 'system'
      and (m.sender_id is null or not ${blockPair(sql`m.sender_id`, uid)})`;
    if (!m) throw notFound();
    const [cur] = await sql`select emoji from message_reactions where message_id = ${messageId} and user_id = ${uid}`;
    const next = cur?.emoji === emoji ? null : emoji;
    if (next) await sql`insert into message_reactions (message_id, user_id, emoji) values (${messageId}, ${uid}, ${next})
      on conflict (message_id, user_id) do update set emoji = excluded.emoji, created_at = now()`;
    else await sql`delete from message_reactions where message_id = ${messageId} and user_id = ${uid}`;
    const [{ reactions }] = await sql`select ${reactionsOf(uid)} as reactions from messages m where m.id = ${messageId}`;
    const [u] = await sql`select name from users where id = ${uid}`;
    await emitToChatUnblocked(id, uid, 'message:reaction', { chatId: id, id: messageId, userId: uid, userName: u?.name ?? null, emoji: next });
    return { id: messageId, emoji: next, reactions };
  });

  app.post('/chats/:id/read', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await markRead(id, uid);
    return { ok: true };
  });

  // Edit a sent message within 5 minutes. Text messages only.
  app.patch('/chats/:id/messages/:messageId', async req => {
    const uid = await requireUser(req);
    const { id, messageId } = msgParams.parse(req.params);
    const { body } = z.object({ body: z.string().trim().min(1).max(2000) }).parse(req.body);
    const chat = await memberChat(id, uid);
    const [m] = await sql`select id, sender_id, kind, created_at, deleted_at from messages where id = ${messageId} and chat_id = ${id}`;
    if (!m || m.deletedAt) throw notFound();
    if (m.senderId !== uid) throw forbidden('not_sender');
    if (m.kind !== 'text') throw bad('can_only_edit_text');
    const ageSeconds = (Date.now() - new Date(m.createdAt).getTime()) / 1000;
    if (ageSeconds > 300) throw bad('edit_window_expired', 'Messages can only be edited within 5 minutes');
    const dm = chat.kind === 'dm' ? await assertCanDm(id, uid) : null;
    await assertNoContacts(chat, uid, [body], dm?.gate);
    if (chat.kind !== 'dm') await assertClean(body);
    const [updated] = await sql`update messages set body = ${body}, edited_at = now() where id = ${messageId} returning edited_at`;
    await emitMessageUpdateUnblocked(id, uid, messageId, { body, editedAt: updated.editedAt });
    return { id: messageId, body, editedAt: updated.editedAt };
  });

  // Delete a message. Senders can delete within 5 min; group plan hosts can delete any message to moderate.
  app.delete('/chats/:id/messages/:messageId', async req => {
    const uid = await requireUser(req);
    const { id, messageId } = msgParams.parse(req.params);
    const chat = await memberChat(id, uid);
    const [m] = await sql`select m.id, m.sender_id, m.created_at, m.deleted_at from messages m where m.id = ${messageId} and m.chat_id = ${id}`;
    if (!m || m.deletedAt) throw notFound();
    const [hostRow] = chat.activityId ? await sql`select host_id from activities where id = ${chat.activityId ?? null}` : [null];
    const isPlanHost = hostRow?.hostId === uid;
    const isSender = m.senderId === uid;
    const ageSeconds = (Date.now() - new Date(m.createdAt).getTime()) / 1000;
    if (!isPlanHost && (!isSender || ageSeconds > 300)) throw forbidden('cannot_delete');
    await sql`update messages set deleted_at = now() where id = ${messageId}`;
    await sql`update chats set pinned_message_id = null where id = ${id} and pinned_message_id = ${messageId}`;
    emitMessageUpdate(id, messageId, { deleted: true, body: '' });
    return { id: messageId, deleted: true };
  });

  // Pin a message in a group chat (plan host or city chat).
  app.post('/chats/:id/pin/:messageId', async req => {
    const uid = await requireUser(req);
    const { id, messageId } = msgParams.parse(req.params);
    const chat = await memberChat(id, uid);
    if (chat.kind === 'dm') throw bad('group_only');
    if (chat.kind === 'activity') {
      const [act] = await sql`select host_id from activities where id = ${chat.activityId ?? null}`;
      if (act?.hostId !== uid) throw forbidden('host_only');
    }
    const [m] = await sql`select m.id, m.body, m.kind, m.created_at, m.sender_id, u.name as sender_name
      from messages m left join users u on u.id = m.sender_id
      where m.id = ${messageId} and m.chat_id = ${id} and m.deleted_at is null and m.kind <> 'system'`;
    if (!m) throw notFound();
    await sql`update chats set pinned_message_id = ${messageId} where id = ${id}`;
    const pinned = { id: String(m.id), body: m.body, kind: m.kind, createdAt: m.createdAt, senderName: m.senderName };
    emitToChat(id, 'chat:pin', { chatId: id, pinnedMessage: pinned });
    return { ok: true, pinnedMessage: pinned };
  });

  // Unpin the current pinned message in a group chat.
  app.delete('/chats/:id/pin', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const chat = await memberChat(id, uid);
    if (chat.kind === 'activity') {
      const [act] = await sql`select host_id from activities where id = ${chat.activityId ?? null}`;
      if (act?.hostId !== uid) throw forbidden('host_only');
    }
    await sql`update chats set pinned_message_id = null where id = ${id}`;
    emitToChat(id, 'chat:pin', { chatId: id, pinnedMessage: null });
    return { ok: true, pinnedMessage: null };
  });

  // Search text messages in a chat.
  app.get('/chats/:id/search', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { q } = z.object({ q: z.string().trim().min(1).max(100) }).parse(req.query);
    await assertMember(id, uid);
    const rows = await sql`
      select m.id, m.chat_id, m.kind, m.body, m.created_at, m.edited_at,
        m.sender_id, u.name as sender_name, u.photo_url as sender_photo
      from messages m left join users u on u.id = m.sender_id
      where m.chat_id = ${id} and m.deleted_at is null and m.kind in ('text', 'image')
        and m.body ilike ${'%' + q + '%'}
        and (m.sender_id is null or not ${blockPair(sql`m.sender_id`, uid)})
      order by m.id desc limit 40`;
    return { results: rows.map(r => ({ ...r, id: String(r.id) })) };
  });

  // Media gallery for photos shared in a chat.
  app.get('/chats/:id/media', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await assertMember(id, uid);
    const rows = await sql`
      select m.id, m.chat_id, m.kind, m.body as url, m.created_at,
        m.sender_id, u.name as sender_name, u.photo_url as sender_photo
      from messages m left join users u on u.id = m.sender_id
      where m.chat_id = ${id} and m.deleted_at is null and m.kind = 'image'
        and (m.sender_id is null or not ${blockPair(sql`m.sender_id`, uid)})
      order by m.id desc limit 100`;
    return { media: rows.map(r => ({ ...r, id: String(r.id) })) };
  });

  app.post('/dm/:userId', async req => {
    const uid = await requireUser(req);
    const { userId } = z.object({ userId: z.string().uuid() }).parse(req.params);
    if (userId === uid) throw forbidden();
    const [other] = await sql`select id from users where id = ${userId} and deleted_at is null and banned_at is null`;
    if (!other) throw notFound();
    const [blocked] = await sql`select 1 from blocks where (blocker_id = ${uid} and blocked_id = ${userId}) or (blocker_id = ${userId} and blocked_id = ${uid})`;
    if (blocked) throw forbidden('blocked');
    const key = [uid, userId].sort().join(':');
    // A brand-new conversation counts against the free daily limit, so say so before creating an empty chat.
    const [existing] = await sql`select id from chats where dm_key = ${key}`;
    if (!existing) await assertCanOpenDm(uid, userId);
    const [c] = await sql`insert into chats (kind, dm_key, last_message_at) values ('dm', ${key}, now())
      on conflict (dm_key) do update set dm_key = excluded.dm_key returning id`;

    // Check if connected or share a confirmed plan:
    const [isConnected] = await sql`
      select (
        exists (select 1 from connections where (user_id = ${uid} and friend_id = ${userId}) or (user_id = ${userId} and friend_id = ${uid}))
        or exists (select 1 from activity_members a1 join activity_members a2 on a1.activity_id = a2.activity_id
                   where a1.user_id = ${uid} and a2.user_id = ${userId} and a1.rsvp_status = 'going' and a2.rsvp_status = 'going')
      ) as connected
    `;
    const targetStatus = isConnected?.connected ? 'accepted' : 'pending';
    // Opening the chat yourself accepts it on your side (even one you declined earlier).
    await sql`insert into chat_members (chat_id, user_id, request_status) values (${c.id}, ${uid}, 'accepted')
      on conflict (chat_id, user_id) do update set request_status = 'accepted' where chat_members.request_status = 'declined'`;
    // The other side's choice stands: a declined request stays declined when the sender reopens the chat, and they
    // get no pushes, live events or list entry for it (the old code reset it to pending).
    const [theirs] = await sql`insert into chat_members (chat_id, user_id, request_status) values (${c.id}, ${userId}, ${targetStatus})
      on conflict (chat_id, user_id) do update set request_status = chat_members.request_status
      returning request_status`;
    joinUserToChat(uid, c.id);
    if (theirs?.requestStatus !== 'declined') {
      joinUserToChat(userId, c.id);
      emitToUser(userId, 'chat:new', { chatId: c.id });
    }
    return { chatId: c.id };
  });

  // Feature 20: Accept DM message request
  app.post('/chats/:id/accept-request', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    await assertMember(id, uid);
    await sql`update chat_members set request_status = 'accepted', request_decided_at = now() where chat_id = ${id} and user_id = ${uid}`;
    await markRead(id, uid);
    emitToChat(id, 'chat:request_accepted', { chatId: id, userId: uid });
    return { ok: true, status: 'accepted' };
  });

  // Feature 20: Decline DM message request (optional block)
  app.post('/chats/:id/decline-request', async req => {
    const uid = await requireUser(req);
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { block } = z.object({ block: z.boolean().default(false) }).parse(req.body ?? {});
    const chat = await memberChat(id, uid);
    await sql`update chat_members set request_status = 'declined', request_decided_at = now() where chat_id = ${id} and user_id = ${uid}`;
    emitToChat(id, 'chat:request_declined', { chatId: id, userId: uid });
    // Their open sockets leave the room too: edits, pins and live-location updates of a declined chat stop reaching them.
    leaveUsersFromChat([uid], id);
    if (block && chat.kind === 'dm') {
      const [other] = await sql`select user_id from chat_members where chat_id = ${id} and user_id <> ${uid} limit 1`;
      if (other) {
        await sql`insert into blocks (blocker_id, blocked_id) values (${uid}, ${other.userId}) on conflict do nothing`;
      }
    }
    return { ok: true, status: 'declined', blocked: !!block };
  });
}
