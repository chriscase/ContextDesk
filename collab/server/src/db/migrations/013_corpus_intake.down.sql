ALTER TABLE evidence_artifacts DROP COLUMN IF EXISTS intake_batch_id;
ALTER TABLE evidence_artifacts DROP COLUMN IF EXISTS relative_path;
DROP TABLE IF EXISTS evidence_intake_batches;
DROP FUNCTION IF EXISTS evidence_intake_batches_immutable();
