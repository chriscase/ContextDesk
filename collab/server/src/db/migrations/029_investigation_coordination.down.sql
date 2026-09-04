DROP TRIGGER IF EXISTS investigation_coordination_success_intents_no_update
  ON investigation_coordination_success_intents;
DROP FUNCTION IF EXISTS investigation_coordination_success_intents_immutable();
DROP TABLE IF EXISTS investigation_coordination_success_intents;
DROP TABLE IF EXISTS investigation_coordination;
DELETE FROM schema_migrations WHERE version = '029_investigation_coordination';
