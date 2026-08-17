-- Runs as the compose bootstrap superuser once, then the app never uses it.
-- App role: DML only. Migrator role: DDL. Neither is a superuser.

CREATE ROLE collab_migrator LOGIN PASSWORD 'replace-from-secret-store';
CREATE ROLE collab_app LOGIN PASSWORD 'replace-from-secret-store';

GRANT CONNECT ON DATABASE collab TO collab_migrator;
GRANT CONNECT ON DATABASE collab TO collab_app;

GRANT CREATE, USAGE ON SCHEMA public TO collab_migrator;
GRANT USAGE ON SCHEMA public TO collab_app;
