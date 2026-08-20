DROP INDEX IF EXISTS triage_jobs_running_lease_idx;
ALTER TABLE triage_jobs
  DROP COLUMN IF EXISTS lease_owner,
  DROP COLUMN IF EXISTS lease_expires_at;
