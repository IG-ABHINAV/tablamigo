-- 043_recurring_plans_enhancements.sql: Indexes and optimizations for recurring clubs and series management
-- Backlog 9: Recurring plans series discovery and host series controls

CREATE INDEX IF NOT EXISTS idx_activities_recurrence_active ON activities (recurrence) WHERE recurrence IS NOT NULL AND status = 'active';
CREATE INDEX IF NOT EXISTS idx_activities_series_status ON activities (series_id, status, starts_at);
