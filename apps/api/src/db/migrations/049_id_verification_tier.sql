-- Migration 049: Two-Tier Identity Verification System (Government ID Verification on top of Selfie Check)
-- Backlog 29: Optional Tier 2 government ID verification tier for solo travelers and nomads

ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verified boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verification_status text NOT NULL DEFAULT 'none' CHECK (id_verification_status IN ('none', 'pending', 'approved', 'rejected'));

CREATE TABLE IF NOT EXISTS id_verification_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_type text NOT NULL CHECK (document_type IN ('passport', 'national_id', 'drivers_license', 'aadhaar')),
  document_country text NOT NULL,
  document_photo_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  rejection_reason text,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS id_verification_requests_user_idx ON id_verification_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS id_verification_requests_status_idx ON id_verification_requests(status, created_at DESC);

-- Update notifications_kind_check for ID verification notices
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join', 'vouch', 'profile_view', 'verified', 'verify_rejected', 'cancelled', 'connection', 'plus', 'moment_like', 'moment_comment', 'trip_chat', 'recurring_next', 'plan_comment', 'buddy_request', 'buddy_accepted', 'photo_reaction', 'rsvp_update', 'running_late', 'id_verification_approved', 'id_verification_rejected'));

