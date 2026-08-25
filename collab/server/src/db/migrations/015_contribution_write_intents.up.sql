-- Insert-only contribution write intents: replay identical authorized retries
-- without creating a duplicate durable contribution.

CREATE TABLE contribution_write_intents (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  contribution_id UUID NOT NULL REFERENCES contributions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (case_id, actor_id, idempotency_key),
  CONSTRAINT contribution_write_intents_digest_check
    CHECK (request_digest ~ '^[a-f0-9]{64}$'),
  CONSTRAINT contribution_write_intents_key_check
    CHECK (idempotency_key ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$')
);

CREATE OR REPLACE FUNCTION contribution_write_intents_immutable() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'contribution_write_intents is insert-only';
END;
$$;

DROP TRIGGER IF EXISTS contribution_write_intents_no_update ON contribution_write_intents;
CREATE TRIGGER contribution_write_intents_no_update
  BEFORE UPDATE OR DELETE ON contribution_write_intents
  FOR EACH ROW EXECUTE FUNCTION contribution_write_intents_immutable();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE contribution_write_intents TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE contribution_write_intents FROM collab_app;
  END IF;
END $$;
