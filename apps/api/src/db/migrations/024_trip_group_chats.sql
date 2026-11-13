-- Migration 024: Trip Group Chats & Destination Overlap Circles
-- Allows travelers visiting the same destination on overlapping dates to chat and coordinate together.

ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_kind_check;
ALTER TABLE chats ADD CONSTRAINT chats_kind_check CHECK (kind IN ('activity', 'dm', 'city', 'trip'));

ALTER TABLE chats ADD COLUMN IF NOT EXISTS trip_key text UNIQUE;

-- Support trip chat notifications in inbox
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled', 'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat'));
