-- Chat polls and time-limited live location. Both hang off a message row so they
-- share its ordering, deletion and block filtering.
ALTER TABLE messages DROP CONSTRAINT messages_kind_check;
ALTER TABLE messages ADD CONSTRAINT messages_kind_check CHECK (kind IN ('text','system','image','poll','location'));

CREATE TABLE chat_polls (
  message_id  bigint PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  question    text NOT NULL CHECK (char_length(question) BETWEEN 1 AND 200),
  options     text[] NOT NULL CHECK (cardinality(options) BETWEEN 2 AND 6)
);

CREATE TABLE chat_poll_votes (
  message_id  bigint NOT NULL REFERENCES chat_polls(message_id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option      int NOT NULL CHECK (option >= 0),
  voted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

-- Stopping early moves expires_at to now(); a share is live while expires_at > now().
CREATE TABLE chat_locations (
  message_id  bigint PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location    geography(Point,4326) NOT NULL,
  expires_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
