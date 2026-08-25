-- Rollback drops the new relationship tables and the occurred-at columns.
-- Nothing in 016 and earlier reads them, so an operator can roll back to the
-- previous head without touching case, evidence, or timeline content.
DROP TRIGGER IF EXISTS investigation_references_history ON investigation_references;
DROP FUNCTION IF EXISTS investigation_references_history_guard();
DROP TRIGGER IF EXISTS investigation_involvements_history ON investigation_involvements;
DROP FUNCTION IF EXISTS investigation_involvements_history_guard();
DROP TRIGGER IF EXISTS investigation_resolutions_no_rewrite ON investigation_resolutions;
DROP FUNCTION IF EXISTS investigation_resolutions_insert_only();

DROP TABLE IF EXISTS investigation_resolutions;
DROP TABLE IF EXISTS investigation_references;
DROP TABLE IF EXISTS investigation_involvements;
DROP TABLE IF EXISTS investigation_entities;

ALTER TABLE cases
  DROP CONSTRAINT IF EXISTS cases_occurred_at_consistency_check,
  DROP CONSTRAINT IF EXISTS cases_occurred_at_zone_check,
  DROP CONSTRAINT IF EXISTS cases_occurred_at_precision_check,
  DROP COLUMN IF EXISTS occurred_at_zone,
  DROP COLUMN IF EXISTS occurred_at_precision,
  DROP COLUMN IF EXISTS occurred_at;
