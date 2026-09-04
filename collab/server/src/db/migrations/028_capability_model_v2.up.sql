-- Capability model v2 reserves investigation coordination independently of
-- ordinary investigation writes. Replace the closed v1 check atomically;
-- PostgreSQL executes this single ALTER TABLE statement as one transaction.

ALTER TABLE user_capability_grants
  DROP CONSTRAINT user_capability_grants_capability_check,
  ADD CONSTRAINT user_capability_grants_capability_check CHECK (capability IN (
    'investigation:read', 'investigation:write', 'investigation:coordinate',
    'evidence:private:read', 'run:strategies', 'decision:accept',
    'export:create', 'portable:restore', 'admin:users',
    'admin:system_config', 'audit:view'
  ));
