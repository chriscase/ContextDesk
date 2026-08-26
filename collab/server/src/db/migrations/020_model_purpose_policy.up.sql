CREATE TABLE model_purpose_policy_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE model_purpose_policy_state TO collab_app;
  END IF;
END $$;
