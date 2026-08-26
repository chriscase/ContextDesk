DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    REVOKE UPDATE (id) ON TABLE experiment_packages FROM collab_app;
  END IF;
END $$;
