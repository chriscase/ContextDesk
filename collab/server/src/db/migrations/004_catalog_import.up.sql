-- Source catalog and frozen external-run imports (#887).
-- unknown is a permanent kind. Snapshot-binding is a field only; no #888 packages.

CREATE TABLE IF NOT EXISTS catalog_sources (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  description TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'active',
  identity_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  CONSTRAINT catalog_sources_kind_check
    CHECK (kind IN ('human', 'external-tool', 'internal-system', 'contextdesk', 'unknown')),
  CONSTRAINT catalog_sources_lifecycle_check
    CHECK (lifecycle IN ('active', 'retired'))
);

CREATE UNIQUE INDEX IF NOT EXISTS catalog_sources_identity_idx
  ON catalog_sources (identity_id)
  WHERE identity_id IS NOT NULL;

INSERT INTO catalog_sources (id, name, kind, description, lifecycle, created_by)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Unknown',
  'unknown',
  'Permanent unknown source. Never auto-upgraded.',
  'active',
  'system'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE contributions
  ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES catalog_sources (id);

ALTER TABLE evidence_artifacts
  ADD COLUMN IF NOT EXISTS source_id UUID REFERENCES catalog_sources (id);

CREATE TABLE IF NOT EXISTS imported_runs (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  contribution_id UUID NOT NULL REFERENCES contributions (id),
  source_id UUID NOT NULL REFERENCES catalog_sources (id),
  output_hash TEXT NOT NULL,
  output_text TEXT NOT NULL,
  prompt_hash TEXT,
  prompt_text TEXT,
  prompt_completeness TEXT NOT NULL,
  output_completeness TEXT NOT NULL,
  workflow_completeness TEXT NOT NULL,
  evidence_visibility TEXT NOT NULL,
  snapshot_binding TEXT,
  visibility_note TEXT,
  importer_id TEXT NOT NULL,
  importer_username TEXT NOT NULL,
  operator_id TEXT NOT NULL,
  operator_username TEXT NOT NULL,
  provider TEXT,
  model TEXT,
  version TEXT,
  claimed_traces JSONB NOT NULL DEFAULT '[]',
  uncertainty TEXT,
  timing TEXT,
  cost TEXT,
  redacted BOOLEAN NOT NULL DEFAULT false,
  privacy_class TEXT NOT NULL DEFAULT 'owner_only',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT imported_runs_completeness_prompt_check
    CHECK (prompt_completeness IN ('exact', 'partial', 'unknown')),
  CONSTRAINT imported_runs_completeness_output_check
    CHECK (output_completeness IN ('exact', 'partial', 'unknown')),
  CONSTRAINT imported_runs_completeness_workflow_check
    CHECK (workflow_completeness IN ('exact', 'partial', 'unknown')),
  CONSTRAINT imported_runs_visibility_check
    CHECK (evidence_visibility IN ('unknown', 'importer_described')),
  CONSTRAINT imported_runs_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe'))
);

CREATE TABLE IF NOT EXISTS imported_run_corroborations (
  run_id UUID NOT NULL REFERENCES imported_runs (id),
  seq INT NOT NULL,
  state TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  evidence_links JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  CONSTRAINT imported_run_corroborations_state_check
    CHECK (state IN ('corroborated', 'contradicted'))
);

CREATE OR REPLACE FUNCTION imported_runs_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'imported_runs is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS imported_runs_no_update ON imported_runs;
CREATE TRIGGER imported_runs_no_update
  BEFORE UPDATE OR DELETE ON imported_runs
  FOR EACH ROW EXECUTE FUNCTION imported_runs_immutable();

CREATE OR REPLACE FUNCTION imported_run_corroborations_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'imported_run_corroborations is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS imported_run_corroborations_no_update ON imported_run_corroborations;
CREATE TRIGGER imported_run_corroborations_no_update
  BEFORE UPDATE OR DELETE ON imported_run_corroborations
  FOR EACH ROW EXECUTE FUNCTION imported_run_corroborations_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE catalog_sources TO collab_app;
    GRANT SELECT, INSERT ON TABLE imported_runs TO collab_app;
    GRANT SELECT, INSERT ON TABLE imported_run_corroborations TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE imported_runs FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE imported_run_corroborations FROM collab_app;
  END IF;
END $$;
