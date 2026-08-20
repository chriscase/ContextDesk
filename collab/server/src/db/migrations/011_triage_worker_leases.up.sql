-- Durable ownership for triage workers. A second server may recover only an
-- expired lease; an active worker is never treated as abandoned on startup.
ALTER TABLE triage_jobs
  ADD COLUMN IF NOT EXISTS lease_owner TEXT,
  ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS triage_jobs_running_lease_idx
  ON triage_jobs (lease_expires_at, created_at, id)
  WHERE status = 'running';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE triage_jobs TO collab_app;
  END IF;
END $$;
