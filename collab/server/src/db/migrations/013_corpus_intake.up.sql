ALTER TABLE evidence_artifacts
  ADD COLUMN IF NOT EXISTS relative_path TEXT,
  ADD COLUMN IF NOT EXISTS intake_batch_id UUID;

CREATE TABLE IF NOT EXISTS evidence_intake_batches (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  idempotency_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  source_label TEXT NOT NULL,
  privacy_class TEXT NOT NULL DEFAULT 'owner_only',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  CONSTRAINT evidence_intake_batches_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe')),
  CONSTRAINT evidence_intake_batches_case_key UNIQUE (case_id, idempotency_key)
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE evidence_intake_batches TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE evidence_intake_batches FROM collab_app;
  END IF;
END $$;
