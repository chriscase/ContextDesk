# Deploying cd-collab (example)

Working name: `cd-collab`. Rename via `collab/branding.toml` and
`COLLAB_SERVICE_NAME`. This example uses generic hostnames (`db`, `localhost`)
only — no employer-specific hosts (`docs/NON_GOALS.md` item 4).

## Shape

One container/service serves the API and the built React shell. PostgreSQL is
the system of record. Evidence bytes live on a filesystem volume beside the
database (see `collab/README.md` for the backend decision).

## Roles

| Role | Purpose | Privilege |
| --- | --- | --- |
| `postgres` | Compose bootstrap only | Superuser — not used by the app |
| `collab_migrator` | `npm run migrate` | DDL on `public` |
| `collab_app` | Running server | `CONNECT` + DML on app tables |

Passwords and database URLs are **secret-store-sourced**. Copy
`.env.example` to `.env` and replace placeholders from the secret store.

## TLS

This compose file is plaintext on localhost for development. Company hosting
must terminate TLS at the ingress (load balancer or reverse proxy) and forward
HTTP to the app container. The process itself does not terminate TLS in v1
and does not embed internal hostnames. Set `COLLAB_COOKIE_SECURE=1` behind
HTTPS. The directory connection is separate: LDAPS or verified StartTLS only;
plaintext LDAP refuses to boot. CA material is operator-supplied
(`COLLAB_LDAP_CA`). A fixture OpenLDAP seed lives in `openldap/` (example.test
only).

## Local steps

```bash
cd collab
cp deploy/.env.example deploy/.env
# fill secret-store values in deploy/.env
docker compose -f deploy/docker-compose.example.yml --env-file deploy/.env up --build
# in another shell, still from collab/:
set -a && . deploy/.env && set +a
npm run migrate
curl -sS http://127.0.0.1:8787/health
curl -sS http://127.0.0.1:8787/ready
```

Without Docker, install PostgreSQL 16 locally, create the two roles and a
`collab` database (see `init-db.sql`), export the same environment variables,
then from `collab/`:

```bash
npm ci
npm run migrate
npm run build
npm start
```

## Release qualification

From `collab/`, the hermetic suite is `npm run qualify`. It does not need
Docker. PostgreSQL job-lease tests run when `COLLAB_TEST_ADMIN_URL` is set
(as in `collab.yml`). LDAP transport tests remain skip-or-live as documented
in the auth module. Live provider profiles are opt-in via `COLLAB_LIVE_PROFILES`
and are never required. See
[`docs/testing/COLLAB_RELEASE_QUALIFICATION_V1.md`](../../docs/testing/COLLAB_RELEASE_QUALIFICATION_V1.md).

