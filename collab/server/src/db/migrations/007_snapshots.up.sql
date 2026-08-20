-- Immutable case evidence snapshots for fair reruns and evolving war rooms.

CREATE TABLE IF NOT EXISTS snapshots (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  fingerprint TEXT NOT NULL,
  parent_snapshot_id UUID,
  evidence JSONB NOT NULL,
  visibility TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  fairness_class TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  CONSTRAINT snapshots_id_case_unique UNIQUE (id, case_id),
  CONSTRAINT snapshots_parent_same_case_fk
    FOREIGN KEY (parent_snapshot_id, case_id) REFERENCES snapshots (id, case_id),
  CONSTRAINT snapshots_visibility_check
    CHECK (visibility IN ('owner_only', 'share_safe')),
  CONSTRAINT snapshots_fairness_check
    CHECK (fairness_class IN ('same_snapshot', 'unknown')),
  CONSTRAINT snapshots_status_check
    CHECK (status = 'frozen')
);

CREATE UNIQUE INDEX IF NOT EXISTS snapshots_case_fingerprint_idx
  ON snapshots (case_id, fingerprint);

CREATE INDEX IF NOT EXISTS snapshots_case_created_idx
  ON snapshots (case_id, created_at, id);

CREATE OR REPLACE FUNCTION snapshots_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'snapshots is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS snapshots_no_update ON snapshots;
CREATE TRIGGER snapshots_no_update
  BEFORE UPDATE OR DELETE ON snapshots
  FOR EACH ROW EXECUTE FUNCTION snapshots_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE snapshots TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE snapshots FROM collab_app;
  END IF;
END $$;
