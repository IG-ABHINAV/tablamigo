-- Sign-up attribution and some analytics properties were written as JSON *strings* (JSON.stringify(x) bound to a
-- ::jsonb cast), not objects, so ->> lookups returned null and jsonb `-` raised "cannot delete from scalar", which made
-- account deletion fail. Turn every string that holds a JSON object back into that object. Code now uses sql.json().
update users set attribution = (attribution #>> '{}')::jsonb
 where jsonb_typeof(attribution) = 'string' and left(attribution #>> '{}', 1) = '{';
update analytics_events set properties = (properties #>> '{}')::jsonb
 where jsonb_typeof(properties) = 'string' and left(properties #>> '{}', 1) = '{';
