# cd-collab

Separately deployable collaboration and case-memory layer (working name;
rename-friendly via `collab/branding.toml` and `COLLAB_SERVICE_NAME`). This
directory is an **npm workspace independent of** the Rust workspace,
`desktop/`, and `packages/` builds. It must not import cd-core, desktop, bench,
or crate internals. Published `packages/contracts` artifacts may be consumed
read-only later; v1 does not.

Parent epic: #883. This skeleton is #884. Auth, domain, import, and export are
sibling issues — module folders exist here, implementations do not.

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
