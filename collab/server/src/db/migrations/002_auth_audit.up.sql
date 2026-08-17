-- Auth sessions, group→role map, and insert-only audit (#885).
-- App role: sessions and mapping are ordinary DML; audit is INSERT+SELECT only.

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  identity_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  groups TEXT[] NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sessions_token_hash_idx ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_username_idx ON sessions (username);

CREATE TABLE IF NOT EXISTS authz_group_role_map (
  group_dn TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL,
  CONSTRAINT authz_group_role_map_role_check
    CHECK (role IN ('viewer', 'contributor', 'case-lead', 'admin'))
);

CREATE TABLE IF NOT EXISTS audit_events (
  id BIGSERIAL PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  identity TEXT,
  action TEXT NOT NULL,
  target TEXT,
  origin TEXT,
  outcome TEXT NOT NULL,
  CONSTRAINT audit_events_outcome_check
    CHECK (outcome IN ('success', 'denied', 'failure'))
);

CREATE INDEX IF NOT EXISTS audit_events_at_idx ON audit_events (at);
CREATE INDEX IF NOT EXISTS audit_events_action_idx ON audit_events (action);

CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS audit_events_no_update ON audit_events;
CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE sessions TO collab_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE authz_group_role_map TO collab_app;
    GRANT SELECT, INSERT ON TABLE audit_events TO collab_app;
    GRANT USAGE, SELECT ON SEQUENCE audit_events_id_seq TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE audit_events FROM collab_app;
  END IF;
END $$;
