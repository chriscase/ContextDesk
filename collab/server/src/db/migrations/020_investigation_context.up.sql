-- Optional structured context for software/product investigations.
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS investigation_context JSONB;

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_investigation_context_object_check;
ALTER TABLE cases
  ADD CONSTRAINT cases_investigation_context_object_check
    CHECK (
      investigation_context IS NULL
      OR jsonb_typeof(investigation_context) = 'object'
    );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE cases TO collab_app;
  END IF;
END $$;
