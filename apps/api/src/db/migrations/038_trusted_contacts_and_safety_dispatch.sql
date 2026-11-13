-- Migration 038: Trusted Contacts & Emergency Safety Dispatch
-- Allows travelers to save trusted emergency contacts and generate 1-tap emergency dispatch alerts

CREATE TABLE IF NOT EXISTS user_trusted_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(trim(name)) BETWEEN 1 AND 80),
  phone text NOT NULL CHECK (char_length(trim(phone)) BETWEEN 5 AND 30),
  relationship text NOT NULL DEFAULT 'friend' CHECK (relationship IN ('parent', 'partner', 'friend', 'sibling', 'family', 'other')),
  notify_on_plan_join boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_user_trusted_contact_phone UNIQUE (user_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_user_trusted_contacts_uid ON user_trusted_contacts(user_id, created_at ASC);
