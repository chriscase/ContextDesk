-- Experiment Lab human review loop. Insert-only packages, observations, and decisions.

CREATE TABLE IF NOT EXISTS experiment_packages (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  package_id TEXT NOT NULL,
  source_schema_id TEXT NOT NULL,
  task_fingerprint TEXT NOT NULL,
  snapshot_fingerprint TEXT NOT NULL,
  candidates JSONB NOT NULL,
  agreement JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  importer_id TEXT NOT NULL,
  importer_username TEXT NOT NULL,
  CONSTRAINT experiment_packages_source_check
    CHECK (source_schema_id IN (
      'cd-collab.experiment_package.v1',
      'cd-collab.experiment_summary.v1'
    ))
);

CREATE UNIQUE INDEX IF NOT EXISTS experiment_packages_case_package_idx
  ON experiment_packages (case_id, package_id);

CREATE TABLE IF NOT EXISTS experiment_helpfulness (
  id UUID PRIMARY KEY,
  experiment_id UUID NOT NULL REFERENCES experiment_packages (id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_decisions (
  id UUID NOT NULL,
  experiment_id UUID NOT NULL REFERENCES experiment_packages (id),
  revision INT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  PRIMARY KEY (experiment_id, revision)
);

CREATE OR REPLACE FUNCTION experiment_packages_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'experiment_packages is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS experiment_packages_no_update ON experiment_packages;
CREATE TRIGGER experiment_packages_no_update
  BEFORE UPDATE OR DELETE ON experiment_packages
  FOR EACH ROW EXECUTE FUNCTION experiment_packages_immutable();

CREATE OR REPLACE FUNCTION experiment_helpfulness_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'experiment_helpfulness is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS experiment_helpfulness_no_update ON experiment_helpfulness;
CREATE TRIGGER experiment_helpfulness_no_update
  BEFORE UPDATE OR DELETE ON experiment_helpfulness
  FOR EACH ROW EXECUTE FUNCTION experiment_helpfulness_immutable();

CREATE OR REPLACE FUNCTION experiment_decisions_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'experiment_decisions is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS experiment_decisions_no_update ON experiment_decisions;
CREATE TRIGGER experiment_decisions_no_update
  BEFORE UPDATE OR DELETE ON experiment_decisions
  FOR EACH ROW EXECUTE FUNCTION experiment_decisions_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE experiment_packages TO collab_app;
    GRANT SELECT, INSERT ON TABLE experiment_helpfulness TO collab_app;
    GRANT SELECT, INSERT ON TABLE experiment_decisions TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE experiment_packages FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE experiment_helpfulness FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE experiment_decisions FROM collab_app;
  END IF;
END $$;
