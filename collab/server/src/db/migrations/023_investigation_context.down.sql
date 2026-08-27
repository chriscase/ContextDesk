ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_investigation_context_object_check;
ALTER TABLE cases
  DROP COLUMN IF EXISTS investigation_context;
