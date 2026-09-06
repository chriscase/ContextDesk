-- Durable markers and exact-success replay storage for strict manual external
-- run imports. Legacy rows remain readable with all three marker columns NULL.

ALTER TABLE imported_runs
  ADD COLUMN import_mode TEXT,
  ADD COLUMN source_revision BIGINT,
  ADD COLUMN evidence_artifact_ids JSONB,
  ADD CONSTRAINT imported_runs_strict_markers_together_check CHECK (
    num_nonnulls(import_mode, source_revision, evidence_artifact_ids) IN (0, 3)
  ),
  ADD CONSTRAINT imported_runs_import_mode_check CHECK (
    import_mode IS NULL OR import_mode = 'manual'
  ),
  ADD CONSTRAINT imported_runs_source_revision_check CHECK (
    source_revision IS NULL
    OR (source_revision >= 1 AND source_revision <= 9007199254740991)
  ),
  ADD CONSTRAINT imported_runs_evidence_artifact_ids_check CHECK (
    evidence_artifact_ids IS NULL
    OR (
      jsonb_typeof(evidence_artifact_ids) = 'array'
      AND jsonb_array_length(evidence_artifact_ids) <= 64
    )
  );

-- The case row is the concurrency serializer for a future strict import. Only
-- committed successes are replayable; TEXT preserves the exact JSON supplied
-- by the service while jsonb is used only to validate that it is an object.
CREATE TABLE external_run_import_success_intents (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  run_id UUID NOT NULL REFERENCES imported_runs(id),
  success_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (case_id, actor_id, idempotency_key),
  CONSTRAINT external_run_import_success_intents_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'),
  CONSTRAINT external_run_import_success_intents_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT external_run_import_success_intents_json_check
    CHECK (jsonb_typeof(success_json::jsonb) = 'object')
);

CREATE OR REPLACE FUNCTION external_run_import_success_intents_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'external_run_import_success_intents is insert-only';
END;
$$;

CREATE TRIGGER external_run_import_success_intents_no_update
  BEFORE UPDATE OR DELETE ON external_run_import_success_intents
  FOR EACH ROW EXECUTE FUNCTION external_run_import_success_intents_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE external_run_import_success_intents TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE external_run_import_success_intents FROM collab_app;
  END IF;
END $$;
