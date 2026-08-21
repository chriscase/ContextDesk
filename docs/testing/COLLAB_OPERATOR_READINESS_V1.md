# Collaborative War Room operator readiness v1

**Status:** local configuration-shape tools. This is not a live-provider
compatibility claim.

`cd collab && npm run doctor` and `npm run config:init` help an operator
install, configure, and diagnose a **demo or private** collab War Room. They
inspect configuration *shape* only. They never contact PostgreSQL, LDAP,
Vercel, employer gateways, or any model provider, and they never invent live
results.

Doctor output therefore proves: Node/runtime, compiled artifacts, storage
keys, evidence-root writability, static directory, auth mode, LDAP TLS
requirements, cookie security, optional host-bridge path, profile-catalog
syntax, and listen port. It does **not** prove that a directory, database, or
model answers correctly.

## Commands

From `collab/`:

```bash
npm run config:init -- --output .env.local --yes
set -a && . ./.env.local && set +a
npm run doctor
npm run doctor -- --json
```

`doctor` and `config:init` are compile-first (`node server/dist/...`). They do
not use `tsx`. Extra flags after `--` are forwarded.

| Flag | Command | Meaning |
| --- | --- | --- |
| `--json` | doctor | stable `cd-collab.doctor_report.v1` on stdout |
| `--env-file PATH` | doctor | load KEY=VALUE without printing values |
| `--output PATH` | config:init | default `.env.local` |
| `--profile demo\|postgres\|ldap` | config:init | default `demo` |
| `--force` | config:init | allow overwrite |
| `--yes` / `--non-interactive` | config:init | no prompts (CI) |

Exit codes: doctor `0` when every check is `OK` or `WARN`; `1` when any check
is `ERROR` (unsafe to deploy). `WARN` is not an unsafe error.

Doctor never prints secrets, passwords, tokens, URLs containing credentials,
or file contents.

## Shortest paths

### Run the synthetic demo

No PostgreSQL, LDAP, or provider credentials. Uses in-process memory + the
public `demo` / `demo` fixture login.

```bash
cd collab
npm ci
npm run demo
# optional: COLLAB_DEMO_PORT=8790 npm run demo
```

Read-only HTML fallback:

```bash
npm run demo:static
# opens collab/.demo/contextdesk-synthetic-demo.html
```

### Run a private local War Room

Shape-only local config, then the production-like built server if you supply
real secret-store values later. Doctor does not start the server.

```bash
cd collab
npm ci
npm run config:init -- --profile demo --output .env.local --yes
set -a && . ./.env.local && set +a
npm run doctor
npm run build
# npm start still requires PostgreSQL + encrypted LDAP (see next path).
# Until those are filled from a secret store, use npm run demo for a local UI.
```

### Prepare a PostgreSQL/LDAP deployment

Placeholders only. Replace `replace-from-secret-store` from your secret store.
Do not treat doctor `WARN` on placeholders as connectivity.

```bash
cd collab
npm run config:init -- --profile postgres --output .env.local --yes
# or: --profile ldap  (encrypted ldaps:// placeholders + secure cookies)
set -a && . ./.env.local && set +a
npm run doctor -- --json
# fill database and directory credentials from the secret store
# npm run migrate && npm run build && npm start
```

Compose example remains `collab/deploy/README.md`. Plaintext `ldap://` without
StartTLS still refuses to boot.

### Prepare employer/Vercel live profiles

Optional, never required for doctor or the hermetic qualification suite. The
live qualification command invokes only the configured ContextDesk host bridge;
the bridge remains the credential owner.

```bash
# The live catalog uses cd-collab.live_qualification_catalog.v1 and contains
# only alias, host profile id, model id, provider label, and display label.
# It contains no credentials, endpoints, prompts, or raw outputs.
# COLLAB_LIVE_PROFILE_CATALOG=./live-qualification-catalog.json
# COLLAB_BRIDGE_BIN=/absolute/path/to/contextdesk
# COLLAB_LIVE_PROFILES=gpt-oss-120b,qwen-3.6-27b,ministral-3-14b-instruct-2512,vercel-compatible
npm run doctor -- --json
```

The checked-in catalog fixture intentionally omits Vercel because model
availability is dynamic. For a four-lane rehearsal, create a private catalog
copy and add `vercel-compatible` only after fresh discovery returns the exact
Vercel profile id and model id. Do not assume the historical
`openai/gpt-oss-120b` observation is current. Each selected provider profile
must resolve its own Keychain or protected `file:` credential reference; a
single `CONTEXTDESK_PROVIDER_API_KEY` override is rejected for multi-profile
comparisons.

Unknown aliases, a missing bridge path, malformed catalog data, or unknown JSON
fields fail closed. The report is `cd-collab.live_qualification_report.v1` and
contains exact model/provider provenance, same-snapshot status, bounded
concurrency evidence, lane status, evidence/unknown counts, and safe error
codes. It never contains raw output, prompts, credentials, endpoints, request
IDs, or durable host run IDs. Agreement remains evidence of convergence, not
proof of correctness; usage and cost remain unknown.

Provider-free preflight; never invokes the bridge:

```bash
npm run qualify:live -- --catalog ./live-qualification-catalog.json \
  --profiles gpt-oss-120b,qwen-3.6-27b --json
```

Explicit live run; both flags are required, and the host bridge owns secrets:

```bash
npm run qualify:live -- --catalog ./live-qualification-catalog.json \
  --profiles gpt-oss-120b,qwen-3.6-27b,ministral-3-14b-instruct-2512,vercel-compatible \
  --live --yes --concurrency 2 --json
```

Never run the `--live --yes` command in ordinary CI. Use it only as an
explicitly authorized operator action against a configured employer or Vercel
gateway. An explicitly requested live run is a release gate: partial,
inconclusive, failed, or skipped results exit nonzero; only a completed,
same-snapshot matrix succeeds.

## Residual

- Doctor does not open TCP connections.
- `npm start` remains PostgreSQL + LDAP; local UI without those is `npm run demo`.
- Host-bridge existence is not host-bridge usefulness.
- Profile-catalog syntax is not model quality.
