-- Versioned gold references promoted from accepted experiment decisions. Insert-only.

CREATE TABLE IF NOT EXISTS gold_references (
  gold_id UUID PRIMARY KEY,
  experiment_id UUID NOT NULL REFERENCES experiment_packages (id),
  version INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS gold_references_experiment_version_idx
  ON gold_references (experiment_id, version);

CREATE OR REPLACE FUNCTION gold_references_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'gold_references is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS gold_references_no_update ON gold_references;
CREATE TRIGGER gold_references_no_update
  BEFORE UPDATE OR DELETE ON gold_references
  FOR EACH ROW EXECUTE FUNCTION gold_references_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE gold_references TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE gold_references FROM collab_app;
  END IF;
END $$;
