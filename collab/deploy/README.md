# Deploying cd-collab (example)

Working name: `cd-collab`. Rename via `collab/branding.toml` and
`COLLAB_SERVICE_NAME`. This example uses generic hostnames (`db`, `localhost`)
only — no employer-specific hosts (`docs/NON_GOALS.md` item 4).

## Shape

One container/service serves the API and the built React shell. PostgreSQL is
the default system of record. A private single-node deployment may use the
explicit SQLite mode documented in `collab/README.md`; it does not provide
PostgreSQL role separation or multi-worker HA. Evidence bytes live on a
filesystem volume beside the database.

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
curl -sS http://127.0.0.1:8787/health
curl -sS http://127.0.0.1:8787/ready
```

The Compose `migrate` one-shot service applies migrations inside the Compose
network before `app` starts. To apply a later migration manually, use
`docker compose -f deploy/docker-compose.example.yml --env-file deploy/.env run
--rm migrate` rather than running the host shell command against the Compose
hostname.

Without Docker, install PostgreSQL 16 locally, create the two roles and a
`collab` database (see `init-db.sql`), export the same environment variables,
then from `collab/`:

```bash
npm ci
npm run migrate
npm run build
npm start
```
