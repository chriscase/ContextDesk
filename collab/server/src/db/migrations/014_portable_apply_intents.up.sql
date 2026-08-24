CREATE TABLE portable_apply_intents (
  token_hash TEXT PRIMARY KEY CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  actor_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  transport_hash TEXT NOT NULL CHECK (transport_hash ~ '^[a-f0-9]{64}$'),
  semantic_fingerprint TEXT NOT NULL CHECK (semantic_fingerprint ~ '^[a-f0-9]{64}$'),
  destination_catalog_digest TEXT NOT NULL CHECK (destination_catalog_digest ~ '^[a-f0-9]{64}$'),
  identity_map_digest TEXT NOT NULL CHECK (identity_map_digest ~ '^[a-f0-9]{64}$'),
  materialized_content_digest TEXT NOT NULL CHECK (materialized_content_digest ~ '^[a-f0-9]{64}$'),
  collision_policy TEXT NOT NULL CHECK (collision_policy IN ('fail', 'remap_deterministic')),
  expires_at TIMESTAMPTZ NOT NULL,
  applied_investigation_id UUID NULL REFERENCES cases(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_at TIMESTAMPTZ NULL
);

CREATE INDEX portable_apply_intents_replay_idx
  ON portable_apply_intents (actor_id, installation_id, transport_hash, applied_at)
  WHERE applied_investigation_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE portable_apply_intents TO collab_app;
    REVOKE DELETE ON TABLE portable_apply_intents FROM collab_app;
  END IF;
END $$;
