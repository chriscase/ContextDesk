DROP TRIGGER IF EXISTS log_workbench_anchors_no_update ON log_workbench_anchors;
DROP TRIGGER IF EXISTS log_workbench_bookmarks_no_update ON log_workbench_bookmarks;
DROP TRIGGER IF EXISTS log_workbench_views_no_update ON log_workbench_views;
DROP FUNCTION IF EXISTS log_workbench_records_immutable();
DROP TABLE IF EXISTS log_workbench_anchors;
DROP TABLE IF EXISTS log_workbench_bookmarks;
DROP TABLE IF EXISTS log_workbench_views;
ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS snapshots_normalization_revision_check;
ALTER TABLE snapshots DROP COLUMN IF EXISTS normalization_revision;
