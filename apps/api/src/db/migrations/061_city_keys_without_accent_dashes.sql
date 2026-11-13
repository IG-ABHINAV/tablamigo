-- 061: city keys drop accents instead of turning them into dashes.
--
-- lib/geo.ts cityKey() normalised a name to NFKD and then replaced everything outside a-z0-9 with '-', so the accents NFKD split
-- off became dashes: 'Medellín' -> 'medelli-n-co', 'Üsküdar' -> 'u-sku-dar-tr', 'Málaga' -> 'ma-laga-es', 'São Paulo' ->
-- 'sa-o-paulo-br'. A trip typed with the accent and one typed without never overlapped, and their city chats were different
-- rooms. The code now drops the accents ('medellin-co').
--
-- 1. city_key_of() is the same rule in SQL (same mark ranges, same special letters); city-chat-keys.test.ts compares it with
--    cityKey() on a list of names, so the two can't drift.
--    The accents are stripped before lower(), and the special letters are listed in both cases, so the answer is the same
--    whatever the database's ctype does with non-ASCII letters.
CREATE OR REPLACE FUNCTION city_key_of(city text, cc text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT trim(both '-' from regexp_replace(
      replace(replace(replace(replace(replace(replace(replace(translate(
        lower(regexp_replace(normalize(city, NFKD), '[\u0300-\u036f\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]', '', 'g')),
        'đðøłıĐÐØŁ', 'ddoliddol'), 'þ', 'th'), 'Þ', 'th'), 'æ', 'ae'), 'Æ', 'ae'), 'œ', 'oe'), 'Œ', 'oe'), 'ß', 'ss'),
      '[^a-z0-9]+', '-', 'g')) || '-' || lower(cc)
$$;

-- 2. Trips (and the buddy requests that carry a trip's key) get the new key. Only names with a character outside ASCII can
--    change, and only those rows are touched. A buddy request whose new key would repeat another one between the same two
--    people keeps its old key.
UPDATE trips SET city_key = city_key_of(city, country_code)
  WHERE city ~ '[^\x01-\x7f]' AND city_key <> city_key_of(city, country_code);
UPDATE travel_buddy_requests r SET city_key = t.city_key
  FROM trips t WHERE r.trip_id = t.id AND r.city_key <> t.city_key
    AND NOT EXISTS (SELECT 1 FROM travel_buddy_requests x WHERE x.sender_id = r.sender_id AND x.recipient_id = r.recipient_id AND x.city_key = t.city_key);

-- 3. Trip circle chats are keyed '<city key>:<yyyy-mm>'. A circle under an old key is renamed to the new one, or, when a circle
--    under the new key already exists, its members and messages move there and the empty shell is dropped (as migration 056
--    folds city chats).
DO $$
DECLARE
  c record;
  new_key text;
  canon_id uuid;
BEGIN
  FOR c IN
    SELECT DISTINCT ch.id, ch.trip_key, city_key_of(t.city, t.country_code) || ':' || split_part(ch.trip_key, ':', 2) AS want
    FROM chats ch JOIN trips t ON t.city_key = city_key_of(t.city, t.country_code)
    WHERE ch.kind = 'trip' AND ch.trip_key IS NOT NULL AND t.city ~ '[^\x01-\x7f]'
      AND split_part(ch.trip_key, ':', 1) <> t.city_key
      -- the key the old rule gave this trip's city (lib/geo.ts legacyCityKey)
      AND split_part(ch.trip_key, ':', 1) = trim(both '-' from regexp_replace(lower(normalize(t.city, NFKD)), '[^a-z0-9]+', '-', 'g')) || '-' || lower(t.country_code)
  LOOP
    new_key := c.want;
    SELECT id INTO canon_id FROM chats WHERE trip_key = new_key;
    IF canon_id IS NULL THEN
      UPDATE chats SET trip_key = new_key WHERE id = c.id;
    ELSIF canon_id <> c.id THEN
      INSERT INTO chat_members (chat_id, user_id, last_read_at, muted, joined_at, last_read_message_id, request_status, request_decided_at)
        SELECT canon_id, user_id, last_read_at, muted, joined_at, last_read_message_id, request_status, request_decided_at
        FROM chat_members WHERE chat_id = c.id
        ON CONFLICT (chat_id, user_id) DO NOTHING;
      UPDATE messages SET chat_id = canon_id WHERE chat_id = c.id;
      UPDATE notifications SET chat_id = canon_id WHERE chat_id = c.id;
      UPDATE chats SET last_message_at = greatest(last_message_at, (SELECT last_message_at FROM chats WHERE id = c.id)) WHERE id = canon_id;
      DELETE FROM chats WHERE id = c.id;
    END IF;
  END LOOP;
END $$;

-- City chats are not renamed here: one under an old key is adopted by the next join through the new key (lib/city-chats.ts
-- cityChatId, legacyKey), and hand-made aliases for old keys ('medelli-n-co') keep working the same way.
