-- Append-only human judgments for immutable imported external runs. The case
-- row remains the transaction serializer; the redundant case_id on every row
-- makes cross-investigation run attribution impossible at the database edge.

CREATE UNIQUE INDEX imported_runs_id_case_id_unique
  ON imported_runs (id, case_id);

CREATE TABLE external_run_judgments (
  case_id UUID NOT NULL,
  run_id UUID NOT NULL,
  seq INTEGER NOT NULL,
  judgment TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  links JSONB NOT NULL,
  rationale TEXT,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (run_id, seq),
  UNIQUE (run_id, case_id, seq),
  FOREIGN KEY (run_id, case_id)
    REFERENCES imported_runs(id, case_id) ON DELETE CASCADE,
  CONSTRAINT external_run_judgments_sequence_check
    CHECK (seq >= 1 AND seq <= 1024),
  CONSTRAINT external_run_judgments_value_check
    CHECK (judgment IN ('corroborates', 'contradicts', 'insufficient_evidence')),
  CONSTRAINT external_run_judgments_actor_id_check
    CHECK (length(actor_id) BETWEEN 1 AND 512),
  CONSTRAINT external_run_judgments_actor_username_check
    CHECK (length(actor_username) BETWEEN 1 AND 200),
  CONSTRAINT external_run_judgments_links_check
    CHECK (jsonb_typeof(links) = 'array' AND jsonb_array_length(links) <= 64),
  CONSTRAINT external_run_judgments_rationale_check
    CHECK (rationale IS NULL OR length(rationale) <= 4000)
);

CREATE TABLE external_run_judgment_success_intents (
  case_id UUID NOT NULL,
  run_id UUID NOT NULL,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  judgment_seq INTEGER NOT NULL,
  success_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (case_id, run_id, actor_id, idempotency_key),
  FOREIGN KEY (run_id, case_id, judgment_seq)
    REFERENCES external_run_judgments(run_id, case_id, seq) ON DELETE CASCADE,
  CONSTRAINT external_run_judgment_success_intents_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'),
  CONSTRAINT external_run_judgment_success_intents_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT external_run_judgment_success_intents_sequence_check
    CHECK (judgment_seq >= 1 AND judgment_seq <= 1024),
  CONSTRAINT external_run_judgment_success_intents_json_check
    CHECK (jsonb_typeof(success_json::jsonb) = 'object')
);

CREATE OR REPLACE FUNCTION external_run_judgment_rows_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is insert-only', TG_TABLE_NAME;
END;
$$;

CREATE TRIGGER external_run_judgments_no_update
  BEFORE UPDATE OR DELETE ON external_run_judgments
  FOR EACH ROW EXECUTE FUNCTION external_run_judgment_rows_immutable();

CREATE TRIGGER external_run_judgment_success_intents_no_update
  BEFORE UPDATE OR DELETE ON external_run_judgment_success_intents
  FOR EACH ROW EXECUTE FUNCTION external_run_judgment_rows_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE external_run_judgments TO collab_app;
    GRANT SELECT, INSERT ON TABLE external_run_judgment_success_intents TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE external_run_judgments FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE external_run_judgment_success_intents FROM collab_app;
  END IF;
END $$;
