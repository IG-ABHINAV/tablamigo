import { sql } from './db.js';
import { HttpError } from './errors.js';
import { LIMITS, isPlus, sharePlan } from './plus.js';
import { findContact } from './contact-shield.js';

/**
 * Free-tier rules for DMs and the contact-detail shield. Plan group chats are never gated.
 *
 * DMs: a free user can open LIMITS.free.dmStartsPerDay new conversations per rolling 24 h and send
 * LIMITS.free.dmMessagesBeforeReply messages in one until the other person answers. Unlimited once the
 * other person has written, when the two share a plan, or for Plus.
 *
 * Contacts: phone numbers, emails and social handles from free users are held back in DMs and city chats,
 * unless the two people in a DM share a plan.
 */
export type DmGate = {
  canSend: boolean;
  /** Why this DM is unlimited, when it is. */
  open: 'plus' | 'shared_plan' | 'reply' | null;
  /** Set when the next message would be refused. */
  code: 'dm_limit' | 'dm_wait_reply' | null;
  /** Messages left before the other person has to answer; null when unlimited. */
  remaining: number | null;
  /** Whether contact details can be sent in this chat. */
  contacts: boolean;
  otherName: string | null;
};

const CONTACT_MSG = {
  dm: "For your safety, contact details unlock with Plus or once you've both joined the same plan.",
  city: "For your safety, contact details stay out of city chats. Send them in a direct message instead.",
};

const dmLimitMsg = () => `Free accounts can start ${LIMITS.free.dmStartsPerDay === 1 ? '1 new conversation' : `${LIMITS.free.dmStartsPerDay} new conversations`} a day. Replies are always free, and so are chats with people from your plans. Get Plus or a Trip Pass to message anyone.`;
const waitMsg = (name: string | null) => `You've sent ${LIMITS.free.dmMessagesBeforeReply} messages. Wait for ${name ?? 'them'} to reply, or get Plus or a Trip Pass to keep chatting.`;

const startsToday = async (uid: string, exceptChat: string | null) => {
  const [{ n }] = await sql`select count(*)::int as n from dm_starts where user_id = ${uid} and created_at > now() - interval '1 day'
    and (${exceptChat}::uuid is null or chat_id <> ${exceptChat}::uuid)`;
  return n as number;
};

/** Where a free user stands in one DM. */
export async function dmGate(chatId: string, uid: string): Promise<DmGate> {
  const [o] = await sql`select u.id, u.name from chat_members cm join users u on u.id = cm.user_id where cm.chat_id = ${chatId} and cm.user_id <> ${uid} limit 1`;
  const plus = await isPlus(uid);
  const shared = o ? await sharePlan(uid, o.id) : false;
  const base = { contacts: plus || shared, otherName: (o?.name as string) ?? null };
  if (plus) return { ...base, canSend: true, open: 'plus', code: null, remaining: null };
  if (shared) return { ...base, canSend: true, open: 'shared_plan', code: null, remaining: null };
  const [c] = await sql`select
      exists(select 1 from messages where chat_id = ${chatId} and sender_id = ${o?.id ?? null}::uuid and kind <> 'system') as they_wrote,
      (select count(*)::int from messages where chat_id = ${chatId} and sender_id = ${uid} and kind <> 'system') as mine`;
  if (c.theyWrote) return { ...base, canSend: true, open: 'reply', code: null, remaining: null };
  const lim = LIMITS.free;
  if (c.mine === 0 && await startsToday(uid, chatId) >= lim.dmStartsPerDay) return { ...base, canSend: false, open: null, code: 'dm_limit', remaining: 0 };
  const remaining = Math.max(0, lim.dmMessagesBeforeReply - c.mine);
  return { ...base, canSend: remaining > 0, open: null, code: remaining > 0 ? null : 'dm_wait_reply', remaining };
}

/** Throws the paywall error for a DM the caller can't write in; returns a hook to call once the message is stored. */
export async function assertCanDm(chatId: string, uid: string) {
  const g = await dmGate(chatId, uid);
  if (g.code === 'dm_limit') throw new HttpError(402, 'dm_limit', dmLimitMsg(), { feature: 'dm' });
  if (g.code === 'dm_wait_reply') throw new HttpError(402, 'dm_wait_reply', waitMsg(g.otherName), { feature: 'dm', name: g.otherName });
  const metered = g.open === null && g.remaining === LIMITS.free.dmMessagesBeforeReply;
  return {
    gate: g,
    sent: async () => { if (metered) await sql`insert into dm_starts (user_id, chat_id) values (${uid}, ${chatId}) on conflict do nothing`; },
  };
}

/** Opening a brand-new DM (POST /dm/:userId) when the caller is already out of new conversations for today. */
export async function assertCanOpenDm(uid: string, otherId: string) {
  if (await isPlus(uid) || await sharePlan(uid, otherId)) return;
  if (await startsToday(uid, null) >= LIMITS.free.dmStartsPerDay) throw new HttpError(402, 'dm_limit', dmLimitMsg(), { feature: 'dm' });
}

/**
 * The DM rule for text sent to one person outside a chat (a travel buddy request's intro note): contact details only
 * from Plus, or between two people who share a plan.
 */
export async function assertNoContactsTo(uid: string, otherId: string, texts: string[]) {
  if (await isPlus(uid) || await sharePlan(uid, otherId)) return;
  for (const t of texts) {
    const hit = findContact(t, []);
    if (hit) throw new HttpError(403, 'contact_shield', CONTACT_MSG.dm, { feature: 'contacts', kind: hit.kind });
  }
}

/** Holds back contact details from free users in DMs and city chats. `gate` avoids re-reading a DM's state. */
export async function assertNoContacts(chat: { id: string; kind: string }, uid: string, texts: string[], gate?: DmGate) {
  if (chat.kind === 'activity') return;
  // City chats are public rooms full of strangers: contact details stay out for everyone, whatever the tier (safety, not a paywall).
  const allowed = gate ? gate.contacts : chat.kind === 'dm' ? (await dmGate(chat.id, uid)).contacts : false;
  if (allowed) return;
  // The sender's last few messages, so a number sent a few digits at a time is caught too.
  const recent = (await sql`select body from messages where chat_id = ${chat.id} and sender_id = ${uid} and kind = 'text'
      and deleted_at is null and created_at > now() - interval '30 minutes' order by id desc limit 3`).map(r => r.body as string).reverse();
  for (const t of texts) {
    const hit = findContact(t, recent);
    if (hit) throw new HttpError(403, 'contact_shield', CONTACT_MSG[chat.kind === 'dm' ? 'dm' : 'city'], { feature: 'contacts', kind: hit.kind });
  }
}
