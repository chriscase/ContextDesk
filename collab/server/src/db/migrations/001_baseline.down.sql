DROP INDEX IF EXISTS evidence_file_references_uri_idx;
DROP TABLE IF EXISTS evidence_file_references;
DROP TABLE IF EXISTS app_meta;
-- schema_migrations is owned by the migrator; leave it so version tracking survives
-- partial rollbacks. Full reset drops it explicitly in tests when needed.
DELETE FROM schema_migrations WHERE version = '001_baseline';
