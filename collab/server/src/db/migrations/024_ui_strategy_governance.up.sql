CREATE TABLE ui_strategy_policy_state (
  id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id = TRUE),
  revision BIGINT NOT NULL CHECK (revision > 0),
  policy JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE ui_strategy_policy_history (
  revision BIGINT PRIMARY KEY CHECK (revision > 0),
  policy JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE ui_strategy_preferences (
  user_id TEXT PRIMARY KEY REFERENCES user_profiles (id),
  strategy_id TEXT NOT NULL CHECK (strategy_id IN (
    'war-room', 'investigation-first', 'keystone', 'beacon'
  )),
  revision BIGINT NOT NULL CHECK (revision > 0),
  updated_at TIMESTAMPTZ NOT NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE ui_strategy_policy_state TO collab_app;
    REVOKE DELETE ON TABLE ui_strategy_policy_state FROM collab_app;
    GRANT SELECT, INSERT ON TABLE ui_strategy_policy_history TO collab_app;
    REVOKE UPDATE, DELETE ON TABLE ui_strategy_policy_history FROM collab_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE ui_strategy_preferences TO collab_app;
    REVOKE DELETE ON TABLE ui_strategy_preferences FROM collab_app;
  END IF;
END $$;
