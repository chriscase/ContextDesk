-- Extend the shipped append-only annotation table; no second metadata store.
ALTER TABLE artifact_annotations ADD COLUMN label_event JSONB;
ALTER TABLE artifact_annotations ADD CONSTRAINT artifact_label_event_checked CHECK (
  label_event IS NULL OR COALESCE((
    jsonb_typeof(label_event) = 'object'
    AND label_event ?& ARRAY['label','operation','sequence','intentKey']
    AND label_event - ARRAY['label','operation','sequence','intentKey'] = '{}'::jsonb
    AND jsonb_typeof(label_event->'label') = 'string'
    AND length(label_event->>'label') BETWEEN 1 AND 120
    AND btrim(label_event->>'label') = label_event->>'label'
    AND jsonb_typeof(label_event->'operation') = 'string'
    AND (label_event->>'label') !~ '[[:cntrl:]]'
    AND translate(label_event->>'label', chr(8203)||chr(8204)||chr(8205)||chr(8206)||chr(8207)||chr(8232)||chr(8233)||chr(8234)||chr(8235)||chr(8236)||chr(8237)||chr(8238)||chr(8288)||chr(8289)||chr(8290)||chr(8291)||chr(8292)||chr(8293)||chr(8294)||chr(8295)||chr(8296)||chr(8297)||chr(65279), '') = label_event->>'label'
    AND label_event->>'operation' IN ('add','remove')
    AND jsonb_typeof(label_event->'sequence') = 'number'
    AND (label_event->>'sequence') ~ '^[0-9]+$'
    AND (label_event->>'sequence')::numeric BETWEEN 1 AND 25000
    AND jsonb_typeof(label_event->'intentKey') = 'string'
    AND (label_event->>'intentKey') ~ '^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$'
  ), false)
);
CREATE UNIQUE INDEX artifact_label_event_case_sequence ON artifact_annotations(case_id, artifact_id, privacy_class, ((label_event->>'sequence')::integer)) WHERE label_event IS NOT NULL;
