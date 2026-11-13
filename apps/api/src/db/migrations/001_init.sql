-- Tablamigo core schema. Geography columns use SRID 4326 (lat/lng) so distances
-- come back in metres from ST_Distance / ST_DWithin without projection maths.
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  name          text,
  birthdate     date,
  gender        text CHECK (gender IN ('woman','man','nonbinary','unspecified')),
  home_country  text,                 -- ISO 3166-1 alpha-2
  bio           text,
  photo_url     text,
  languages     text[] NOT NULL DEFAULT '{}',
  interests     text[] NOT NULL DEFAULT '{}',
  location      geography(Point,4326),
  location_at   timestamptz,
  city          text,
  plus_until    timestamptz,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
  verified      boolean NOT NULL DEFAULT false,
  onboarded     boolean NOT NULL DEFAULT false,
  banned_at     timestamptz,
  deleted_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_location_idx ON users USING gist (location);

CREATE TABLE otp_codes (
  email       citext PRIMARY KEY,
  code_hash   text NOT NULL,
  expires_at  timestamptz NOT NULL,
  attempts    int NOT NULL DEFAULT 0,
  sent_count  int NOT NULL DEFAULT 1,
  window_start timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE activities (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  host_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         text NOT NULL CHECK (char_length(title) BETWEEN 3 AND 80),
  emoji         text NOT NULL DEFAULT '✨',
  category      text NOT NULL CHECK (category IN ('food','drinks','nightlife','explore','outdoors','culture','sports','work','other')),
  description   text CHECK (char_length(description) <= 600),
  place_name    text NOT NULL,
  place_address text,
  location      geography(Point,4326) NOT NULL,
  city          text,
  starts_at     timestamptz NOT NULL,
  max_people    int CHECK (max_people IS NULL OR max_people BETWEEN 2 AND 50),
  women_only    boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX activities_location_idx ON activities USING gist (location);
CREATE INDEX activities_starts_idx ON activities (starts_at);

CREATE TABLE activity_members (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, user_id)
);
CREATE INDEX activity_members_user_idx ON activity_members (user_id);

CREATE TABLE chats (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL CHECK (kind IN ('activity','dm','city')),
  activity_id uuid UNIQUE REFERENCES activities(id) ON DELETE CASCADE,
  city_key    text UNIQUE,        -- e.g. 'lisbon-pt' for city chats
  dm_key      text UNIQUE,        -- sorted user ids for 1:1 chats
  title       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_message_at timestamptz
);

CREATE TABLE chat_members (
  chat_id      uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  muted        boolean NOT NULL DEFAULT false,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX chat_members_user_idx ON chat_members (user_id);

CREATE TABLE messages (
  id          bigserial PRIMARY KEY,
  chat_id     uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  kind        text NOT NULL DEFAULT 'text' CHECK (kind IN ('text','system','image')),
  body        text NOT NULL CHECK (char_length(body) <= 2000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
CREATE INDEX messages_chat_idx ON messages (chat_id, id DESC);

CREATE TABLE trips (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  city         text NOT NULL,
  country_code text NOT NULL,
  city_key     text NOT NULL,
  location     geography(Point,4326),
  start_date   date NOT NULL,
  end_date     date NOT NULL CHECK (end_date >= start_date),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trips_city_idx ON trips (city_key, start_date, end_date);

CREATE TABLE blocks (
  blocker_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE TABLE reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id uuid REFERENCES users(id) ON DELETE SET NULL,
  target_type text NOT NULL CHECK (target_type IN ('user','activity','message')),
  target_id   text NOT NULL,
  reason      text NOT NULL,
  details     text,
  status      text NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE push_tokens (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform   text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subscriptions (
  purchase_token text PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform       text NOT NULL CHECK (platform IN ('google','apple')),
  product_id     text NOT NULL,
  status         text NOT NULL,
  expires_at     timestamptz,
  raw            jsonb,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
