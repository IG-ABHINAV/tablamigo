-- 064: analytics properties written as JSON strings since 11 Oct 2026 become JSON objects again.
--
-- Nine inserts bound JSON.stringify(...) into analytics_events.properties (jsonb), and postgres.js serialises a jsonb parameter
-- itself, so every trip_created, plan_created, plan_joined, plan_checked_in, message_sent, moment_created, profile_boosted,
-- trip_pass_redeemed, id_verification_submitted and client event from 11 Oct 17:12 IST was stored as a string
-- ("{\"reason\":\"city_chat\"}") and read null through properties->>'reason'. The code now binds sql.json(...). This is the same
-- statement migration 058 ran for the first round of these rows: only strings that hold a JSON object are touched, so it is
-- safe to run again.
update analytics_events set properties = (properties #>> '{}')::jsonb
 where jsonb_typeof(properties) = 'string' and left(properties #>> '{}', 1) = '{';
