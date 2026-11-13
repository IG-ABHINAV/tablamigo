-- 032_chat_voice_notes.sql: Backlog 16 (Voice notes in chat)

ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text', 'system', 'image', 'poll', 'location', 'audio', 'voice'));

CREATE TABLE IF NOT EXISTS chat_voice_notes (
  message_id bigint PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  audio_url text NOT NULL,
  duration_seconds int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_voice_notes_message_id ON chat_voice_notes(message_id);
