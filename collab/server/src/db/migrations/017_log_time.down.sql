DROP TRIGGER IF EXISTS log_time_dependents_no_update ON log_time_dependents;
DROP FUNCTION IF EXISTS log_time_dependents_immutable();
DROP TABLE IF EXISTS log_time_dependents;
DROP TABLE IF EXISTS log_time_operations;
DROP TABLE IF EXISTS log_time_declarations;
DROP TABLE IF EXISTS log_corpora;
