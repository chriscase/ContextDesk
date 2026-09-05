-- Operations Queue V1 records one materialized coordinator per investigation.
-- The case row is the transaction serializer; this table therefore needs no
-- advisory-lock key or lease state.

CREATE TABLE investigation_coordination (
  case_id UUID PRIMARY KEY REFERENCES cases(id) ON DELETE CASCADE,
  coordinator_identity_id TEXT,
  coordinator_username TEXT,
  revision BIGINT NOT NULL CHECK (revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by_identity_id TEXT NOT NULL,
  updated_by_username TEXT NOT NULL,
  CONSTRAINT investigation_coordination_coordinator_pair_check CHECK (
    (coordinator_identity_id IS NULL AND coordinator_username IS NULL)
    OR (coordinator_identity_id IS NOT NULL AND coordinator_username IS NOT NULL)
  )
);

-- Only committed successes are replayable. TEXT preserves the exact JSON byte
-- sequence returned on the original success; jsonb is used only to validate
-- that the stored value is an object.
CREATE TABLE investigation_coordination_success_intents (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN (
    'claim_self', 'release_self', 'assign_participant', 'release_participant'
  )),
  target_identity_id TEXT,
  success_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (case_id, actor_id, idempotency_key),
  CONSTRAINT investigation_coordination_success_intents_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'),
  CONSTRAINT investigation_coordination_success_intents_target_check CHECK (
    (action IN ('claim_self', 'release_self') AND target_identity_id IS NULL)
    OR (action IN ('assign_participant', 'release_participant') AND target_identity_id IS NOT NULL)
  ),
  CONSTRAINT investigation_coordination_success_intents_json_check
    CHECK (jsonb_typeof(success_json::jsonb) = 'object')
);

CREATE OR REPLACE FUNCTION investigation_coordination_success_intents_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'investigation_coordination_success_intents is insert-only';
END;
$$;

CREATE TRIGGER investigation_coordination_success_intents_no_update
  BEFORE UPDATE OR DELETE ON investigation_coordination_success_intents
  FOR EACH ROW EXECUTE FUNCTION investigation_coordination_success_intents_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE investigation_coordination TO collab_app;
    GRANT SELECT, INSERT ON TABLE investigation_coordination_success_intents TO collab_app;
    REVOKE DELETE ON TABLE investigation_coordination FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE investigation_coordination_success_intents FROM collab_app;
  END IF;
END $$;
