-- Record that the persisted group→role map has been initialized.
-- This keeps an explicit environment bootstrap from being reapplied after revoke.

CREATE TABLE IF NOT EXISTS authz_group_role_map_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  initialized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  initialized_by TEXT NOT NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT ON TABLE authz_group_role_map_state TO collab_app;
  END IF;
END $$;
