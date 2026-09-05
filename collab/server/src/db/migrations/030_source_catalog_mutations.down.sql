-- Match the mutator's intent-lookup-before-source-row access order so rollback
-- cannot introduce an avoidable lock-order inversion with an in-flight write.
-- Refuse while any versioned row, success intent, or catalog:write grant exists.
-- Never delete those rows to make rollback pass.

LOCK TABLE source_catalog_success_intents IN ACCESS EXCLUSIVE MODE;
LOCK TABLE catalog_sources IN ACCESS EXCLUSIVE MODE;
LOCK TABLE user_capability_grants IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM catalog_sources WHERE revision IS NOT NULL)
     OR EXISTS (SELECT 1 FROM source_catalog_success_intents LIMIT 1)
     OR EXISTS (
       SELECT 1 FROM user_capability_grants WHERE capability = 'catalog:write'
     ) THEN
    RAISE EXCEPTION
      'cannot roll back 030_source_catalog_mutations while versioned catalog data, success intents, or catalog:write grants exist';
  END IF;
END $$;

DROP TRIGGER IF EXISTS source_catalog_success_intents_no_update
  ON source_catalog_success_intents;
DROP FUNCTION IF EXISTS source_catalog_success_intents_immutable();
DROP TABLE IF EXISTS source_catalog_success_intents;

ALTER TABLE catalog_sources
  DROP CONSTRAINT IF EXISTS catalog_sources_revision_check,
  DROP COLUMN IF EXISTS revision;

-- Restore the migration-004 privilege shape exactly after removing the
-- revision/CAS boundary. The up migration deliberately narrows this grant.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT UPDATE ON TABLE catalog_sources TO collab_app;
  END IF;
END $$;

ALTER TABLE user_capability_grants
  DROP CONSTRAINT user_capability_grants_capability_check,
  ADD CONSTRAINT user_capability_grants_capability_check CHECK (capability IN (
    'investigation:read', 'investigation:write', 'investigation:coordinate',
    'evidence:private:read', 'run:strategies', 'decision:accept',
    'export:create', 'portable:restore', 'admin:users',
    'admin:system_config', 'audit:view'
  ));

DELETE FROM schema_migrations WHERE version = '030_source_catalog_mutations';
