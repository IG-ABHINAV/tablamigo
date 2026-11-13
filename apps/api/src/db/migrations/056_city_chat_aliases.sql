-- 056: other keys for the same city chat.
--
-- A city's chat key is its cityKey ('bangkok-th'), but two people in one city can reach it under different keys. A trip carries
-- the name the person typed ('bengaluru-in'), "the chat where you are" carries whatever Nominatim calls the GPS point ('panaji-in',
-- 'bardez-in', 'new-delhi-in', 'suginami-jp', 'city-of-westminster-gb'), and the guide pages carry the guide's chat_key
-- ('bangalore-in', 'goa-in', 'delhi-in', 'bali-id'). Each of those used to be its own, separate chat. One row here says "this key
-- is that chat": lib/city-chats.ts cityChatId looks the key up first and uses canonical_key when there is a row. Rows are added by
-- hand and by scripts/seed-founder-city-chats.ts; canonical_key is never itself an alias (no chains).

CREATE TABLE IF NOT EXISTS city_chat_aliases (
  alias_key     text PRIMARY KEY CHECK (alias_key <> canonical_key AND alias_key !~ ':'),
  canonical_key text NOT NULL CHECK (canonical_key !~ ':')
);
CREATE INDEX IF NOT EXISTS city_chat_aliases_canonical_idx ON city_chat_aliases (canonical_key);

-- The four guide cities, whose guide key differs from the name a trip or a GPS point gives.
INSERT INTO city_chat_aliases (alias_key, canonical_key) VALUES
  ('bengaluru-in', 'bangalore-in'),
  ('panaji-in', 'goa-in'), ('bardez-in', 'goa-in'), ('calangute-in', 'goa-in'),
  ('new-delhi-in', 'delhi-in'),
  ('ubud-district-id', 'bali-id'), ('north-kuta-id', 'bali-id'), ('canggu-id', 'bali-id'), ('ubud-id', 'bali-id')
ON CONFLICT (alias_key) DO NOTHING;

-- Fold every chat that already sits under an alias key into the canonical one, the way 055 does for guide slugs: rename it when
-- there is no canonical chat yet, otherwise move its members and messages across and drop the empty shell.
DO $$
DECLARE
  a record;
  suffix text;
  legacy_id uuid;
  canon_id uuid;
BEGIN
  FOR a IN SELECT alias_key, canonical_key FROM city_chat_aliases LOOP
    FOREACH suffix IN ARRAY ARRAY['', ':women'] LOOP
      SELECT id INTO legacy_id FROM chats WHERE kind = 'city' AND city_key = a.alias_key || suffix;
      CONTINUE WHEN legacy_id IS NULL;
      SELECT id INTO canon_id FROM chats WHERE kind = 'city' AND city_key = a.canonical_key || suffix;

      IF canon_id IS NULL THEN
        UPDATE chats SET city_key = a.canonical_key || suffix WHERE id = legacy_id;
      ELSE
        INSERT INTO chat_members (chat_id, user_id, last_read_at, muted, joined_at, last_read_message_id, request_status, request_decided_at)
          SELECT canon_id, user_id, last_read_at, muted, joined_at, last_read_message_id, request_status, request_decided_at
          FROM chat_members WHERE chat_id = legacy_id
          ON CONFLICT (chat_id, user_id) DO NOTHING;
        UPDATE messages SET chat_id = canon_id WHERE chat_id = legacy_id;
        UPDATE notifications SET chat_id = canon_id WHERE chat_id = legacy_id;
        UPDATE chats SET last_message_at = greatest(last_message_at, (SELECT last_message_at FROM chats WHERE id = legacy_id)),
            pinned_message_id = coalesce(pinned_message_id, (SELECT pinned_message_id FROM chats WHERE id = legacy_id))
          WHERE id = canon_id;
        DELETE FROM chats WHERE id = legacy_id;   -- its member rows go with it
      END IF;
    END LOOP;
  END LOOP;
END $$;
