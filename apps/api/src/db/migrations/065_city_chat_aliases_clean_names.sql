-- 065: aliases for the cleaned place names.
--
-- Place names are cleaned since 22 Oct (lib/geo.ts cleanPlaceName: no 'City of', taluk or municipality), so six aliases that
-- scripts/seed-founder-city-chats.ts wrote from the old Nominatim names no longer match what a GPS point near those cities gives:
-- 'city-of-westminster-gb' is now 'westminster-gb', 'kumata-taluk-in' is 'kumata-in', and so on (checked against prod's
-- geo_cache and city_chat_aliases on 22 Oct: these six, no other). The old rows stay, for names cached before the change.
-- POST /chats/city-here and the Host's welcome also snap to the curated city near the point (lib/curated-cities.ts); these rows
-- make the plain key lead to the same chat everywhere else that follows city_chat_aliases.

INSERT INTO city_chat_aliases (alias_key, canonical_key)
SELECT v.alias_key, v.canonical_key
FROM (VALUES
  ('westminster-gb', 'london-gb'),
  ('kumata-in', 'gokarna-in'),
  ('ozhukarai-in', 'pondicherry-in'),
  ('chiang-mai-city-th', 'chiang-mai-th'),
  ('suthep-town-th', 'chiang-mai-th'),
  ('phuket-city-th', 'phuket-th')
) AS v(alias_key, canonical_key)
-- No chains: a key that is already some alias's canonical key is never made an alias itself, and the canonical key is not an alias.
WHERE NOT EXISTS (SELECT 1 FROM city_chat_aliases c WHERE c.canonical_key = v.alias_key)
  AND NOT EXISTS (SELECT 1 FROM city_chat_aliases c WHERE c.alias_key = v.canonical_key)
ON CONFLICT (alias_key) DO NOTHING;

-- A chat already under one of these keys (none on prod on 22 Oct) is folded into the canonical one, the way 056 does it.
DO $$
DECLARE
  a record;
  suffix text;
  legacy_id uuid;
  canon_id uuid;
BEGIN
  FOR a IN SELECT alias_key, canonical_key FROM city_chat_aliases
           WHERE alias_key IN ('westminster-gb', 'kumata-in', 'ozhukarai-in', 'chiang-mai-city-th', 'suthep-town-th', 'phuket-city-th') LOOP
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
