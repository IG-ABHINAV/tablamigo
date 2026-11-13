-- Reverse-geocode results per ~5 km grid cell, so Nominatim (about 1 request/s allowed) is asked once per area, not once per location update.
CREATE TABLE geo_cache (
  cell       text PRIMARY KEY,
  city       text,
  country    text,
  cached_at  timestamptz NOT NULL DEFAULT now()
);
