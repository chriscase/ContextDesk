-- Refuse destructive rollback after strict imports have been recorded. Lock in
-- the future writer's intent-before-run table order to avoid lock inversion.
LOCK TABLE external_run_import_success_intents IN ACCESS EXCLUSIVE MODE;
LOCK TABLE imported_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM external_run_import_success_intents LIMIT 1)
     OR EXISTS (
       SELECT 1 FROM imported_runs
       WHERE import_mode IS NOT NULL
          OR source_revision IS NOT NULL
          OR evidence_artifact_ids IS NOT NULL
       LIMIT 1
     ) THEN
    RAISE EXCEPTION
      'cannot roll back 031_external_run_import_atomic while strict import data or success intents exist';
  END IF;
END $$;

DROP TRIGGER IF EXISTS external_run_import_success_intents_no_update
  ON external_run_import_success_intents;
DROP FUNCTION IF EXISTS external_run_import_success_intents_immutable();
DROP TABLE IF EXISTS external_run_import_success_intents;

ALTER TABLE imported_runs
  DROP CONSTRAINT IF EXISTS imported_runs_strict_markers_together_check,
  DROP CONSTRAINT IF EXISTS imported_runs_import_mode_check,
  DROP CONSTRAINT IF EXISTS imported_runs_source_revision_check,
  DROP CONSTRAINT IF EXISTS imported_runs_evidence_artifact_ids_check,
  DROP COLUMN IF EXISTS import_mode,
  DROP COLUMN IF EXISTS source_revision,
  DROP COLUMN IF EXISTS evidence_artifact_ids;

DELETE FROM schema_migrations WHERE version = '031_external_run_import_atomic';
