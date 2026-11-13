-- Migration 027: Plan reminders (2h and 15m) and running late status
-- Backlog 11: Plan reminders + "running late" quick message

ALTER TABLE activities ADD COLUMN IF NOT EXISTS reminded_2h_at timestamptz;
ALTER TABLE activities ADD COLUMN IF NOT EXISTS reminded_15m_at timestamptz;

CREATE INDEX IF NOT EXISTS activities_reminders_due_idx ON activities (starts_at)
  WHERE status = 'active' AND (reminded_2h_at IS NULL OR reminded_15m_at IS NULL);
