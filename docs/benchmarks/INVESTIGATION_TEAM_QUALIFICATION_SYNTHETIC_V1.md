# Investigation Team qualification synthetic runner V1

Status: **synthetic acceptance tool** on the shipped
`cd_workflow::investigation_team_qualification::execute` seam. Child of
draft PR #991 (`claude/investigation-team-report-bridge-v1` @
`983a930257b2f325ece92cd904aec2224aa878cc`).

This runner **does not** claim provider capability, real execution, live model
quality, or real evidence. It never contacts a provider, credential store,
network, filesystem, or UI. A trusted desktop host may later call it with
exact `MemberBinding` values; this slice does not add that host wiring.

## What this slice is

`cd_workflow::investigation_team_qualification_synthetic::execute_synthetic`
accepts host-supplied members and a positive observation timestamp, plus a
deterministic mode:

| Mode | Assembled fixture | Projected status |
| --- | --- | --- |
| `Completed` | completed attempts citing an opaque packet | `qualified` |
| `Partial` | honest partial attempts | `partial` |
| `Stale` | completed attempts on a non-current suite | `stale` |

The module mints an opaque provider-facing packet and host-only evaluator
truth, then calls `execute` — it does not copy `qualify`, redaction, or
fingerprinting. Empty members, duplicate roles, and invalid identities fail
closed on that shipped path. Invalid timestamps fail closed before `execute`.
A shared model subject used by distinct roles remains valid. Identical inputs
yield identical report digests.

Redacted JSON and Markdown are the existing core exports. They contain
role/model/profile identity and hashed deployment identity as defined by the
core contract. They do not contain deployment URLs, evaluator-truth tokens,
or evidence excerpts.

## Commands

```bash
cargo test -p cd-workflow --test investigation_team_qualification_synthetic
cargo test -p cd-workflow --lib
cargo fmt --all -- --check
cargo clippy -p cd-workflow --all-targets -- -D warnings
```

## Non-claims

- No live providers, Keychain, or network.
- No desktop Settings/UI/Tauri command wiring.
- No durable persistence.
- No universal “best model” score.
- No real corpus or evaluator-key leakage into provider-facing bytes.

Handbook impact: none — synthetic acceptance wrapper over an already-wired
qualification seam; no production default or trust-boundary change.
