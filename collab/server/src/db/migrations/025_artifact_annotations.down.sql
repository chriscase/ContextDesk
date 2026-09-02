DROP TRIGGER IF EXISTS artifact_annotations_no_update ON artifact_annotations;
DROP FUNCTION IF EXISTS artifact_annotations_immutable();
DROP TABLE IF EXISTS artifact_annotations;
DELETE FROM schema_migrations WHERE version = '025_artifact_annotations';
