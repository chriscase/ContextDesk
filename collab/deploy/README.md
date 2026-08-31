# Deploying cd-collab (example)

Working name: `cd-collab`. Rename via `collab/branding.toml` and
`COLLAB_SERVICE_NAME`. This example uses generic hostnames (`db`, `localhost`)
only — no employer-specific hosts (`docs/NON_GOALS.md` item 4).

## Shape

One container/service serves the API and the built React shell. PostgreSQL is
the default system of record. A private single-node deployment may use the
explicit SQLite mode documented in `collab/README.md`; it does not provide
PostgreSQL role separation or multi-worker HA. Evidence bytes live on a
filesystem volume beside the database (`COLLAB_EVIDENCE_ROOT`). A future
S3-compatible evidence-byte backend is not shipped in this example; do not
add unshipped S3 environment names to `.env.example`. The operator guide is
`docs/help/war-room/war-room-s3-evidence-store.md`.

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
HTTPS.

Behind that ingress the socket peer is the proxy, not the user, so also set
`COLLAB_TRUST_PROXY`. It is what makes `request.ip` the real client, and
`request.ip` keys the login rate limiter and is recorded as the audit origin.
Left unset behind a proxy, one user's failed sign-ins rate-limit every other
user and no audit record can attribute an origin. Use the hop count between
this service and the client (`COLLAB_TRUST_PROXY=1` for a single proxy) or the
proxy addresses/CIDRs. Trusting every forwarded address is refused — it would
let any client forge `X-Forwarded-For` and choose its own bucket. Leave it
unset for a directly exposed or loopback deployment.

The directory connection is separate: LDAPS or verified StartTLS only;
plaintext LDAP refuses to boot. Trust anchors are operator-supplied through
`COLLAB_LDAP_CA` as PEM **content** — a filesystem path is refused at startup,
because Node would accept it silently and leave an empty trust store. Setting
it **replaces** the system trust store for the directory connection; to add an
internal CA to system trust instead, leave it unset and start Node with
`NODE_EXTRA_CA_CERTS=/path/to/ca.pem`. A fixture OpenLDAP seed lives in
`openldap/` (example.test only).

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
