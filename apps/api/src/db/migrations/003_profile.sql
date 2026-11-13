-- Profile and social: snooze, countries visited, profile views, meetup thumbs-up, photo verification.
-- snoozed_until = 'infinity' means snoozed until the user turns it off.
ALTER TABLE users ADD COLUMN snoozed_until timestamptz;
ALTER TABLE users ADD COLUMN countries_visited text[] NOT NULL DEFAULT '{}';

-- One row per viewer/viewed pair; viewed_at is bumped at most once a day.
CREATE TABLE profile_views (
  viewer_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (viewer_id, viewed_id),
  CHECK (viewer_id <> viewed_id)
);
CREATE INDEX profile_views_viewed_idx ON profile_views (viewed_id, viewed_at DESC);

CREATE TABLE vouches (
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  voucher_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vouched_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, voucher_id, vouched_id),
  CHECK (voucher_id <> vouched_id)
);
CREATE INDEX vouches_vouched_idx ON vouches (vouched_id);

CREATE TABLE verification_requests (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_key   text NOT NULL,
  pose        text NOT NULL CHECK (pose IN ('two_fingers','touch_ear','thumbs_up')),
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX verification_requests_user_idx ON verification_requests (user_id, created_at DESC);
CREATE UNIQUE INDEX verification_requests_one_pending ON verification_requests (user_id) WHERE status = 'pending';
