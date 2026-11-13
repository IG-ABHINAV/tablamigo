-- Migration 025: Recurring plans generation and series tracking
-- Backlog 9: Auto-generate next occurrence of recurring activities (weekly/biweekly/monthly)

ALTER TABLE activities ADD COLUMN IF NOT EXISTS parent_activity_id uuid REFERENCES activities(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS series_id uuid REFERENCES activities(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS occurrence_number int NOT NULL DEFAULT 1;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS next_activity_id uuid REFERENCES activities(id) ON DELETE SET NULL;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS auto_advance boolean NOT NULL DEFAULT true;

-- For existing recurring activities, set series_id to their own id
UPDATE activities SET series_id = id WHERE recurrence IS NOT NULL AND series_id IS NULL;

CREATE INDEX IF NOT EXISTS activities_series_idx ON activities (series_id, occurrence_number);
CREATE INDEX IF NOT EXISTS activities_recurrence_due_idx ON activities (recurrence, starts_at) WHERE recurrence IS NOT NULL AND next_activity_id IS NULL;

-- Support recurring plan notification kind in inbox
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled', 'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat', 'recurring_next'));
