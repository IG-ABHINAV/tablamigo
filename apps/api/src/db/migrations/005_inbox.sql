-- In-app inbox. Body is written at send time; GET /inbox decides what a free account may see.
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('join','vouch','profile_view','verified','verify_rejected','cancelled')),
  actor_id    uuid REFERENCES users(id) ON DELETE CASCADE,
  activity_id uuid REFERENCES activities(id) ON DELETE CASCADE,
  chat_id     uuid REFERENCES chats(id) ON DELETE SET NULL,
  body        text NOT NULL CHECK (char_length(body) <= 300),
  created_at  timestamptz NOT NULL DEFAULT now(),
  read_at     timestamptz
);
CREATE INDEX notifications_user_idx ON notifications (user_id, created_at DESC);
