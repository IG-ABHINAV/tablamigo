// The second line of a row in the Chats tab: the last message, said the way a person reads it.

export type LastMessage = { body?: string | null; kind?: string; senderName?: string | null; mine?: boolean } | null | undefined;

/** A message's text as a preview: what it is for media (a voice note's body is its file's address), the words otherwise. */
function what(m: NonNullable<LastMessage>): string {
  if (m.kind === 'image') return '📷 Photo';
  if (m.kind === 'voice' || m.kind === 'audio') return '🎤 Voice note';
  if (m.kind === 'location') return '📍 Live location';
  return m.body ?? '';   // a poll's body is already "📊 <question>"
}

/**
 * "You: …" for your own message, "<name>: …" for someone else's, the system line as it is, and for a chat with no
 * messages yet "Say hi" in a direct chat or the member count in a group. QA 1 Nov 2026: your own messages read
 * "Neha: hi" under your own name, a direct chat with nothing in it read "2 members", and a voice note showed its file address.
 */
export function chatPreview(c: { kind?: string; memberCount?: number; lastMessage?: LastMessage }): string {
  const m = c.lastMessage;
  if (!m) return c.kind === 'dm' ? 'No messages yet. Say hi 👋' : `${c.memberCount ?? 0} ${c.memberCount === 1 ? 'member' : 'members'}`;
  if (m.kind === 'system') return m.body ?? '';
  const who = m.mine ? 'You' : m.senderName;
  return who ? `${who}: ${what(m)}` : what(m);
}
