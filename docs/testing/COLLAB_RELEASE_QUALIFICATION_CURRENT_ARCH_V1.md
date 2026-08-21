# Collaborative triage release qualification (current architecture)

**Status:** local hermetic harness. This is not a live-provider readiness claim.

This suite adapts collaborative-triage release qualification onto the
**current** collab architecture: Experiment Lab, case memory, filesystem
evidence, and the existing PostgreSQL stores. It is based on
`codex/merge-consolidation-v2` plus the Experiment Lab overlay. It does **not**
introduce a second `modules/jobs` table or a competing lease implementation.

Collab remains isolated from `cd-core`, `cd-workflow`, and `cd-triage-bench`.
The host-owned lane step therefore uses an in-process fake connector at the
Experiment Lab import seam. That fake preserves the contracts the Rust
triage-runs runner already tests elsewhere: same snapshot identity, bounded
overlap, durable run ids, cancellation, deadlines, and partial results.

## Command

From `collab/`:

```bash
npm run qualify
```

Default execution:

- builds `@cd-collab/contracts`
- runs the qualification CLI (`--all`)
- always exercises the **memory** backend (in-process case/experiment stores +
  filesystem evidence)
- exercises **PostgreSQL** when `COLLAB_TEST_ADMIN_URL` is set, using the
  existing `PgCaseStore`, `PgExperimentStore`, `PgCatalogStore`, and
  `PgAuditStore` after the reviewed SQL migrations
- never requires provider credentials
- never writes prompts, credentials, endpoints, request ids, or raw captures
  into the report or logs

Stdout is `{ "reports": [ QualificationReportV1, ... ] }`. Stderr is the
concise human summary from `renderQualificationSummary`.

```bash
npm run qualify -w @cd-collab/server -- --backend memory
npm run qualify -w @cd-collab/server -- --backend postgres
```

## Workflow

1. Create a case.
2. Upload and freeze evidence (content-addressed inventory; filename path
   segments, media types, and size caps fail closed).
3. Run two or more ContextDesk lanes through the fake host-connector that
   stands in for triage-runs at the collab isolation boundary.
4. Verify bounded concurrency (default 2), durable run ids, cancellation,
   deadline timeout, partial failure, and same-snapshot identity.
5. Import an external strategy package plus a remapped chat/interaction trace
   with a different question path.
6. Compare shared evidence, unique evidence, disagreements, unknowns,
   helpfulness, gold alignment, and an accepted decision.
7. Export the share-safe Experiment Lab package, refuse to parse it as an
   import envelope, re-import the original package idempotently, and fail
   closed on `prompt`, `api_key`, `endpoint`, `request_id`, and `rawCapture`.
8. Import a newer profile/version package on the same case and record lineage.
9. Emit the machine-readable report plus the human summary.

## Backends

| Mode | When | What is durable |
| --- | --- | --- |
| `memory` | always (default local) | in-process case/experiment stores + filesystem evidence |
| `postgres` | `COLLAB_TEST_ADMIN_URL` | existing collab PostgreSQL migrations and `Pg*` stores |

There is **no** collab domain SQLite on this architecture. Adding one would be
a competing storage path. The host product's SQLite (memory/watchers) stays in
`cd-core` / `cd-server`; collab must not import those crates.

Hosted `collab.yml` already supplies Postgres and OpenLDAP. Locally, omit those
URLs: Postgres and live LDAP tests skip, memory qualification still runs.

## Auth boundaries

- Qualification uses `CaseService` / `ExperimentService` directly (no HTTP
  login). `MapAuthAdapter` remains the local demo adapter.
- LDAP: plaintext `ldap://` without StartTLS still refuses to boot. Disabling
  TLS verification still requires `COLLAB_LDAP_DEV_MODE=1`. Live OpenLDAP tests
  remain in `ldap-openldap.test.ts` and skip unless configured.

## Live profile matrix (opt-in)

Never required for `npm run qualify`. Hermetic tests never call a provider and
never invent live results.

```bash
COLLAB_LIVE_PROFILES=gpt-oss-120b,qwen-3.6-27b,ministral-3-14b-instruct-2512
COLLAB_LIVE_VERCEL=1   # optional Vercel-compatible alias
```

| Condition | `configured` | `ran` | `skippedReason` |
| --- | --- | --- | --- |
| alias not listed | false | false | `credentials_not_configured` |
| alias listed / Vercel flag | true | false | `opt_in_host_not_invoked_in_hermetic_suite` |

Collab cannot invoke the Rust live-bridge or triage production runner. A
configured alias is therefore reported as skipped, not as a fabricated pass.

## Residual

- Fake host lanes are the collab-side stand-in for triage-runs; they do not
  spawn `cd-workflow`.
- Live host connectors remain a fail-closed opt-in outside this suite.
- Collab domain data is not ported to SQLite.
- The current web UI is unchanged by the qualify command; Experiment Lab UI
  from the collab overlay stays the review surface.
- Agreement is not correctness. Gold is a human benchmark. Live results are
  not fabricated.
