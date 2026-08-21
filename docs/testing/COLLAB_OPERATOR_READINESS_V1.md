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

Optional, never required for doctor or qualify. Collab still does not invoke
`cd-workflow`.

```bash
# after a valid catalog file (additionalProperties: false):
# COLLAB_PROFILE_CATALOG=./catalog.json
# COLLAB_LIVE_PROFILES=gpt-oss-120b,qwen-3.6-27b,ministral-3-14b-instruct-2512
# COLLAB_LIVE_VERCEL=1
# COLLAB_BRIDGE_BIN=/absolute/path/to/contextdesk   # path only; not executed
npm run doctor -- --json
```

Unknown aliases, a missing bridge path, or unknown JSON fields fail closed.
Configured live aliases remain a *syntax* check. Qualification still reports
`ran: false` with an explicit skip reason unless a separate live host is
invoked outside this suite.

## Residual

- Doctor does not open TCP connections.
- `npm start` remains PostgreSQL + LDAP; local UI without those is `npm run demo`.
- Host-bridge existence is not host-bridge usefulness.
- Profile-catalog syntax is not model quality.
