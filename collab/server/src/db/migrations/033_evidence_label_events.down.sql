DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM artifact_annotations WHERE label_event IS NOT NULL) THEN
  RAISE EXCEPTION 'cannot roll back 033_evidence_label_events while label history exists';
 END IF;
END $$;
DROP INDEX artifact_label_event_case_sequence;
ALTER TABLE artifact_annotations DROP CONSTRAINT artifact_label_event_checked;
ALTER TABLE artifact_annotations DROP COLUMN label_event;
DELETE FROM schema_migrations WHERE version = '033_evidence_label_events';
