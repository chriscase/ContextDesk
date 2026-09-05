-- Source catalog mutation CAS: optional source revision, insert-only success
-- intents, and capability model v3 (`catalog:write`). Revision is nullable and
-- never backfilled so mixed unversioned/versioned rows remain readable.
-- The upper bound is JavaScript Number.MAX_SAFE_INTEGER so wire u64 values
-- remain exact after a PostgreSQL round-trip.

ALTER TABLE catalog_sources
  ADD COLUMN IF NOT EXISTS revision BIGINT,
  DROP CONSTRAINT IF EXISTS catalog_sources_revision_check,
  ADD CONSTRAINT catalog_sources_revision_check
    CHECK (
      revision IS NULL
      OR (revision >= 1 AND revision <= 9007199254740991)
    );

CREATE TABLE source_catalog_success_intents (
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'retire', 'restore')),
  request_digest TEXT NOT NULL,
  source_id UUID NOT NULL REFERENCES catalog_sources (id),
  success_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (actor_id, idempotency_key),
  CONSTRAINT source_catalog_success_intents_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT source_catalog_success_intents_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'),
  CONSTRAINT source_catalog_success_intents_json_check
    CHECK (jsonb_typeof(success_json::jsonb) = 'object')
);

CREATE OR REPLACE FUNCTION source_catalog_success_intents_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'source_catalog_success_intents is insert-only';
END;
$$;

CREATE TRIGGER source_catalog_success_intents_no_update
  BEFORE UPDATE OR DELETE ON source_catalog_success_intents
  FOR EACH ROW EXECUTE FUNCTION source_catalog_success_intents_immutable();

ALTER TABLE user_capability_grants
  DROP CONSTRAINT user_capability_grants_capability_check,
  ADD CONSTRAINT user_capability_grants_capability_check CHECK (capability IN (
    'investigation:read', 'investigation:write', 'investigation:coordinate',
    'evidence:private:read', 'run:strategies', 'decision:accept',
    'export:create', 'portable:restore', 'catalog:write', 'admin:users',
    'admin:system_config', 'audit:view'
  ));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE source_catalog_success_intents TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE source_catalog_success_intents FROM collab_app;
    -- Any column-level UPDATE privilege permits SELECT FOR UPDATE. Lifecycle
    -- CAS writes name, description, lifecycle, and revision; canonical id,
    -- kind, created_by, and identity_id stay insert-only for the app role.
    REVOKE UPDATE ON TABLE catalog_sources FROM collab_app;
    GRANT UPDATE (name, description, lifecycle, revision) ON TABLE catalog_sources TO collab_app;
  END IF;
END $$;
