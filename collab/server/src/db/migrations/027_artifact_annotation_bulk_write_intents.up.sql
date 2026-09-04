-- One insert-only parent intent owns an entire bulk annotation result. This
-- makes retries deterministic without inventing per-item idempotency keys.

CREATE TABLE artifact_annotation_bulk_write_intents (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  result_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (case_id, actor_id, idempotency_key),
  CONSTRAINT artifact_annotation_bulk_write_intents_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT artifact_annotation_bulk_write_intents_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'),
  CONSTRAINT artifact_annotation_bulk_write_intents_result_check
    CHECK (jsonb_typeof(result_json) = 'object')
);

CREATE OR REPLACE FUNCTION artifact_annotation_bulk_write_intents_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artifact_annotation_bulk_write_intents is insert-only';
END;
$$;

CREATE TRIGGER artifact_annotation_bulk_write_intents_no_update
  BEFORE UPDATE OR DELETE ON artifact_annotation_bulk_write_intents
  FOR EACH ROW EXECUTE FUNCTION artifact_annotation_bulk_write_intents_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE artifact_annotation_bulk_write_intents TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE artifact_annotation_bulk_write_intents FROM collab_app;
  END IF;
END $$;
