-- 054: reports can name the user content added since the first moderation pass.
--
-- 'user', 'activity' and 'message' were the only things a report could point at. Moments, the comments under moments and
-- under plans, city tips and the meetup ideas pitched in a trip circle are user-generated content too, and Google Play's
-- user-generated-content policy wants an in-app way to report each kind of it. Dropping and re-adding the check by name
-- makes this safe to run twice.
ALTER TABLE reports DROP CONSTRAINT IF EXISTS reports_target_type_check;
ALTER TABLE reports ADD CONSTRAINT reports_target_type_check
  CHECK (target_type IN ('user', 'activity', 'message', 'moment', 'moment_comment', 'plan_comment', 'city_tip', 'circle_proposal'));
