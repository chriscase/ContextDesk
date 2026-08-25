-- Case-bound log corpora and their per-source timezone review record.
--
-- The host corpus owns the timestamps. These tables own what the host cannot
-- know: which corpus belongs to which case, who declared each zone against
-- which preview fingerprint, and what each time change did to work that had
-- already been produced.

CREATE TABLE log_corpora (
  case_id UUID PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  corpus_id TEXT NOT NULL,
  corpus_name TEXT NOT NULL,
  privacy_class TEXT NOT NULL,
  corpus_revision BIGINT NOT NULL,
  -- Revision whose content a one-step undo would restore. NULL before the
  -- first durable change.
  undoable_revision BIGINT,
  built_at TIMESTAMPTZ NOT NULL,
  built_by TEXT NOT NULL,
  CONSTRAINT log_corpora_corpus_id_check
    CHECK (corpus_id ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'),
  CONSTRAINT log_corpora_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe')),
  CONSTRAINT log_corpora_revision_check CHECK (corpus_revision >= 0),
  CONSTRAINT log_corpora_undo_check
    CHECK (undoable_revision IS NULL OR undoable_revision < corpus_revision)
);

CREATE TABLE log_time_declarations (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  iana_timezone TEXT NOT NULL,
  basis TEXT NOT NULL,
  declared_at BIGINT NOT NULL,
  applied_revision BIGINT NOT NULL,
  declaration_fingerprint TEXT NOT NULL,
  declared_by TEXT NOT NULL,
  PRIMARY KEY (case_id, source),
  CONSTRAINT log_time_declarations_basis_check
    CHECK (basis IN ('user_declared', 'configured_default')),
  CONSTRAINT log_time_declarations_fingerprint_check
    CHECK (declaration_fingerprint ~ '^[a-f0-9]{64}$'),
  -- A source identity is always corpus-relative; an absolute or traversing
  -- path can never become a durable declaration.
  CONSTRAINT log_time_declarations_source_check
    CHECK (source <> '' AND source NOT LIKE '/%' AND source NOT LIKE '%..%')
);

CREATE TABLE log_time_operations (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  operation TEXT NOT NULL,
  source TEXT,
  previous_revision BIGINT NOT NULL,
  applied_revision BIGINT NOT NULL,
  restored_revision BIGINT,
  changed_records BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  created_by TEXT NOT NULL,
  UNIQUE (case_id, idempotency_key),
  CONSTRAINT log_time_operations_operation_check
    CHECK (operation IN ('apply', 'clear', 'undo')),
  CONSTRAINT log_time_operations_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT log_time_operations_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'),
  -- Every durable change advances the revision, undo included: the pipeline
  -- publishes a new revision carrying earlier content rather than deleting it.
  CONSTRAINT log_time_operations_advance_check
    CHECK (applied_revision > previous_revision),
  CONSTRAINT log_time_operations_restore_check
    CHECK (
      (operation = 'undo' AND restored_revision IS NOT NULL
        AND restored_revision < previous_revision)
      OR (operation <> 'undo' AND restored_revision IS NULL)
    )
);

CREATE TABLE log_time_dependents (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  operation_id UUID NOT NULL REFERENCES log_time_operations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  dependent_id TEXT NOT NULL,
  disposition TEXT NOT NULL,
  reason TEXT NOT NULL,
  observed_revision BIGINT,
  PRIMARY KEY (operation_id, kind, dependent_id),
  CONSTRAINT log_time_dependents_kind_check
    CHECK (kind IN ('snapshot', 'triage_run')),
  CONSTRAINT log_time_dependents_disposition_check
    CHECK (disposition IN ('unaffected', 'revised', 'invalidated', 'unknown_basis')),
  -- unknown_basis means exactly that: no recorded revision to point at.
  CONSTRAINT log_time_dependents_unknown_check
    CHECK (disposition <> 'unknown_basis' OR observed_revision IS NULL)
);

CREATE INDEX log_time_dependents_case_idx
  ON log_time_dependents (case_id, kind, dependent_id);

-- The dependent record is written once, at the moment of the change, so the
-- War Room can report what was true then. It is append-only.
CREATE OR REPLACE FUNCTION log_time_dependents_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'log_time_dependents is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS log_time_dependents_no_update ON log_time_dependents;
CREATE TRIGGER log_time_dependents_no_update
  BEFORE UPDATE ON log_time_dependents
  FOR EACH ROW EXECUTE FUNCTION log_time_dependents_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE log_corpora TO collab_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE log_time_declarations TO collab_app;
    GRANT SELECT, INSERT ON TABLE log_time_operations TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE log_time_operations FROM collab_app;
    GRANT SELECT, INSERT ON TABLE log_time_dependents TO collab_app;
    REVOKE UPDATE ON TABLE log_time_dependents FROM collab_app;
  END IF;
END $$;
