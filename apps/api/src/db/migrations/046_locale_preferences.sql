-- Migration 046: Regional and locale preferences (Time format, Currency display)

ALTER TABLE users ADD COLUMN IF NOT EXISTS time_format varchar(8) NOT NULL DEFAULT '12h' CHECK (time_format IN ('12h', '24h'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS currency varchar(8) NOT NULL DEFAULT 'INR' CHECK (currency IN ('INR', 'USD', 'EUR'));
