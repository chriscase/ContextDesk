CREATE TABLE IF NOT EXISTS case_presence (
  case_id UUID NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  identity_id TEXT NOT NULL,
  username TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('case_board', 'experiment_lab', 'triage_runs')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, identity_id)
);

CREATE INDEX IF NOT EXISTS case_presence_last_seen_idx
  ON case_presence (case_id, last_seen_at);

REVOKE ALL ON TABLE case_presence FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE case_presence TO collab_app;
