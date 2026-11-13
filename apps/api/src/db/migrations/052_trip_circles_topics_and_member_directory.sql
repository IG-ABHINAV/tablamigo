-- 052_trip_circles_topics_and_member_directory.sql: Backlog 18 (Trip Circles Topics, Meetup Proposals & Member Directory)
-- Adds circle discussion topic to chats and meetup proposal voting for destination circles

ALTER TABLE chats ADD COLUMN IF NOT EXISTS topic text CHECK (char_length(topic) <= 280);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS topic_updated_at timestamptz;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS topic_updated_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS trip_circle_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  proposer_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 120),
  category text NOT NULL CHECK (category IN ('drinks','food','outdoors','culture','nightlife','coworking','sports')),
  proposed_date date NOT NULL,
  votes uuid[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS trip_circle_proposals_chat_idx ON trip_circle_proposals (chat_id, created_at DESC);
