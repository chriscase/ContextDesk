-- Bounded host-triage comparison jobs and worker leases.

CREATE TABLE IF NOT EXISTS collab_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TIMESTAMPTZ,
  payload_hash TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  result_json JSONB,
  attempts INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancel_requested BOOLEAN NOT NULL DEFAULT false,
  CONSTRAINT collab_jobs_kind_check CHECK (kind = 'host_triage_lane'),
  CONSTRAINT collab_jobs_status_check CHECK (status IN (
    'queued', 'leased', 'completed', 'failed', 'cancelled', 'deadline'
  ))
);

CREATE INDEX IF NOT EXISTS collab_jobs_hash_idx ON collab_jobs (payload_hash);
CREATE INDEX IF NOT EXISTS collab_jobs_status_idx ON collab_jobs (status, lease_until);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE collab_jobs TO collab_app;
    REVOKE DELETE ON TABLE collab_jobs FROM collab_app;
  END IF;
END $$;
