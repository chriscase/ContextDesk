-- Canonical user profiles + local capability grants (identity/administration
-- foundation). Provenance-aware: local/ldap/oidc profiles are ordinary DML;
-- imported_historical profiles are attribution-only stubs that application
-- logic never authenticates and never grants capabilities to (see
-- collab/contracts/src/user-profile.ts isProfileFieldSelfEditable and the
-- admin-people grant routes, which refuse that provenance outright).

CREATE TABLE user_profiles (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role_title TEXT,
  team TEXT,
  contact_email TEXT,
  contact_other TEXT,
  avatar_kind TEXT CHECK (avatar_kind IN ('initials', 'url')),
  avatar_value TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'disabled')),
  provenance TEXT NOT NULL CHECK (provenance IN ('local', 'ldap', 'oidc', 'imported_historical')),
  directory_subject TEXT,
  directory_sync_status TEXT NOT NULL DEFAULT 'not_synced'
    CHECK (directory_sync_status IN ('not_synced', 'synced', 'stale', 'error', 'disabled')),
  directory_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ,
  custom_attributes JSONB NOT NULL DEFAULT '[]'::jsonb,
  revision INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT user_profiles_avatar_pair CHECK ((avatar_kind IS NULL) = (avatar_value IS NULL)),
  CONSTRAINT user_profiles_directory_subject_required
    CHECK (provenance = 'local' OR directory_subject IS NOT NULL),
  CONSTRAINT user_profiles_local_not_synced
    CHECK (provenance <> 'local' OR directory_sync_status = 'not_synced')
);

-- Case-insensitive: prevents a duplicate principal created only by case
-- variation (e.g. "Alice" vs "alice") from silently coexisting.
CREATE UNIQUE INDEX user_profiles_username_lower_idx ON user_profiles (lower(username));
CREATE UNIQUE INDEX user_profiles_directory_subject_idx
  ON user_profiles (directory_subject) WHERE directory_subject IS NOT NULL;
CREATE INDEX user_profiles_status_idx ON user_profiles (status);
CREATE INDEX user_profiles_provenance_idx ON user_profiles (provenance);

CREATE TABLE user_capability_grants (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES user_profiles (id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability IN (
    'investigation:read', 'investigation:write', 'evidence:private:read',
    'run:strategies', 'decision:accept', 'export:create', 'portable:restore',
    'admin:users', 'admin:system_config', 'audit:view'
  )),
  granted_by TEXT NOT NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, capability)
);

CREATE INDEX user_capability_grants_user_idx ON user_capability_grants (user_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'collab_app') THEN
    -- Profiles are lifecycle-managed via status (active/suspended/disabled),
    -- never hard-deleted: past attribution must keep resolving.
    GRANT SELECT, INSERT, UPDATE ON TABLE user_profiles TO collab_app;
    REVOKE DELETE ON TABLE user_profiles FROM collab_app;
    GRANT SELECT, INSERT, DELETE ON TABLE user_capability_grants TO collab_app;
    GRANT USAGE, SELECT ON SEQUENCE user_capability_grants_id_seq TO collab_app;
  END IF;
END $$;
