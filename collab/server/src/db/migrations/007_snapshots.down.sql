DROP TRIGGER IF EXISTS snapshots_no_update ON snapshots;
DROP FUNCTION IF EXISTS snapshots_immutable();
DROP TABLE IF EXISTS snapshots;
