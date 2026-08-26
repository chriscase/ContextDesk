-- Investigation-scoped Log workbench: saved views, bookmarks, share-safe
-- locator tokens, and snapshot binding to a log-time corpus revision.
--
-- Views and bookmarks are records, not authorization tokens. Locator tokens
-- are digests of the bound identity; they carry no filename or content.

ALTER TABLE snapshots
  ADD COLUMN IF NOT EXISTS normalization_revision BIGINT;

ALTER TABLE snapshots
  DROP CONSTRAINT IF EXISTS snapshots_normalization_revision_check;
ALTER TABLE snapshots
  ADD CONSTRAINT snapshots_normalization_revision_check
  CHECK (normalization_revision IS NULL OR normalization_revision >= 0);

CREATE TABLE log_workbench_views (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  privacy_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (case_id, idempotency_key),
  CONSTRAINT log_workbench_views_name_check
    CHECK (char_length(name) BETWEEN 1 AND 120),
  CONSTRAINT log_workbench_views_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe')),
  CONSTRAINT log_workbench_views_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT log_workbench_views_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$')
);

CREATE INDEX log_workbench_views_case_idx
  ON log_workbench_views (case_id, created_at, id);

CREATE TABLE log_workbench_bookmarks (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL,
  payload_json TEXT NOT NULL,
  share_safe_token TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  privacy_class TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (case_id, idempotency_key),
  UNIQUE (share_safe_token),
  CONSTRAINT log_workbench_bookmarks_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe')),
  CONSTRAINT log_workbench_bookmarks_token_check
    CHECK (share_safe_token ~ '^[a-f0-9]{64}$'),
  CONSTRAINT log_workbench_bookmarks_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT log_workbench_bookmarks_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$')
);

CREATE INDEX log_workbench_bookmarks_case_idx
  ON log_workbench_bookmarks (case_id, created_at, id);
CREATE INDEX log_workbench_bookmarks_token_idx
  ON log_workbench_bookmarks (share_safe_token);

CREATE TABLE log_workbench_anchors (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  evidence_id UUID NOT NULL,
  line_number BIGINT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (case_id, idempotency_key),
  CONSTRAINT log_workbench_anchors_status_check
    CHECK (status IN ('pinned', 'human_ground_truth')),
  CONSTRAINT log_workbench_anchors_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$')
);

CREATE INDEX log_workbench_anchors_case_idx
  ON log_workbench_anchors (case_id, created_at, id);

CREATE OR REPLACE FUNCTION log_workbench_records_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'log workbench records are insert-only';
END;
$$;

DROP TRIGGER IF EXISTS log_workbench_views_no_update ON log_workbench_views;
CREATE TRIGGER log_workbench_views_no_update
  BEFORE UPDATE OR DELETE ON log_workbench_views
  FOR EACH ROW EXECUTE FUNCTION log_workbench_records_immutable();

DROP TRIGGER IF EXISTS log_workbench_bookmarks_no_update ON log_workbench_bookmarks;
CREATE TRIGGER log_workbench_bookmarks_no_update
  BEFORE UPDATE OR DELETE ON log_workbench_bookmarks
  FOR EACH ROW EXECUTE FUNCTION log_workbench_records_immutable();

DROP TRIGGER IF EXISTS log_workbench_anchors_no_update ON log_workbench_anchors;
CREATE TRIGGER log_workbench_anchors_no_update
  BEFORE UPDATE OR DELETE ON log_workbench_anchors
  FOR EACH ROW EXECUTE FUNCTION log_workbench_records_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE log_workbench_views TO collab_app;
    GRANT SELECT, INSERT ON TABLE log_workbench_bookmarks TO collab_app;
    GRANT SELECT, INSERT ON TABLE log_workbench_anchors TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE log_workbench_views FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE log_workbench_bookmarks FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE log_workbench_anchors FROM collab_app;
  END IF;
END $$;
