# cd-collab

Separately deployable collaboration and case-memory layer (working name;
rename-friendly via `collab/branding.toml` and `COLLAB_SERVICE_NAME`). This
directory is an **npm workspace independent of** the Rust workspace,
`desktop/`, and `packages/` builds. It must not import cd-core, desktop, bench,
or crate internals. Published `packages/contracts` artifacts may be consumed
read-only later; v1 does not.

Parent epic: #883. Skeleton is #884. Auth/authz/audit is #885. Cases/timeline
is #886. Import/export are later slices.

## Layout

| Path | Role |
| --- | --- |
| `contracts/` | Versioned TypeScript types + JSON Schemas (`additionalProperties: false`) |
| `server/` | Node.js LTS + TypeScript (strict) backend |
| `web/` | React + Vite UI shell, served as static assets by the server |
| `server/src/modules/*` | Modular-monolith boundaries (lint-enforced) |
| `server/src/db/migrations/` | Versioned, reviewed SQL |
| `deploy/` | Example compose, env template, Dockerfile |

## Decisions

### HTTP framework: Fastify 5

Criteria:

1. First-class TypeScript types and schema-aware serialization.
2. Plugin model that maps cleanly onto later module registration (#885+).
3. Low-overhead `/health` and `/ready` without a framework adapter layer.
4. Suggested by #884; Express was rejected for weaker schema defaults and
   slower JSON; Nest was rejected as too much IoC for a skeleton.

### Migration tool: in-tree SQL runner (`server/src/db/migrate.ts`)

Criteria:

1. Reviewed `.up.sql` / `.down.sql` pairs in git — no generated JS migrations.
2. Explicit `up`, `down`, and `--dry-run` (prints pending SQL, applies nothing).
3. No extra SaaS CLI or shadow-database dependency for v1.
4. `node-pg-migrate` / Prisma were deferred: they pull generators and hide SQL
   that this repo prefers to review as text.

### v1 EvidenceStore backend: filesystem beside the database

The `EvidenceStore` interface is pluggable (`put` / `get` / `head` / `verify`
plus file-server references). v1 ships **exactly one** byte-storage backend:
content-addressed files under `COLLAB_EVIDENCE_ROOT`.

| Criterion | Filesystem | PostgreSQL large objects |
| --- | --- | --- |
| Backup story | Volume snapshot + `pg_dump`; bytes and rows stay separable | Bytes trapped in the WAL/dump; restore couples DB size to attachments |
| Size ceiling | Ordinary files; large logs/zips do not inflate PostgreSQL | Practical LO / TOAST pressure on a single primary |
| Ops simplicity | Inspectable paths; clear later seam to object storage | Requires `lo_*` tooling and a superuser-adjacent operator story |

Object storage is a later backend behind the same interface, not MVP.
Deletion is intentionally absent: later retention work must leave an auditable
stub (domain slice). File-server references stay references — the store never
silently fetches or caches remote bytes. Verification against an expected hash
is an explicit, recorded operation. A reference whose target was never hashed
(`expectedHash: null`) is representable and stays `unverified` or
`unreachable`; it is never silently treated as `verified`.

### Auth: bind-through LDAP over encrypted transport only (#885)

- `AuthAdapter.authenticate(username, password)` lives in `modules/auth`.
  Passwords exist in memory only for the bind. No hashing, caching, storage, or
  logging. No other module may import `ldapts` or read a password field
  (enforced by `password-isolation.test.ts`).
- Transport: `ldaps://` or `ldap://` + StartTLS. Plaintext is refused at
  `loadLdapConfig`. Disabling TLS verification requires explicit
  `COLLAB_LDAP_DEV_MODE=1` (fixture only).
- Optional service-bind (`COLLAB_LDAP_BIND_DN` / `COLLAB_LDAP_BIND_PASSWORD`) is
  secret-store-sourced and never written to the DB, logs, or audit.
- Sessions: opaque `HttpOnly` `SameSite=Lax` cookies; server-side store;
  TTL + idle timeout; revocation is immediate. No JWTs.
- Group→role map is config (`COLLAB_GROUP_ROLE_MAP`); unmapped users are
  default-deny. Roles are recomputed from the current map on every request.
- Audit is insert-only (`audit_events` trigger + app-role grants). Failed
  logins are rate-limited and return the same `invalid_credentials` body
  whether the account exists.
- CSRF: same-origin SPA + `SameSite=Lax`. TLS terminates at ingress;
  set `COLLAB_COOKIE_SECURE=1` behind HTTPS.
- MFA and SSO/OIDC are out of v1 (adapter seam only). MFA is a directory/VPN
  responsibility.

### Cases, timeline, evidence, provenance (#886)

- A case has title, severity, status (`open` / `monitoring` / `resolved` /
  `archived`), participants, retention class, and a legal-hold flag.
- The timeline is append-only with server-assigned `seq`. Client-supplied time
  is stored and never used for order.
- Contributions (`message` / `note` / `hypothesis` / `action` / `upload`) are
  attributed to the #885 identity. Edits are new revisions; deletes are
  tombstones. `contribution_revisions` is insert-only at the DB.
- Held artifacts store original bytes in `EvidenceStore`. Summaries are
  separate contributions. File-server re-checks are timeline events and do
  not mutate the registered record.
- Privacy class defaults to `owner_only`; `share_safe` is explicit.
- A `supported` hypothesis must link at least one artifact or contribution.
- Legal hold refuses content deletion (tombstone).
- Process memory is PostgreSQL via `PgCaseStore` (HTTP tests also cover the
  in-memory store). `contribution_revisions` and `timeline_events` are
  insert-only (trigger + app-role grants).

## Module boundaries

`server/src/modules/{auth,authz,audit,cases,contributions,evidence,provenance,catalog,import,export}`
are reserved. Other code may depend on a module only through that module's
`index.ts`. Cross-module deep imports fail `eslint-plugin-boundaries`
(`boundaries/entry-point`). See `server/src/modules/boundaries.test.ts`.

## Local PostgreSQL

```bash
cd collab
npm ci
export COLLAB_DATABASE_URL=postgres://collab_app:replace-from-secret-store@127.0.0.1:5432/collab
export COLLAB_MIGRATE_DATABASE_URL=postgres://collab_migrator:replace-from-secret-store@127.0.0.1:5432/collab
export COLLAB_EVIDENCE_ROOT="$PWD/.data/evidence"
# Create roles + database using deploy/init-db.sql (passwords from your secret store).
npm run migrate
npm run build
npm start
# UI + API: http://127.0.0.1:8787
# GET /health  GET /ready
```

Migration tests need a disposable-admin URL:

```bash
export COLLAB_TEST_ADMIN_URL=postgres://postgres@127.0.0.1:5432/postgres
npm test
```

Compose example: `deploy/README.md`.

## Scripts

From `collab/`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run migrate`, `npm run migrate:down`, `npm run migrate:dry-run`.
