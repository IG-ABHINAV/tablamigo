-- Migration 020: expand notifications kind check to allow 'connection' and 'plus' (referral) notices

ALTER TABLE notifications DROP CONSTRAINT notifications_kind_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_kind_check
  CHECK (kind IN ('join','vouch','profile_view','verified','verify_rejected','cancelled','connection','plus'));
