-- Migration 026: Partner leads and sponsored travel ads
-- Supports /partnerships portal and native venue promotions

CREATE TABLE IF NOT EXISTS partner_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name text NOT NULL,
  contact_name text NOT NULL,
  business_type text NOT NULL,
  email text NOT NULL,
  city text NOT NULL,
  country text DEFAULT '',
  budget text DEFAULT '',
  message text DEFAULT '',
  status text NOT NULL DEFAULT 'new', -- 'new', 'contacted', 'active', 'declined'
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS partner_leads_created_idx ON partner_leads (created_at DESC);
CREATE INDEX IF NOT EXISTS partner_leads_status_idx ON partner_leads (status);

-- Sponsored ads / promoted pins on the traveler map and feed
CREATE TABLE IF NOT EXISTS sponsored_ads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_id uuid REFERENCES partner_leads(id) ON DELETE SET NULL,
  title text NOT NULL,
  subtitle text NOT NULL,
  emoji text NOT NULL DEFAULT '📍',
  badge_text text NOT NULL DEFAULT 'Sponsored',
  cta_text text NOT NULL DEFAULT 'Learn more',
  target_url text NOT NULL,
  image_url text,
  city text NOT NULL, -- or 'GLOBAL'
  lat double precision,
  lng double precision,
  category text NOT NULL DEFAULT 'experience',
  active boolean NOT NULL DEFAULT true,
  impressions_count integer NOT NULL DEFAULT 0,
  clicks_count integer NOT NULL DEFAULT 0,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sponsored_ads_city_active_idx ON sponsored_ads (city, active, starts_at, ends_at);
