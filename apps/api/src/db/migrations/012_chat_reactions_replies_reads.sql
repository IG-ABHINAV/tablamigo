-- Chat niceties: emoji reactions, reply-to quotes and read receipts, in every kind of chat.

-- One reaction per person per message; picking another emoji replaces it, picking the same one removes it.
-- Reactions are not messages: they never count toward the free DM limits in lib/chat-gate.ts.
CREATE TABLE message_reactions (
  message_id  bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       text NOT NULL CHECK (emoji IN ('👍','❤️','😂','😮','😢','🙏')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- The message this one quotes. Always in the same chat (checked by the API); the quote survives as
-- "Message unavailable" if the original is deleted.
ALTER TABLE messages ADD COLUMN reply_to_id bigint REFERENCES messages(id) ON DELETE SET NULL;

-- Read receipts: the newest message each member has seen, moved forward while the chat is open.
-- "Seen" in a DM and "Seen by N" in a group compare it with the sender's last message id.
ALTER TABLE chat_members ADD COLUMN last_read_message_id bigint;
