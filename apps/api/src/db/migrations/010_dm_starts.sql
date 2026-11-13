-- DM conversations a free user opened, for the "new DMs per day" limit in lib/plus.ts.
-- A row is written only when the first message of a metered conversation goes out: opening the
-- chat screen, replying, Plus and DMs between people who share a plan never write one.
CREATE TABLE dm_starts (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, chat_id)
);
CREATE INDEX dm_starts_user_time ON dm_starts (user_id, created_at);
