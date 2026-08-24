ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_open_questions_array_check,
  DROP CONSTRAINT IF EXISTS cases_situation_version_check,
  DROP COLUMN IF EXISTS situation_version,
  DROP COLUMN IF EXISTS open_questions,
  DROP COLUMN IF EXISTS situation_scope,
  DROP COLUMN IF EXISTS impact,
  DROP COLUMN IF EXISTS affected_parties,
  DROP COLUMN IF EXISTS problem_statement;
