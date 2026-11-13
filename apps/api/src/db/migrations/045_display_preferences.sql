-- Migration 045: Display and Dark Mode preferences (OLED pure black, Map theme sync, High contrast)

ALTER TABLE users ADD COLUMN IF NOT EXISTS oled_dark boolean NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS map_theme varchar(16) NOT NULL DEFAULT 'auto' CHECK (map_theme IN ('auto', 'light', 'dark'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS high_contrast boolean NOT NULL DEFAULT false;
