-- 062: AI plan ideas are counted in the database, and the map's ideas for a city are kept for the day.
--
-- The free daily allowance (lib/plus.ts aiSuggestionsPerDay) was counted in the API's memory: checked before the OpenAI call
-- and increased after it, so parallel calls all passed (one account got 6 in a day against 3: five calls in six seconds), and
-- every restart reset it. And the map asked again on every app open, spending the allowance on the same city's ideas.
-- routes/ai.ts claims one use here atomically before calling OpenAI (and gives it back when the call fails), and keeps the
-- map's ideas per person, city and day, so opening the app again shows them without asking or spending. Rows from earlier days
-- are dropped by the route as it goes; nothing in them names anyone but the account they belong to.
CREATE TABLE IF NOT EXISTS ai_usage (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day     date NOT NULL,
  used    int  NOT NULL DEFAULT 0 CHECK (used >= 0),
  PRIMARY KEY (user_id, day)
);
CREATE TABLE IF NOT EXISTS ai_idea_cache (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day        date NOT NULL,
  city       text NOT NULL,
  ideas      jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day, city)
);
