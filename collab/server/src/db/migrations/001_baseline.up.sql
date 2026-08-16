-- Baseline schema for the collab modular monolith (#884).
-- App role is least-privilege (SELECT/INSERT/UPDATE/DELETE on app tables only).
-- Migrations run under a separate migrator role (see deploy/.env.example).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO app_meta (key, value)
VALUES ('surface', 'cd-collab')
ON CONFLICT (key) DO NOTHING;

-- Structured registry for controlled file-server references (system of record).
-- Blob bytes live in the filesystem EvidenceStore backend beside the DB.
CREATE TABLE IF NOT EXISTS evidence_file_references (
  id UUID PRIMARY KEY,
  uri TEXT NOT NULL,
  expected_hash TEXT,
  verification_status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evidence_file_references_status_check
    CHECK (verification_status IN ('verified', 'unverified', 'unreachable')),
  CONSTRAINT evidence_file_references_verified_needs_hash
    CHECK (verification_status <> 'verified' OR expected_hash IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS evidence_file_references_uri_idx
  ON evidence_file_references (uri);

-- Least-privilege app role: DML only, and only if the role exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT USAGE ON SCHEMA public TO collab_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app_meta TO collab_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE evidence_file_references TO collab_app;
    GRANT SELECT ON TABLE schema_migrations TO collab_app;
  END IF;
END $$;
