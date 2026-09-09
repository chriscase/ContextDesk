-- Judgment rows and their replay intents are historical human records. Never
-- silently erase them to make a schema rollback appear successful.
LOCK TABLE external_run_judgment_success_intents IN ACCESS EXCLUSIVE MODE;
LOCK TABLE external_run_judgments IN ACCESS EXCLUSIVE MODE;
LOCK TABLE imported_runs IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM external_run_judgment_success_intents LIMIT 1)
     OR EXISTS (SELECT 1 FROM external_run_judgments LIMIT 1) THEN
    RAISE EXCEPTION
      'cannot roll back 032_external_run_judgments while judgment data or success intents exist';
  END IF;
END $$;

DROP TRIGGER IF EXISTS external_run_judgment_success_intents_no_update
  ON external_run_judgment_success_intents;
DROP TRIGGER IF EXISTS external_run_judgments_no_update
  ON external_run_judgments;
DROP FUNCTION IF EXISTS external_run_judgment_rows_immutable();
DROP TABLE IF EXISTS external_run_judgment_success_intents;
DROP TABLE IF EXISTS external_run_judgments;
DROP INDEX IF EXISTS imported_runs_id_case_id_unique;

DELETE FROM schema_migrations WHERE version = '032_external_run_judgments';
