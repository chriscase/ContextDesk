-- Snapshot-bound triage job projections. Provider execution remains behind a host adapter.

CREATE TABLE IF NOT EXISTS triage_jobs (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  snapshot_id UUID NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT triage_jobs_snapshot_same_case_fk
    FOREIGN KEY (snapshot_id, case_id) REFERENCES snapshots (id, case_id),
  CONSTRAINT triage_jobs_status_check
    CHECK (status IN ('queued', 'running', 'completed', 'partial', 'failed', 'timed_out', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS triage_jobs_case_created_idx
  ON triage_jobs (case_id, created_at, id);

CREATE INDEX IF NOT EXISTS triage_jobs_snapshot_idx
  ON triage_jobs (snapshot_id, created_at, id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE triage_jobs TO collab_app;
    REVOKE DELETE ON TABLE triage_jobs FROM collab_app;
  END IF;
END $$;
