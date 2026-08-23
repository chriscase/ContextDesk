DROP INDEX IF EXISTS triage_jobs_idempotency_scope_uidx;

ALTER TABLE triage_jobs
  DROP CONSTRAINT IF EXISTS triage_jobs_parent_same_case_fk,
  DROP CONSTRAINT IF EXISTS triage_jobs_id_case_unique,
  DROP CONSTRAINT IF EXISTS triage_jobs_idempotency_digest_pair_check,
  DROP COLUMN IF EXISTS parent_job_id,
  DROP COLUMN IF EXISTS idempotency_scope_digest,
  DROP COLUMN IF EXISTS idempotency_binding_digest;
