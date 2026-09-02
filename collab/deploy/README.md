# Deploying cd-collab (example)

Working name: `cd-collab`. Rename via `collab/branding.toml` and
`COLLAB_SERVICE_NAME`. This example uses generic hostnames (`db`, `localhost`)
only — no employer-specific hosts (`docs/NON_GOALS.md` item 4).

## Shape

One container/service serves the API and the built React shell. PostgreSQL is
the default system of record. A private single-node deployment may use the
explicit SQLite mode documented in `collab/README.md`; it does not provide
PostgreSQL role separation or multi-worker HA. Evidence bytes use a filesystem
volume beside the database (`COLLAB_EVIDENCE_ROOT`) by default. The commented
S3 block in `.env.example` documents the shipped S3-compatible backend. To
select it in this Compose example, set those values and enable the matching
commented `app.environment` mappings in `docker-compose.example.yml`; the local
root remains server-owned control state. The operator contract,
least-privilege actions, and qualification sequence are in
`docs/help/war-room/war-room-s3-evidence-store.md`. Selecting S3 does not
migrate bytes already stored on the filesystem.

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

`--env-file` supplies Compose substitutions; it does not inject every name in
that file into the `app` container. For S3, uncomment the matching
`COLLAB_EVIDENCE_...` mappings under `app.environment` after setting their
substitution values. Enable only the names selected for the deployment:
present-but-empty optional S3 names are invalid, and filesystem mode rejects
every present S3 name. `COLLAB_EVIDENCE_MAX_UPLOAD_BYTES` is accepted in both
modes. Filesystem defaults to 512 MiB and retains the 5 GiB protocol ceiling.
S3 v1 defaults to 30 MiB at the 30,000 ms timeout and validates at most
`floor(COLLAB_EVIDENCE_S3_TIMEOUT_MS / 1000) * 1 MiB` (up to 120 MiB at the
120,000 ms timeout). Smithy's `requestTimeout` is absolute through PutObject
and multipart request response headers. The 1 MiB/s relationship is a conservative
validation envelope, not a success guarantee; actual networks and providers
may need a lower max. The separate HTTP transfer guard remains one hour and
unknown-length streams remain count-enforced. Multipart upload is used for
streams above one SDK part; the 5 GiB value is a protocol ceiling, not a
supported S3 v1 operating size. Legacy
JSON/base64 upload and JSON bytes download stay capped at 1,000,000 decoded
bytes. This does not add retention or filesystem-to-S3 migration.

Run `npm run doctor` with the intended environment before startup. For S3 it
validates names, credential sources, the custom CA file, bounds, and the local
control root, but deliberately does not contact the bucket. Server startup then
selects the configured backend, pings it, and completes pending-write recovery
before listening. `/health` is process liveness; `/ready` checks the database
and the selected evidence backend. Neither replaces a normal authenticated War
Room upload, metadata read, byte download, and SHA-256 comparison.

`COLLAB_EVIDENCE_S3_CA_FILE` is an optional absolute PEM bundle mounted into
the War Room process. The S3 request handler passes it as Node's TLS `ca`
option, which **replaces** the default trust store for that S3 connection
only. Operators who need public roots and an internal CA must provide one
combined PEM bundle and keep certificate verification enabled. This does not
change directory TLS (`COLLAB_LDAP_CA` / `NODE_EXTRA_CA_CERTS`) or ingress
TLS. A custom CA cannot authenticate plaintext: configuration rejects
`COLLAB_EVIDENCE_S3_CA_FILE` when the S3 endpoint uses HTTP.

The example Compose file does not include Garage. From the `app` container,
`127.0.0.1` is the app container itself. Put War Room and the object store on
the same explicitly controlled network and use the object-store service name,
or use a reachable private endpoint. Service names do not resolve across
separate Compose project networks unless both projects join a named shared
network. Plain HTTP still requires `COLLAB_EVIDENCE_S3_ALLOW_HTTP=1` and is for
trusted local evaluation only.

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
