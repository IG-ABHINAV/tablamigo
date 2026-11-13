-- 055: one key for a city chat, the city's cityKey ('bangkok-th').
--
-- A city's chat could be reached under two keys. Trips and "the chat for where you are" use the cityKey a trip carries
-- ('bangkok-th', lib/geo.ts), while the city guide pages opened it under the guide slug ('bangkok', and 'bangkok:women'
-- for the women's chat), so one city had two chats and its travellers were split between them. The canonical key is the
-- cityKey because it exists for every city, not only the eight guides.

-- 1. Each guide carries its canonical chat key. Generated, so a guide added later can't forget it. The expression is
--    lib/geo.ts cityKey() for plain ASCII names (city-chat-keys.test.ts compares the two for every guide).
ALTER TABLE city_guides ADD COLUMN IF NOT EXISTS chat_key text GENERATED ALWAYS AS (
  trim(both '-' from regexp_replace(lower(city), '[^a-z0-9]+', '-', 'g')) || '-' || lower(country_code)
) STORED;

-- 2. Fold every chat that still sits under a guide slug into the canonical one: rename it when there is no canonical
--    chat yet, otherwise move its members and messages across and drop the empty shell. Safe to run again: once the
--    legacy keys are gone there is nothing left to match.
DO $$
DECLARE
  g record;
  suffix text;
  legacy_key text;
  canon_key text;
  legacy_id uuid;
  canon_id uuid;
BEGIN
  FOR g IN SELECT slug, chat_key FROM city_guides LOOP
    FOREACH suffix IN ARRAY ARRAY['', ':women'] LOOP
      legacy_key := g.slug || suffix;
      canon_key := g.chat_key || suffix;
      CONTINUE WHEN legacy_key = canon_key;

      SELECT id INTO legacy_id FROM chats WHERE kind = 'city' AND city_key = legacy_key;
      CONTINUE WHEN legacy_id IS NULL;
      SELECT id INTO canon_id FROM chats WHERE kind = 'city' AND city_key = canon_key;

      IF canon_id IS NULL THEN
        UPDATE chats SET city_key = canon_key WHERE id = legacy_id;
      ELSE
        INSERT INTO chat_members (chat_id, user_id, last_read_at, muted, joined_at, last_read_message_id, request_status, request_decided_at)
          SELECT canon_id, user_id, last_read_at, muted, joined_at, last_read_message_id, request_status, request_decided_at
          FROM chat_members WHERE chat_id = legacy_id
          ON CONFLICT (chat_id, user_id) DO NOTHING;
        UPDATE messages SET chat_id = canon_id WHERE chat_id = legacy_id;
        UPDATE notifications SET chat_id = canon_id WHERE chat_id = legacy_id;
        UPDATE chats SET last_message_at = greatest(last_message_at, (SELECT last_message_at FROM chats WHERE id = legacy_id)) WHERE id = canon_id;
        DELETE FROM chats WHERE id = legacy_id;   -- its member rows go with it
      END IF;
    END LOOP;
  END LOOP;
END $$;
