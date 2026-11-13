-- Backlog 17 & 19: Message editing/deletion (5 min window), pinned messages in chats, and chat media indexing

ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;

ALTER TABLE chats ADD COLUMN IF NOT EXISTS pinned_message_id bigint REFERENCES messages(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_chat_kind_idx ON messages (chat_id, kind) WHERE deleted_at IS NULL;
