CREATE TABLE IF NOT EXISTS evidence_intake_batches (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  origin TEXT NOT NULL,
  source_label TEXT NOT NULL,
  privacy_class TEXT NOT NULL DEFAULT 'owner_only',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  CONSTRAINT evidence_intake_batches_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe')),
  CONSTRAINT evidence_intake_batches_request_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT evidence_intake_batches_case_key UNIQUE (case_id, idempotency_key),
  CONSTRAINT evidence_intake_batches_case_id_id_key UNIQUE (case_id, id)
);

CREATE OR REPLACE FUNCTION evidence_intake_batches_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'evidence_intake_batches is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS evidence_intake_batches_no_update ON evidence_intake_batches;
CREATE TRIGGER evidence_intake_batches_no_update
  BEFORE UPDATE OR DELETE ON evidence_intake_batches
  FOR EACH ROW EXECUTE FUNCTION evidence_intake_batches_immutable();

ALTER TABLE evidence_artifacts
  ADD COLUMN IF NOT EXISTS relative_path TEXT,
  ADD COLUMN IF NOT EXISTS intake_batch_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'evidence_artifacts_intake_batch_fk'
  ) THEN
    ALTER TABLE evidence_artifacts
      ADD CONSTRAINT evidence_artifacts_intake_batch_fk
      FOREIGN KEY (case_id, intake_batch_id)
      REFERENCES evidence_intake_batches (case_id, id)
      DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE evidence_intake_batches TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE evidence_intake_batches FROM collab_app;
  END IF;
END $$;
