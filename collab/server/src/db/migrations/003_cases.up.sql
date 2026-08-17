-- Cases, append-only timeline, contribution revisions, evidence metadata (#886).
-- Contribution content lives only in contribution_revisions (insert-only).

CREATE TABLE IF NOT EXISTS cases (
  id UUID PRIMARY KEY,
  title TEXT NOT NULL,
  severity TEXT NOT NULL,
  status TEXT NOT NULL,
  legal_hold BOOLEAN NOT NULL DEFAULT false,
  retention_class TEXT NOT NULL DEFAULT 'standard',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  created_by_username TEXT NOT NULL,
  last_seq BIGINT NOT NULL DEFAULT 0,
  CONSTRAINT cases_status_check
    CHECK (status IN ('open', 'monitoring', 'resolved', 'archived')),
  CONSTRAINT cases_severity_check
    CHECK (severity IN ('low', 'medium', 'high', 'critical'))
);

CREATE TABLE IF NOT EXISTS case_participants (
  case_id UUID NOT NULL REFERENCES cases (id),
  identity_id TEXT NOT NULL,
  username TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by TEXT NOT NULL,
  PRIMARY KEY (case_id, identity_id)
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id BIGSERIAL PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  seq BIGINT NOT NULL,
  kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_username TEXT NOT NULL,
  target_id TEXT,
  client_time TIMESTAMPTZ,
  server_time TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL DEFAULT '{}',
  UNIQUE (case_id, seq)
);

CREATE TABLE IF NOT EXISTS contributions (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  kind TEXT NOT NULL,
  privacy_class TEXT NOT NULL DEFAULT 'owner_only',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL,
  created_by_username TEXT NOT NULL,
  CONSTRAINT contributions_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe'))
);

CREATE TABLE IF NOT EXISTS contribution_revisions (
  contribution_id UUID NOT NULL REFERENCES contributions (id),
  revision INT NOT NULL,
  predecessor_revision INT,
  author_id TEXT NOT NULL,
  author_username TEXT NOT NULL,
  body TEXT,
  content_hash TEXT NOT NULL,
  tombstone BOOLEAN NOT NULL DEFAULT false,
  hypothesis_status TEXT,
  hypothesis_links JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contribution_id, revision)
);

CREATE TABLE IF NOT EXISTS evidence_artifacts (
  id UUID PRIMARY KEY,
  case_id UUID NOT NULL REFERENCES cases (id),
  kind TEXT NOT NULL,
  filename TEXT,
  uri TEXT,
  media_type TEXT,
  byte_length INT,
  content_hash TEXT,
  expected_hash TEXT,
  verification_status TEXT,
  ref_id TEXT,
  privacy_class TEXT NOT NULL DEFAULT 'owner_only',
  summary_contribution_id UUID REFERENCES contributions (id),
  uploader_id TEXT NOT NULL,
  uploader_username TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evidence_artifacts_privacy_check
    CHECK (privacy_class IN ('owner_only', 'share_safe'))
);

CREATE OR REPLACE FUNCTION timeline_events_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'timeline_events is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS timeline_events_no_update ON timeline_events;
CREATE TRIGGER timeline_events_no_update
  BEFORE UPDATE OR DELETE ON timeline_events
  FOR EACH ROW EXECUTE FUNCTION timeline_events_immutable();

CREATE OR REPLACE FUNCTION contribution_revisions_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'contribution_revisions is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS contribution_revisions_no_update ON contribution_revisions;
CREATE TRIGGER contribution_revisions_no_update
  BEFORE UPDATE OR DELETE ON contribution_revisions
  FOR EACH ROW EXECUTE FUNCTION contribution_revisions_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE cases TO collab_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE case_participants TO collab_app;
    GRANT SELECT, INSERT ON TABLE timeline_events TO collab_app;
    GRANT SELECT, INSERT ON TABLE contributions TO collab_app;
    GRANT SELECT, INSERT ON TABLE contribution_revisions TO collab_app;
    GRANT SELECT, INSERT ON TABLE evidence_artifacts TO collab_app;
    GRANT USAGE, SELECT ON SEQUENCE timeline_events_id_seq TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE timeline_events FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE contribution_revisions FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE evidence_artifacts FROM collab_app;
    REVOKE UPDATE, DELETE ON TABLE contributions FROM collab_app;
  END IF;
END $$;
