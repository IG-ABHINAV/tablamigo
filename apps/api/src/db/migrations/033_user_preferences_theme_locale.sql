-- Migration 033: User theme and locale preferences (Dark mode, Hindi / Spanish i18n)

ALTER TABLE users ADD COLUMN IF NOT EXISTS theme varchar(16) NOT NULL DEFAULT 'system' CHECK (theme IN ('system', 'light', 'dark'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS locale varchar(16) NOT NULL DEFAULT 'en' CHECK (locale IN ('en', 'hi', 'es'));
