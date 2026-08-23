-- Durable rerun lineage and privacy-preserving idempotent admission.
ALTER TABLE triage_jobs
  ADD COLUMN parent_job_id UUID,
  ADD COLUMN idempotency_scope_digest TEXT,
  ADD COLUMN idempotency_binding_digest TEXT;

-- Preserve lineage written by the blocked draft before the authoritative
-- column existed. Malformed UUIDs and cross-case legacy lineage fail the
-- migration; payload/column and empty-lineage validation remains load-time.
UPDATE triage_jobs
SET parent_job_id = NULLIF(payload ->> 'parentJobId', '')::uuid
WHERE payload ? 'parentJobId';

ALTER TABLE triage_jobs
  ADD CONSTRAINT triage_jobs_id_case_unique UNIQUE (id, case_id),
  ADD CONSTRAINT triage_jobs_parent_same_case_fk
    FOREIGN KEY (parent_job_id, case_id) REFERENCES triage_jobs (id, case_id),
  ADD CONSTRAINT triage_jobs_idempotency_digest_pair_check CHECK (
    (idempotency_scope_digest IS NULL AND idempotency_binding_digest IS NULL)
    OR (
      idempotency_scope_digest ~ '^[a-f0-9]{64}$'
      AND idempotency_binding_digest ~ '^[a-f0-9]{64}$'
    )
  );

CREATE UNIQUE INDEX triage_jobs_idempotency_scope_uidx
  ON triage_jobs (idempotency_scope_digest)
  WHERE idempotency_scope_digest IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE triage_jobs TO collab_app;
  END IF;
END $$;
