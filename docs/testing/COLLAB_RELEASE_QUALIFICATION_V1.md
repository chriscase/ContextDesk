# Collaborative triage release qualification v1

**Status:** local harness. This is not a live-provider readiness claim.

The suite walks the collaborative workflow on hermetic fixtures:

1. Start a case.
2. Upload and freeze content-addressed evidence.
3. Run ContextDesk-owned triage lanes through a host connector (fake in CI).
4. Run those lanes with bounded concurrency (default 2, max 4).
5. Import an external strategy/chat package that asked different questions.
6. Compare shared evidence, unique evidence, disagreements, question paths, helpfulness, gold alignment, and an accepted decision.
7. Export a share-safe Experiment Lab report and fail closed on secrets, prompts, endpoints, request ids, or raw provider output.
8. Re-import a newer profile/version package on the same case and keep package/gold lineage.

## Command

From `collab/`:

```bash
npm run qualify
```

That command:

- typechecks nothing extra beyond the contracts/server tests it runs
- runs the qualification contract tests
- runs job-lease and harness tests (SQLite local ledger; PostgreSQL jobs when `COLLAB_TEST_ADMIN_URL` is set)
- prints one share-safe `cd-collab.qualification_report.v1` JSON document

Hosted `collab.yml` already supplies Postgres and OpenLDAP. Locally, omit those URLs: Postgres and LDAP tests skip, SQLite and memory still run.

## Backends

| Mode | When | What is durable |
| --- | --- | --- |
| `memory` | default hermetic | in-process stores + filesystem evidence |
| `sqlite` | always when `node:sqlite` is available | job/lease ledger on a temp SQLite file |
| `postgres` | `COLLAB_TEST_ADMIN_URL` | `collab_jobs` after migration `009_jobs` |

Collab's case/experiment system of record remains PostgreSQL in deployment. Local qualification uses the existing in-process domain stores plus a SQLite job ledger so worker leases can be crash-recovered without Postgres.

## Auth boundaries

- Local: `MapAuthAdapter` (demo/qualification only).
- LDAP: plaintext `ldap://` without StartTLS still refuses to boot. TLS-insecure still requires `COLLAB_LDAP_DEV_MODE=1`. Live OpenLDAP tests remain in `ldap-openldap.test.ts` and skip unless configured.

## Live profile matrix (opt-in)

Never required for `npm run qualify`. Hermetic tests never call a provider.

```bash
COLLAB_LIVE_PROFILES=gpt-oss-120b,qwen-3.6-27b,ministral-3-14b-instruct-2512
COLLAB_LIVE_VERCEL=1   # optional Vercel-compatible alias
```

Unconfigured aliases are reported as `ran: false` with `skippedReason: credentials_not_configured`. A configured alias is still `ran: false` in this suite (`opt_in_host_not_invoked_in_hermetic_suite`) until an operator explicitly runs a live host connector outside CI. Live stdout must be redacted; credentials, prompts, raw answers, endpoints, and request ids must not enter the qualification report.

## Residual

- No web UI changes.
- Live host connector is a fail-closed seam, not a silent background caller.
- Full case/experiment tables are not ported to SQLite.
- Worker leases are the durable comparison job table, not a separate cluster scheduler.
