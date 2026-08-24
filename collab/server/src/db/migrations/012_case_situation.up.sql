-- Durable, explicitly unknown-by-default Situation context for investigations.
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS problem_statement TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS affected_parties TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS impact TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS situation_scope TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS open_questions JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_open_questions_array_check;
ALTER TABLE cases
  ADD CONSTRAINT cases_open_questions_array_check
    CHECK (jsonb_typeof(open_questions) = 'array');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE cases TO collab_app;
  END IF;
END $$;
