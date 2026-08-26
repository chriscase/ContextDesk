-- Investigation-scoped software impact claims.
--
-- These are human-maintained labels and epistemic statuses, not version
-- comparisons. Records are retained after release so historical triage
-- context remains readable. The active identity index prevents two hosted
-- writers from recording the same claim concurrently.

CREATE TABLE investigation_software_impact (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  product_name TEXT NOT NULL,
  version TEXT NOT NULL,
  build TEXT NOT NULL,
  component TEXT NOT NULL,
  environment TEXT NOT NULL,
  status TEXT NOT NULL,
  note TEXT NOT NULL,
  state TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL,
  recorded_by TEXT NOT NULL,
  recorded_by_username TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CONSTRAINT investigation_software_impact_status_check
    CHECK (status IN ('observed', 'suspected', 'confirmed', 'ruled_out')),
  CONSTRAINT investigation_software_impact_state_check
    CHECK (state IN ('active', 'released')),
  CONSTRAINT investigation_software_impact_identity_check
    CHECK (
      product_name <> '' OR version <> '' OR build <> '' OR
      component <> '' OR environment <> ''
    ),
  CONSTRAINT investigation_software_impact_release_check
    CHECK ((state = 'active' AND released_at IS NULL) OR
           (state = 'released' AND released_at IS NOT NULL))
);

CREATE INDEX investigation_software_impact_case_idx
  ON investigation_software_impact (case_id, recorded_at, id);

CREATE UNIQUE INDEX investigation_software_impact_active_identity_idx
  ON investigation_software_impact (
    case_id,
    lower(product_name),
    lower(version),
    lower(build),
    lower(component),
    lower(environment)
  )
  WHERE state = 'active';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE investigation_software_impact TO collab_app;
    REVOKE DELETE ON TABLE investigation_software_impact FROM collab_app;
  END IF;
END $$;
