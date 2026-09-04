-- Restore capability model v1. Rollback is intentionally refused by the
-- database if a v2-only grant still exists, rather than deleting authority
-- records silently.

ALTER TABLE user_capability_grants
  DROP CONSTRAINT user_capability_grants_capability_check,
  ADD CONSTRAINT user_capability_grants_capability_check CHECK (capability IN (
    'investigation:read', 'investigation:write', 'evidence:private:read',
    'run:strategies', 'decision:accept', 'export:create', 'portable:restore',
    'admin:users', 'admin:system_config', 'audit:view'
  ));
