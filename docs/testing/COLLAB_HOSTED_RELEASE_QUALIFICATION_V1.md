# Hosted collab release qualification

**Status:** CI application/storage readiness. This is **not** a model-quality
or live-provider certification.

Successful qualification proves that the current collab Experiment Lab and
case-memory paths still run hermetically on memory and PostgreSQL, and that
`config:init` + `doctor` produce a share-safe configuration-shape report. It
does **not** prove that gpt-oss-120b, qwen-3.6-27b, ministral, Vercel, or any
employer gateway answers well.

## Workflow

GitHub Actions: [`.github/workflows/collab-qualify.yml`](../../.github/workflows/collab-qualify.yml)

Check name: `collab hosted release qualification`

| Gate | What it runs |
| --- | --- |
| Node 22 + `npm ci` | collab workspace install |
| `npm run typecheck` | contracts, server, web |
| `npm run lint` | contracts, server, web |
| `npm test` | contracts, server, web (PostgreSQL tests run because `COLLAB_TEST_ADMIN_URL` is set) |
| `npm run build` | contracts, web, server |
| `npm run qualify -- --backend memory` | hermetic Experiment Lab harness |
| `npm run qualify -- --backend postgres` | same harness on disposable PostgreSQL (`Pg*` stores) |
| `npm run config:init -- --output .env.local --yes` | documented local-demo env + evidence directory |
| `doctor -- --json` | configuration-shape report |
| sanitize + upload | only `.ci-qualify/sanitized/*.json` |

PostgreSQL 16 is a GitHub Actions service. The workflow does **not** start
OpenLDAP, set `COLLAB_LDAP_URL`, call Vercel, or set `COLLAB_LIVE_PROFILES`.
`COLLAB_LIVE_VERCEL` is `"0"`. Every live alias in the qualification report
must remain `ran: false` with an explicit skip reason.

Artifacts are rejected (job fails, nothing unsanitized is uploaded) if they
contain prompts, raw model output, credentials, URLs/endpoints, request ids,
absolute paths, or private hostnames (`scanShareSafePrivacy` plus live-profile
`ran` checks). Finding excerpts are not printed.

## Local equivalent

```bash
cd collab
npm ci
npm run typecheck && npm run lint && npm test && npm run build
npm run qualify -- --backend memory --out /tmp/qualify-memory.json
# postgres requires COLLAB_TEST_ADMIN_URL
npm run config:init -- --output .env.local --yes
node server/dist/doctor-cli.js --json --env-file .env.local --out /tmp/doctor.json
node server/dist/ci-artifact-cli.js --in /tmp --out /tmp/sanitized
```

A future **manually authorized** workflow is required before any live host
run. This lane must not grow silent provider calls.

## Residual

- Hosted LDAP bind coverage stays in `collab.yml`, not this workflow.
- PostgreSQL qualify still skipIf locally when `COLLAB_TEST_ADMIN_URL` is unset.
- Doctor WARNs (static dir, host bridge) are not failures.
- Qualification is not model quality.
