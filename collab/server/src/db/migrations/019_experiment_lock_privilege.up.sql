-- PgExperimentStore serializes dependent inserts by locking the immutable
-- experiment identity row. PostgreSQL requires UPDATE privilege for
-- SELECT ... FOR UPDATE, so expose only the trigger-protected id column.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    REVOKE UPDATE ON TABLE experiment_packages FROM collab_app;
    GRANT UPDATE (id) ON TABLE experiment_packages TO collab_app;
  END IF;
END $$;
