DROP TRIGGER IF EXISTS experiment_trace_annotations_no_update ON experiment_trace_annotations;
DROP TRIGGER IF EXISTS experiment_traces_no_update ON experiment_traces;
DROP FUNCTION IF EXISTS experiment_trace_annotations_immutable();
DROP FUNCTION IF EXISTS experiment_traces_immutable();
DROP TABLE IF EXISTS experiment_trace_annotations;
DROP TABLE IF EXISTS experiment_traces;
