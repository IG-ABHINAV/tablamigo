-- Automatic selfie verification (lib/verification.ts): 'pending' now means "queued for the automatic check",
-- which decides it within seconds. reviewed_by/reviewed_at are only set when an admin overrides an outcome.
ALTER TABLE verification_requests DROP CONSTRAINT IF EXISTS verification_requests_pose_check;
ALTER TABLE verification_requests ADD CONSTRAINT verification_requests_pose_check
  CHECK (pose IN ('turn_head','look_up','two_fingers','touch_ear','thumbs_up'));
-- no_face, several_faces, profile_photo, same_photo, no_match, wrong_pose, check_failed, admin (null when approved)
ALTER TABLE verification_requests ADD COLUMN reason text;
-- similarity, face counts, head pose, crop-hash distance and timing of the check, shown read-only in /admin
ALTER TABLE verification_requests ADD COLUMN scores jsonb;
ALTER TABLE verification_requests ADD COLUMN checked_at timestamptz;
CREATE INDEX verification_requests_recent_idx ON verification_requests (created_at DESC);
