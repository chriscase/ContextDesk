-- First-class evidence annotations. Rows are immutable and append-only.

CREATE TABLE IF NOT EXISTS artifact_annotations (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  artifact_id UUID NOT NULL REFERENCES evidence_artifacts (id),
  body TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  privacy_class TEXT NOT NULL DEFAULT 'owner_only',
  author_id TEXT NOT NULL,
  author_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id UUID NOT NULL REFERENCES catalog_sources (id),
  CONSTRAINT artifact_annotations_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe'))
);

CREATE INDEX IF NOT EXISTS artifact_annotations_case_created_idx
  ON artifact_annotations (case_id, created_at ASC, id ASC);

CREATE OR REPLACE FUNCTION artifact_annotations_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artifact_annotations is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS artifact_annotations_no_update ON artifact_annotations;
CREATE TRIGGER artifact_annotations_no_update
  BEFORE UPDATE OR DELETE ON artifact_annotations
  FOR EACH ROW EXECUTE FUNCTION artifact_annotations_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE artifact_annotations TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE artifact_annotations FROM collab_app;
  END IF;
END $$;
