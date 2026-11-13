-- 044_trip_group_chats_enhancements.sql: Indexes and query performance for trip group chats (Backlog 18)
-- Fast lookups for destination overlap circles and member lists

CREATE INDEX IF NOT EXISTS idx_chats_trip_key ON chats(trip_key) WHERE trip_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trips_city_key_dates ON trips(city_key, start_date, end_date);
