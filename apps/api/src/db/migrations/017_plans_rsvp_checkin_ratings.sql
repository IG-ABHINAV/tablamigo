-- Migration 017: Plan RSVP states, waitlist, check-in, host ratings, and recurrence
ALTER TABLE activity_members ADD COLUMN rsvp_status text NOT NULL DEFAULT 'going' CHECK (rsvp_status IN ('going', 'maybe', 'waitlist'));
ALTER TABLE activity_members ADD COLUMN checked_in_at timestamptz;

ALTER TABLE activities ADD COLUMN recurrence text CHECK (recurrence IN ('weekly', 'biweekly', 'monthly'));

CREATE TABLE activity_ratings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id uuid NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  rater_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  host_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating smallint NOT NULL CHECK (rating >= 1 AND rating <= 5),
  tags text[] NOT NULL DEFAULT '{}',
  feedback text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (activity_id, rater_id)
);
CREATE INDEX activity_ratings_host_idx ON activity_ratings (host_id);
