-- Interaction traces and human annotations for strategy comparison. Insert-only.

CREATE TABLE IF NOT EXISTS experiment_traces (
  id UUID PRIMARY KEY,
  experiment_id UUID NOT NULL REFERENCES experiment_packages (id),
  candidate_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS experiment_traces_candidate_idx
  ON experiment_traces (experiment_id, candidate_id);

CREATE TABLE IF NOT EXISTS experiment_trace_annotations (
  id UUID PRIMARY KEY,
  experiment_id UUID NOT NULL REFERENCES experiment_packages (id),
  candidate_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

CREATE OR REPLACE FUNCTION experiment_traces_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'experiment_traces is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS experiment_traces_no_update ON experiment_traces;
CREATE TRIGGER experiment_traces_no_update
  BEFORE UPDATE OR DELETE ON experiment_traces
  FOR EACH ROW EXECUTE FUNCTION experiment_traces_immutable();

CREATE OR REPLACE FUNCTION experiment_trace_annotations_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'experiment_trace_annotations is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS experiment_trace_annotations_no_update ON experiment_trace_annotations;
CREATE TRIGGER experiment_trace_annotations_no_update
  BEFORE UPDATE OR DELETE ON experiment_trace_annotations
  FOR EACH ROW EXECUTE FUNCTION experiment_trace_annotations_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE experiment_traces TO collab_app;
    GRANT SELECT, INSERT ON TABLE experiment_trace_annotations TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE experiment_traces FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE experiment_trace_annotations FROM collab_app;
  END IF;
END $$;
