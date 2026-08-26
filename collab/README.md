# cd-collab

Separately deployable collaboration and case-memory layer (working name;
rename-friendly via `collab/branding.toml` and `COLLAB_SERVICE_NAME`). This
directory is an **npm workspace independent of** the Rust workspace,
`desktop/`, and `packages/` builds. It must not import cd-core, desktop, bench,
or crate internals. Published `packages/contracts` artifacts may be consumed
read-only later; v1 does not.

Parent epic: #883. Skeleton is #884. Auth/authz/audit is #885. Cases/timeline
is #886. Source catalog and manual import is #887. Export is #888. Experiment
Lab human adjudication v1 imports a share-safe experiment package/summary into
a case, shows the candidate matrix and evidence agreement, records helpfulness,
and accepts a revision-safe decision. It does not duplicate bench scoring
schemas. Demo: [`docs/benchmarks/EXPERIMENT_LAB_HUMAN_ADJUDICATION_V1.md`](../docs/benchmarks/EXPERIMENT_LAB_HUMAN_ADJUDICATION_V1.md).

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

### Storage modes

PostgreSQL is the default and production mode. It provides the reviewed
least-privilege migrator/app roles, durable presence, and expiring triage
worker leases for multi-instance operation. Set a unique
`COLLAB_TRIAGE_WORKER_ID` on each live worker.

For a private workstation or small single-node deployment, set
`COLLAB_STORAGE=sqlite` and `COLLAB_SQLITE_PATH=/path/to/collab.sqlite`.
This mode uses Node 22.5+'s built-in SQLite support and persists case,
auth-session, catalog, import, experiment, audit, authorization, and triage
state in one file. Evidence bytes remain in `COLLAB_EVIDENCE_ROOT`.
SQLite mode is intentionally single-node: it does not provide PostgreSQL role
separation, multi-worker HA, or a PostgreSQL-to-SQLite migration tool. Its
protection boundary is filesystem ownership, and its append-only guarantees
are enforced by the same service contracts rather than PostgreSQL triggers.
The default remains PostgreSQL so enabling local mode is an explicit operator
decision.

### Auth: bind-through LDAP over encrypted transport only (#885)

- `AuthAdapter.authenticate(username, password)` lives in `modules/auth`.
  Passwords exist in memory only for the bind. No hashing, caching, storage, or
  logging. No other module may import `ldapts` or read a password field
  (enforced by `password-isolation.test.ts`).
- `userDnTemplate` interpolates usernames with RFC 4514 DN escaping. Search
  filters keep RFC 4515 escaping. The two are not interchangeable.
- Transport: `ldaps://` or `ldap://` + StartTLS. Plaintext is refused at
  `loadLdapConfig`. Disabling TLS verification requires explicit
  `COLLAB_LDAP_DEV_MODE=1` (fixture only). Hosted CI uses StartTLS against
  the osixia fixture — Node 22 cannot complete LDAPS to that image's
  self-signed cert. Constructor `tlsOptions` are omitted for StartTLS so
  ldapts does not wrap port 389 as LDAPS. The encrypted-transport test still
  uses the insecure fixture; a separate test proves verification fail-closed
  against that same cert. `COLLAB_REQUIRE_LDAP=1` makes a missing live URL a
  failure, not a skip.
- Optional service-bind (`COLLAB_LDAP_BIND_DN` / bind-password secret
  reference) is secret-store-sourced and never written to the DB, logs, or
  audit. After a successful user bind it is reused to read group membership
  when the directory hides group OUs from the user (osixia returns LDAP 0x20).
  `lookupGroups` repeats that service-bind search on each request so directory
  group removal does not wait for the 8h/30m session TTL.
- Compatible user-resolution modes, when explicitly configured, run in listed
  order: service-bind search, DN template, AD UPN, and `DOMAIN\user`. ContextDesk
  never derives a UPN suffix or NetBIOS name from `DC=` components of a search
  base. `{0}` is an alias for `{username}` after the matching escape.
- Group membership unions a configured member attribute (commonly `memberOf`)
  with optional group search, then normalizes, deduplicates, and bounds the
  result. Role mapping stays exact and default-deny.
- Login fetches configured display name, work email, role title, and team
  attributes and passes them through `mapDirectoryClaimsToProfileFields`.
  Missing attributes skip; unsafe attributes fail closed; identity collisions
  revoke the new session and return 403.
- Directory administration (`/admin/ldap`) and first-run `POST /api/setup/ldap-probe`
  report staged connectivity (transport, service bind, user search, group lookup,
  role-map readiness) without returning stored secrets.

#### RepoSync LDAP field translation (generic values only)

| RepoSync / typical LDAP admin field | ContextDesk configuration |
| --- | --- |
| `url` | `COLLAB_LDAP_URL` (`ldaps://directory.example.test:636` or `ldap://` + `COLLAB_LDAP_STARTTLS=1`) |
| `base_dn` | `COLLAB_LDAP_USER_SEARCH_BASE=ou=people,dc=example,dc=test` |
| `search_filter` with `{0}` | `COLLAB_LDAP_USER_SEARCH_FILTER=(sAMAccountName={0})` |
| `display_name_attr` | `COLLAB_LDAP_ATTR_DISPLAY_NAME` (default `cn`) |
| `email_attr` | `COLLAB_LDAP_ATTR_EMAIL` (default `mail`) |
| `group_attr` | `COLLAB_LDAP_MEMBER_ATTR=memberOf` plus optional `COLLAB_LDAP_GROUP_SEARCH_*` |
| `bind_dn` | `COLLAB_LDAP_BIND_DN` |
| `bind_password` | bind-password environment, `COLLAB_LDAP_BIND_PASSWORD_FILE`, or `file:` reference — exactly one |
| `tls_verify` | verified TLS default; fixture-only disable requires `COLLAB_LDAP_TLS_INSECURE=1` and `COLLAB_LDAP_DEV_MODE=1` |
| Silent UPN/NetBIOS from `DC=` | **Not copied.** Set `COLLAB_LDAP_UPN_SUFFIX=example.test` and `COLLAB_LDAP_NETBIOS_DOMAIN=EXAMPLE` |

This table is a configuration translation. It is not evidence that any live
company directory works with ContextDesk.

- Sessions: opaque `HttpOnly` `SameSite=Lax` cookies; server-side store;
  TTL + idle timeout; revocation is immediate. No JWTs.
- Group→role map is persisted (`authz_group_role_map`) and reloaded on every
  `/api/` request. Unmapped users are default-deny. A revoke on one instance
  is visible to the next request on another instance without a restart.
- Audit is insert-only (`audit_events` trigger + app-role grants). Persist
  success is never recorded or returned as failure/forbidden; persist failure
  is never recorded or returned as success. Failed logins are rate-limited and
  return the same `invalid_credentials` body whether the account exists.
- Hosted CI creates `collab_app` before migrations so least-privilege GRANTs
  are applied and exercised as that role, not only as `postgres`.
- CSRF: same-origin SPA + `SameSite=Lax` plus a required custom header
  (`x-cd-collab-csrf: 1`) on cookie-authenticated `POST`/`PUT`/`PATCH`/`DELETE`
  `/api` requests. Login, logout, and `/api/setup/*` are the documented
  exemptions. TLS terminates at ingress; set `COLLAB_COOKIE_SECURE=1` behind HTTPS.
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

### Source catalog and external-run import (#887)

- Catalog kinds: `human`, `external-tool`, `internal-system`, `contextdesk`,
  `unknown`. `unknown` is permanent and is never auto-upgraded (kind cannot
  change after create). Completeness uses #878's `exact` / `partial` /
  `unknown` words only — no bench crate dependency.
- Every contribution and artifact links to a catalog source. Human
  contributions default to the authenticated identity's catalog entry.
  `GET /api/catalog/sources` returns raw directory identities only to admins.
  Other callers keep the source UUID, kind, and non-identity labels; DNs are
  omitted or replaced with a stable `attr:` hash so attribution still matches.
- Manual import stores byte-exact output (and optional prompt) as a frozen
  `imported_runs` row. Corroboration is a separate insert-only history.
  Nothing marks an import corroborated or verified automatically.
- Without an #888 package, evidence visibility is `unknown` or
  `importer_described`. The `snapshotBinding` field exists for a later
  package snapshot identity. #888 export fills that field with the package
  manifest hash.
- Importer and operator identities are distinct fields. Missing
  provider/model/version stay null. Output-only imports keep prompt
  completeness `unknown`.
- Catalog administration is case-lead/admin and audited. Retiring a source
  keeps historical attributions.

### Investigation record graph

Three modules sit beside cases and hold the record *around* an investigation:
what it is about, what it cites, and why it ended.

- **Entities** (`server/src/modules/entities`) is a global registry of reusable
  labels — organization, customer, person, service, system, other — plus the
  per-investigation involvement links that use them. It is a different
  vocabulary from the Attribution source catalog: Attribution records where a
  piece of information came from, entities record who or what an investigation
  is about. A vendor is routinely both and stays two rows with two lifecycles.
  Neither registry holds evidence, logs, email, chat, or notes; those stay in
  the investigation where they were captured, and the descriptor columns are
  bounded and single-line so the boundary holds by construction rather than by
  convention.
- Involvement carries immutable historical attribution. A link records the
  label and kind the entity had at link time; renaming or retiring the entity
  never rewrites what an older investigation said. A database trigger enforces
  it. Involvement ends by being released, never deleted.
- The entity → investigation index behind the list filter is built from the
  investigations the reader could already list, so filtering by entity can
  narrow visibility but never widen it.

- **References** (`server/src/modules/references`) are authorized citations of
  another investigation, or of one resource inside it. A citation copies
  nothing, writes nothing into the cited investigation, and never becomes
  evidence or a contribution. Authorization is checked when the citation is
  written *and* re-checked for every reader: an unresolvable counterpart
  projects as `restricted` with no title, and the refusal for an unreadable
  target is indistinguishable from the refusal for one that does not exist.
  The stored locator is derived from the shared activity locator, so a citation
  can never point somewhere the app would not resolve.

- **Resolutions** (`server/src/modules/resolutions`) back the `resolved`
  status. Reaching it requires an active resolution record, supplied
  beforehand or atomically with the transition; a case service wired without
  the guard refuses the transition outright rather than allowing a silent one.
  Human-only reasoning is a first-class basis — most historical and manual
  investigations end that way and are not routed through a comparison that
  never happened — alongside an accepted experiment decision and an explicit
  reasoned exception. Rationale is required, open unknowns are recorded,
  revisions are insert-only, and leaving `resolved` supersedes the record
  rather than deleting it.

### Occurred-at versus recorded-at

Every investigation, involvement link, citation, and resolution carries two
clocks. `recordedAt` (and `cases.created_at`) is the server clock at write
time: the audit clock, never caller-supplied and never rewritten. `occurredAt`
is when the described work actually happened, is caller-supplied, may be
absent, and may sit far in the past. Backfilling an older investigation moves
only the second one, so describing work that predates the tool never requires
rewriting audit history.

The recorded time zone is preserved rather than guessed. `2024-11-04` is stored
and displayed as typed and reports `occurredAtZone: "unspecified"`; only text
carrying an explicit offset is normalized to a UTC instant. Precision and zone
are both derived from the text, so a half-stated occurrence cannot exist, and
the ordering key for a zone-unspecified value is documented as an ordering
convention that is never displayed.

### Share-safe boundary for the record graph

A share-safe brief carries the shape of the record and not the names. An entity
label leaves the tool only when the registry marked it `share_safe`; otherwise
it travels as a stable pseudonym derived from the entity id, so two
investigations can be seen to concern the same party without disclosing who.
Another investigation's title never leaves in a share-safe brief. Resolution
reasoning is owner-only, but the count of open unknowns always travels, so a
share-safe conclusion cannot be made to look more complete than it was. The
brief parser enforces all three rules rather than trusting the projection.

### Portable export (#888)

- Export is a read-only projection. It never creates, edits, or reinterprets
  case content. Consumers are the public case, catalog, and import APIs.
- Two artifacts: a **triage brief** (case projection) and a **selected-evidence
  prompt package** (explicit selection + optional scaffold). The package
  manifest hash is the snapshot identity imported runs bind to.
- Canonical versioned JSON plus markdown generated from the same payload.
  Re-export of an unchanged case or selection is byte-identical. `exportedAt`
  lives only on the envelope, outside the deterministic payload.
- Variants match #876 invariant 7: `owner_only` (contributor+) and
  `share_safe` (case-lead+ when leaving the tool). `share_safe` is
  default-deny for raw `owner_only` artifacts, redacts directory identities
  from `COLLAB_EXPORT_REDACTION_MAP`, and fails closed on a rule-based
  privacy scan (`COLLAB_EXPORT_INTERNAL_HOST_SUFFIXES`). The redaction map is
  never embedded in `share_safe` output.
- Packages exclude corroboration and resolution content by default. Imported
  external runs appear in the brief as `imported_response` with their
  corroboration state — never as a finding.
- Every export is audited with actor, case, variant, and — for packages —
  the manifest hash.

## Module boundaries

`server/src/modules/{auth,authz,audit,cases,contributions,evidence,provenance,catalog,import,export}`
are reserved. Other code may depend on a module only through that module's
`index.ts`. Cross-module deep imports fail `eslint-plugin-boundaries`
(`boundaries/entry-point`). See `server/src/modules/boundaries.test.ts`.

## Synthetic demo

For a hermetic synthetic Experiment Lab demonstration with no PostgreSQL,
LDAP, provider calls, or persistent state, use `npm run demo`. It binds only to
`127.0.0.1`, uses the public fixture credential `demo` / `demo`, and removes
its temporary evidence when it stops. `COLLAB_DEMO_PORT` selects a different
loopback port. The production entry point and readiness contract are unchanged.

`npm run demo:static` generates a self-contained, read-only fallback at
`collab/.demo/contextdesk-synthetic-demo.html`. The presenter sequence and the
local-only external-chat intake workflow are documented in
[`CONTEXTDESK_DEMO_RUNBOOK.md`](../docs/benchmarks/CONTEXTDESK_DEMO_RUNBOOK.md).

## Operator readiness

For a compile-first configuration check and safe setup template:

```bash
cd collab
npm run config:init -- --profile demo --output .env.local --yes
npm run doctor
npm run doctor -- --json
```

`doctor` checks runtime/artifacts, storage shape, evidence and static paths,
auth/LDAP transport, cookie security, the optional host bridge, live-profile
syntax, and the listen port. It does not contact PostgreSQL, LDAP, Vercel, or
any model provider. Its versioned output is
`cd-collab.doctor_report.v1`; see
[`COLLAB_OPERATOR_READINESS_V1.md`](../docs/testing/COLLAB_OPERATOR_READINESS_V1.md).

## Opt-in live qualification

The live qualification runner is a separate, explicit operator action. Its
default preflight creates synthetic frozen evidence and emits a skipped,
share-safe `cd-collab.live_qualification_report.v1`; it never invokes a
provider. A live run requires both `--live` and `--yes`, a
`cd-collab.live_qualification_catalog.v1` file, and the configured Rust host
bridge. The bridge owns credentials and provider endpoints.

```bash
npm run qualify:live -- --catalog ./live-qualification-catalog.json \
  --profiles gpt-oss-120b,qwen-3.6-27b,ministral-3-14b-instruct-2512 \
  --live --yes --concurrency 2 --json
```

The report preserves model/provider provenance, the exact same-snapshot
fingerprint, bounded concurrency evidence, lane statuses, evidence counts,
unknown counts, and safe error codes. It excludes raw output, prompts,
credentials, endpoints, request IDs, and durable host run IDs. Agreement is
never treated as correctness; usage and cost remain unknown. Do not run the
live command in ordinary CI.

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

## Local SQLite

For a private local War Room without PostgreSQL or LDAP, use local auth and a
writable SQLite file:

```bash
cd collab
export COLLAB_STORAGE=sqlite
export COLLAB_SQLITE_PATH="$PWD/.data/collab.sqlite"
export COLLAB_AUTH_MODE=local
export COLLAB_LOCAL_USERS='[{"username":"lead","password":"replace-me","displayName":"Case Lead","groups":["local:case-lead"]}]'
export COLLAB_GROUP_ROLE_MAP='local:case-lead=case-lead'
export COLLAB_EVIDENCE_ROOT="$PWD/.data/evidence"
npm run migrate
npm run build
npm start
```

The SQLite migration command initializes the current schema and is idempotent.
There is no destructive rollback command; remove the explicitly configured
SQLite file only when you intentionally want a fresh local workspace.

## Scripts

From `collab/`: `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`,
`npm run demo`, `npm run demo:static`, `npm run demo:check`, `npm run e2e`,
`npm run migrate`, `npm run migrate:down`, `npm run migrate:dry-run`.

For a non-networking deployment preflight, run `npm run doctor` (or
`npm run doctor -- --json` for machine-readable output). It checks runtime,
storage, authentication/TLS, paths, session-cookie safety, and host-owned
triage profile configuration without contacting PostgreSQL, LDAP, Vercel, or a
model provider. To create a private local-demo template, run
`npm run config:init -- --output .env.local`; it refuses to overwrite an
existing file unless `--force` is supplied.

`npm run e2e` is the Playwright war-room qualification against a
`MapAuthAdapter` fixture server (no LDAP, no Postgres). See
[`docs/testing/COLLAB_WAR_ROOM_BROWSER_QUALIFICATION_V1.md`](../docs/testing/COLLAB_WAR_ROOM_BROWSER_QUALIFICATION_V1.md).
