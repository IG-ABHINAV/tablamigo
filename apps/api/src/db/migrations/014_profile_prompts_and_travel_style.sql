-- Profile prompts: up to 3 short answers to conversation starter prompts.
CREATE TABLE profile_prompts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  prompt      text NOT NULL,
  answer      text NOT NULL CHECK (char_length(trim(answer)) BETWEEN 1 AND 250),
  position    smallint NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, prompt)
);

CREATE INDEX idx_profile_prompts_user ON profile_prompts(user_id, position ASC);

-- Travel style tags: budget, luxury, early bird, night owl, planner, spontaneous, foodie, hiker, party, culture
ALTER TABLE users ADD COLUMN travel_style text[] NOT NULL DEFAULT '{}';
