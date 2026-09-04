DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM investigation_coordination LIMIT 1)
     OR EXISTS (SELECT 1 FROM investigation_coordination_success_intents LIMIT 1) THEN
    RAISE EXCEPTION
      'cannot roll back 029_investigation_coordination while coordination data exists';
  END IF;
END $$;

DROP TRIGGER IF EXISTS investigation_coordination_success_intents_no_update
  ON investigation_coordination_success_intents;
DROP FUNCTION IF EXISTS investigation_coordination_success_intents_immutable();
DROP TABLE IF EXISTS investigation_coordination_success_intents;
DROP TABLE IF EXISTS investigation_coordination;
DELETE FROM schema_migrations WHERE version = '029_investigation_coordination';
