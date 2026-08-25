-- Reusable investigation entities, involvement links, authorized
-- cross-investigation references, resolution records, and the occurred-at
-- clock on cases.
--
-- Boundary: nothing here stores evidence, logs, email, chat, or note content.
-- Entities hold reusable labels; involvement, references, and resolutions hold
-- identities, reasons, and clocks. Content stays investigation-scoped in
-- contributions and evidence_artifacts.

-- Occurred-at beside the recording clock. created_at keeps saying when the row
-- was written; occurred_at says when the work actually happened, and stays
-- caller-supplied text so an unknown time zone is never guessed into UTC.
ALTER TABLE cases
  ADD COLUMN IF NOT EXISTS occurred_at TEXT,
  ADD COLUMN IF NOT EXISTS occurred_at_precision TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN IF NOT EXISTS occurred_at_zone TEXT NOT NULL DEFAULT 'unspecified';

ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_occurred_at_precision_check;
ALTER TABLE cases
  ADD CONSTRAINT cases_occurred_at_precision_check
    CHECK (occurred_at_precision IN ('year', 'month', 'day', 'minute', 'second', 'unknown'));

ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_occurred_at_zone_check;
ALTER TABLE cases
  ADD CONSTRAINT cases_occurred_at_zone_check
    CHECK (occurred_at_zone IN ('explicit', 'unspecified'));

-- An absent occurrence is meaningful and must stay internally consistent:
-- no precision or zone claim without a recorded value.
ALTER TABLE cases DROP CONSTRAINT IF EXISTS cases_occurred_at_consistency_check;
ALTER TABLE cases
  ADD CONSTRAINT cases_occurred_at_consistency_check
    CHECK (
      (occurred_at IS NULL AND occurred_at_precision = 'unknown' AND occurred_at_zone = 'unspecified')
      OR (occurred_at IS NOT NULL AND occurred_at_precision <> 'unknown')
    );

CREATE TABLE IF NOT EXISTS investigation_entities (
  id UUID PRIMARY KEY,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  profile_summary TEXT NOT NULL DEFAULT '',
  profile_reference TEXT NOT NULL DEFAULT '',
  privacy_class TEXT NOT NULL DEFAULT 'owner_only',
  lifecycle TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT investigation_entities_kind_check
    CHECK (kind IN ('organization', 'customer', 'person', 'service', 'system', 'other')),
  CONSTRAINT investigation_entities_lifecycle_check
    CHECK (lifecycle IN ('active', 'retired')),
  CONSTRAINT investigation_entities_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe')),
  CONSTRAINT investigation_entities_label_check
    CHECK (char_length(label) BETWEEN 1 AND 200),
  -- Bounded by construction: a column that cannot hold a log will not become
  -- the place someone pastes one.
  CONSTRAINT investigation_entities_profile_bounds_check
    CHECK (char_length(profile_summary) <= 400 AND char_length(profile_reference) <= 120)
);

-- Reusing a label is the point, so the same active label and kind must not be
-- created twice. Retired rows are excluded: they stay for historical
-- attribution and must not block a fresh registration of the same name.
CREATE UNIQUE INDEX IF NOT EXISTS investigation_entities_active_label_key
  ON investigation_entities (kind, lower(label))
  WHERE lifecycle = 'active';

CREATE TABLE IF NOT EXISTS investigation_involvements (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES investigation_entities (id),
  relationship TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  note TEXT NOT NULL DEFAULT '',
  -- Immutable historical attribution. Renaming or retiring the entity later
  -- never rewrites what this investigation recorded.
  recorded_label TEXT NOT NULL,
  recorded_kind TEXT NOT NULL,
  occurred_at TEXT,
  occurred_at_precision TEXT NOT NULL DEFAULT 'unknown',
  occurred_at_zone TEXT NOT NULL DEFAULT 'unspecified',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL,
  recorded_by_username TEXT NOT NULL,
  released_at TIMESTAMPTZ,
  CONSTRAINT investigation_involvements_relationship_check
    CHECK (relationship IN
      ('affected', 'reporting', 'responsible', 'observing', 'referenced', 'other')),
  CONSTRAINT investigation_involvements_state_check
    CHECK (state IN ('active', 'released')),
  CONSTRAINT investigation_involvements_recorded_kind_check
    CHECK (recorded_kind IN ('organization', 'customer', 'person', 'service', 'system', 'other')),
  CONSTRAINT investigation_involvements_note_check
    CHECK (char_length(note) <= 400),
  CONSTRAINT investigation_involvements_release_check
    CHECK (
      (state = 'active' AND released_at IS NULL)
      OR (state = 'released' AND released_at IS NOT NULL)
    ),
  CONSTRAINT investigation_involvements_occurred_at_precision_check
    CHECK (occurred_at_precision IN ('year', 'month', 'day', 'minute', 'second', 'unknown')),
  CONSTRAINT investigation_involvements_occurred_at_zone_check
    CHECK (occurred_at_zone IN ('explicit', 'unspecified')),
  CONSTRAINT investigation_involvements_occurred_at_consistency_check
    CHECK (
      (occurred_at IS NULL AND occurred_at_precision = 'unknown' AND occurred_at_zone = 'unspecified')
      OR (occurred_at IS NOT NULL AND occurred_at_precision <> 'unknown')
    )
);

-- One active involvement per entity, relationship, and investigation. A
-- released link stays as history and does not block re-involving the entity.
CREATE UNIQUE INDEX IF NOT EXISTS investigation_involvements_active_key
  ON investigation_involvements (case_id, entity_id, relationship)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS investigation_involvements_entity_idx
  ON investigation_involvements (entity_id);

CREATE TABLE IF NOT EXISTS investigation_references (
  id UUID PRIMARY KEY,
  from_case_id UUID NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  to_case_id UUID NOT NULL REFERENCES cases (id),
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  locator TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  -- Immutable: what the cited investigation was called when it was cited.
  recorded_title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  occurred_at TEXT,
  occurred_at_precision TEXT NOT NULL DEFAULT 'unknown',
  occurred_at_zone TEXT NOT NULL DEFAULT 'unspecified',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL,
  recorded_by_username TEXT NOT NULL,
  withdrawn_at TIMESTAMPTZ,
  CONSTRAINT investigation_references_not_self_check
    CHECK (from_case_id <> to_case_id),
  CONSTRAINT investigation_references_state_check
    CHECK (state IN ('active', 'withdrawn')),
  CONSTRAINT investigation_references_note_check
    CHECK (char_length(note) <= 600),
  CONSTRAINT investigation_references_withdraw_check
    CHECK (
      (state = 'active' AND withdrawn_at IS NULL)
      OR (state = 'withdrawn' AND withdrawn_at IS NOT NULL)
    ),
  -- The locator is always an in-app absolute path. A scheme, a protocol
  -- relative host, or a traversal segment is rejected at rest, not only in
  -- the contract that wrote it.
  CONSTRAINT investigation_references_locator_check
    CHECK (locator LIKE '/investigations/%' AND locator NOT LIKE '//%' AND position('..' in locator) = 0),
  CONSTRAINT investigation_references_occurred_at_precision_check
    CHECK (occurred_at_precision IN ('year', 'month', 'day', 'minute', 'second', 'unknown')),
  CONSTRAINT investigation_references_occurred_at_zone_check
    CHECK (occurred_at_zone IN ('explicit', 'unspecified')),
  CONSTRAINT investigation_references_occurred_at_consistency_check
    CHECK (
      (occurred_at IS NULL AND occurred_at_precision = 'unknown' AND occurred_at_zone = 'unspecified')
      OR (occurred_at IS NOT NULL AND occurred_at_precision <> 'unknown')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS investigation_references_active_key
  ON investigation_references (from_case_id, to_case_id, resource_kind, resource_id)
  WHERE state = 'active';
CREATE INDEX IF NOT EXISTS investigation_references_to_case_idx
  ON investigation_references (to_case_id);

-- Insert-only resolution history. Superseding appends a revision; it never
-- edits or deletes the reasoning that was recorded before.
CREATE TABLE IF NOT EXISTS investigation_resolutions (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  predecessor_revision INTEGER,
  basis TEXT NOT NULL,
  provenance TEXT NOT NULL,
  status TEXT NOT NULL,
  rationale TEXT NOT NULL,
  unknowns JSONB NOT NULL DEFAULT '[]'::jsonb,
  experiment_decision_id TEXT,
  exception_reason TEXT,
  cited_artifact_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  cited_contribution_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  occurred_at TEXT,
  occurred_at_precision TEXT NOT NULL DEFAULT 'unknown',
  occurred_at_zone TEXT NOT NULL DEFAULT 'unspecified',
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  recorded_by TEXT NOT NULL,
  recorded_by_username TEXT NOT NULL,
  superseded_at TIMESTAMPTZ,
  UNIQUE (case_id, revision),
  CONSTRAINT investigation_resolutions_revision_check
    CHECK (revision >= 1),
  CONSTRAINT investigation_resolutions_predecessor_check
    CHECK (
      (revision = 1 AND predecessor_revision IS NULL)
      OR (revision > 1 AND predecessor_revision = revision - 1)
    ),
  CONSTRAINT investigation_resolutions_basis_check
    CHECK (basis IN ('human_only', 'experiment_decision', 'reasoned_exception')),
  CONSTRAINT investigation_resolutions_provenance_check
    CHECK (provenance IN ('human', 'imported', 'system', 'ai_generated', 'historical_restored')),
  -- A resolution record only ever authorizes a conclusive status.
  CONSTRAINT investigation_resolutions_status_check
    CHECK (status IN ('resolved')),
  CONSTRAINT investigation_resolutions_rationale_check
    CHECK (char_length(rationale) BETWEEN 1 AND 4000),
  -- Each basis owns exactly the fields it needs, so human reasoning can never
  -- be relabelled as a model decision by filling in a spare column.
  CONSTRAINT investigation_resolutions_basis_fields_check
    CHECK (
      (basis = 'experiment_decision'
        AND experiment_decision_id IS NOT NULL AND exception_reason IS NULL)
      OR (basis = 'reasoned_exception'
        AND experiment_decision_id IS NULL AND exception_reason IS NOT NULL)
      OR (basis = 'human_only'
        AND experiment_decision_id IS NULL AND exception_reason IS NULL
        AND provenance <> 'ai_generated')
    ),
  CONSTRAINT investigation_resolutions_unknowns_check
    CHECK (
      jsonb_typeof(unknowns) = 'array'
      AND NOT jsonb_path_exists(unknowns, '$[*] ? (@.type() != "string")')
    ),
  CONSTRAINT investigation_resolutions_occurred_at_precision_check
    CHECK (occurred_at_precision IN ('year', 'month', 'day', 'minute', 'second', 'unknown')),
  CONSTRAINT investigation_resolutions_occurred_at_zone_check
    CHECK (occurred_at_zone IN ('explicit', 'unspecified')),
  CONSTRAINT investigation_resolutions_occurred_at_consistency_check
    CHECK (
      (occurred_at IS NULL AND occurred_at_precision = 'unknown' AND occurred_at_zone = 'unspecified')
      OR (occurred_at IS NOT NULL AND occurred_at_precision <> 'unknown')
    )
);

CREATE UNIQUE INDEX IF NOT EXISTS investigation_resolutions_active_key
  ON investigation_resolutions (case_id)
  WHERE superseded_at IS NULL;

CREATE OR REPLACE FUNCTION investigation_resolutions_insert_only() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'investigation_resolutions is insert-only';
  END IF;
  -- Superseding is the one permitted transition, and only once, in one
  -- direction. Every other column stays exactly as it was recorded.
  IF OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'investigation_resolutions is insert-only';
  END IF;
  IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
    IF (to_jsonb(NEW.*) - 'superseded_at') IS DISTINCT FROM (to_jsonb(OLD.*) - 'superseded_at') THEN
      RAISE EXCEPTION 'investigation_resolutions is insert-only';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS investigation_resolutions_no_rewrite ON investigation_resolutions;
CREATE TRIGGER investigation_resolutions_no_rewrite
  BEFORE UPDATE OR DELETE ON investigation_resolutions
  FOR EACH ROW EXECUTE FUNCTION investigation_resolutions_insert_only();

CREATE OR REPLACE FUNCTION investigation_involvements_history_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'investigation_involvements are released, never deleted';
  END IF;
  -- Historical attribution is immutable: the label and kind recorded at link
  -- time survive every later rename or retirement of the entity.
  IF NEW.recorded_label IS DISTINCT FROM OLD.recorded_label
     OR NEW.recorded_kind IS DISTINCT FROM OLD.recorded_kind
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.entity_id IS DISTINCT FROM OLD.entity_id THEN
    RAISE EXCEPTION 'investigation_involvements historical attribution is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS investigation_involvements_history ON investigation_involvements;
CREATE TRIGGER investigation_involvements_history
  BEFORE UPDATE OR DELETE ON investigation_involvements
  FOR EACH ROW EXECUTE FUNCTION investigation_involvements_history_guard();

CREATE OR REPLACE FUNCTION investigation_references_history_guard() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'investigation_references are withdrawn, never deleted';
  END IF;
  IF NEW.recorded_title IS DISTINCT FROM OLD.recorded_title
     OR NEW.recorded_at IS DISTINCT FROM OLD.recorded_at
     OR NEW.recorded_by IS DISTINCT FROM OLD.recorded_by
     OR NEW.from_case_id IS DISTINCT FROM OLD.from_case_id
     OR NEW.to_case_id IS DISTINCT FROM OLD.to_case_id
     OR NEW.locator IS DISTINCT FROM OLD.locator THEN
    RAISE EXCEPTION 'investigation_references citations are immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS investigation_references_history ON investigation_references;
CREATE TRIGGER investigation_references_history
  BEFORE UPDATE OR DELETE ON investigation_references
  FOR EACH ROW EXECUTE FUNCTION investigation_references_history_guard();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE investigation_entities TO collab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE investigation_involvements TO collab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE investigation_references TO collab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE investigation_resolutions TO collab_app;
    REVOKE DELETE ON TABLE investigation_entities FROM collab_app;
    REVOKE DELETE ON TABLE investigation_involvements FROM collab_app;
    REVOKE DELETE ON TABLE investigation_references FROM collab_app;
    REVOKE DELETE ON TABLE investigation_resolutions FROM collab_app;
  END IF;
END $$;
