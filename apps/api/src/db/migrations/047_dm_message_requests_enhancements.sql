-- Migration 047: DM Message Request safety decisions and audit trail

ALTER TABLE chat_members ADD COLUMN IF NOT EXISTS request_decided_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_chat_members_request_decided ON chat_members(user_id, request_decided_at) WHERE request_decided_at IS NOT NULL;
