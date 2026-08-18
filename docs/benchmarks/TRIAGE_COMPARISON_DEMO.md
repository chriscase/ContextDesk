# Triage comparison demo runbook

Synthetic, non-sensitive package for a same-snapshot comparison demo.

This is **not** an offline `bench-compare` mode. Two existing paths stay distinct:

| Path | Command | Needs host config + credentials? |
| --- | --- | --- |
| Live same-snapshot comparison | `contextdesk bench-compare` | **Yes.** Provider execution through the host. |
| Offline recorded / replay fallback | `cd-triage-bench import-run` and `cd-triage-bench-adapter record-replay` | **No.** Existing import and replay-ingest commands only. |
| Report projection | `cd-triage-bench report` | **No.** Reads stored runs only; never executes a strategy. |

Do not add `--offline` to `bench-compare`. If live credentials are missing, use
the recorded/replay fallback, then the same report command.

Fixtures: [`fixtures/triage-comparison-demo/`](../../fixtures/triage-comparison-demo/).
Helper script: [`scripts/triage-comparison-demo.sh`](../../scripts/triage-comparison-demo.sh).

## Fixed identities

Re-importing these exact files must reproduce:

- case: `case-demo-checkout-timeout`
- snapshot: `snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb`
- task: `task-162aec8ca84e72ecfc9164d4168d18b6e41367e7c10e9c23aef086bf83bfd007`

The snapshot is one raw log with `include_summaries: false` so the live bridge
v1 visibility rules can accept it.

## 0. Build the tools

From the demo branch:

```bash
REPO="$(git rev-parse --show-toplevel)"
cd "$REPO"
cargo build -p cd-triage-bench -p cd-triage-bench-adapter-cli
# Live path only, when you will actually call a provider:
cargo build -p cd-cli
```

```bash
export DEMO="$REPO/fixtures/triage-comparison-demo"
export LIB="${LIB:-/tmp/cd-triage-comparison-demo-lib}"
export TASK="task-162aec8ca84e72ecfc9164d4168d18b6e41367e7c10e9c23aef086bf83bfd007"
export BENCH="${BENCH:-$REPO/target/debug/cd-triage-bench}"
export ADAPTER="${ADAPTER:-$REPO/target/debug/cd-triage-bench-adapter}"
export CONTEXTDESK="${CONTEXTDESK:-$REPO/target/debug/contextdesk}"
```

## 1. Initialize and import the demo library

```bash
rm -rf "$LIB"
"$BENCH" --library "$LIB" init
"$BENCH" --library "$LIB" import-case "$DEMO/case.json"
"$BENCH" --library "$LIB" import-snapshot "$DEMO/snapshot.json" --blob "$DEMO/blobs/checkout.log"
"$BENCH" --library "$LIB" import-task "$DEMO/task.json"
"$BENCH" --library "$LIB" list tasks
```

Expect the printed snapshot and task ids to match the fixed identities above.

Equivalent helper:

```bash
./scripts/triage-comparison-demo.sh import --library "$LIB"
```

## 2. Live `bench-compare` (host config + credentials required)

This command **always** uses the production live bridge. It materializes one
isolated corpus from the snapshot, then runs each candidate against a provider.
It is not a replay player.

Prerequisites that remain outside this package:

1. A host `--data-dir` / AppConfig with at least one non-secret provider profile.
2. Credentials in the OS keychain (or an explicit owner-only `file:` secret
   reference already configured on that profile). This package does not ship
   keys, endpoints, or `auth.json`.
3. Edit both candidate files so `policy.model.profile_id` is the **exact** host
   profile id and the two `policy.model.model_id` values are **different,
   exact** model ids available under that profile. Replace `HOST_PROFILE_ID`
   and `HOST_MODEL_ID`; do not leave both candidates pointing at the same
   model if the demo is intended to show model-to-model convergence.
4. Role qualification evidence already saved by the host for that exact
   profile/model, if your host requires it before triage.
5. Network reachability to that already-configured provider.

```bash
# After replacing HOST_PROFILE_ID and HOST_MODEL_ID in both candidate files,
# using two distinct model ids:
"$CONTEXTDESK" --data-dir "$HOME/Library/Application Support/ContextDesk" \
  bench-compare \
  --library "$LIB" \
  --task "$TASK" \
  --candidate "$DEMO/candidates/candidate-a.json" \
  --candidate "$DEMO/candidates/candidate-b.json"
```

Use your real host data-dir (or `--app-config`) instead of inventing one.
`--data-dir` above is only the common macOS default; do not create a fake
provider config for the demo.

`bench-compare` prints an **owner-only** comparison. Failed and partial rows
are retained. It does not rank candidates or emit readiness badges.

Print the same command without executing it:

```bash
./scripts/triage-comparison-demo.sh print-live --library "$LIB"
```

## 3. Offline recorded / replay fallback (not `bench-compare`)

Use this when the host is not configured or you must stay network-free.
These commands persist stored runs from **checked-in** documents. They do not
call a provider and they do not implement `bench-compare`.

```bash
"$ADAPTER" --library "$LIB" record-replay "$TASK" \
  --replay "$DEMO/replay/replay-completed.json" \
  --operator demo-operator \
  --created-at 2026-01-15T08:30:00Z
"$ADAPTER" --library "$LIB" record-replay "$TASK" \
  --replay "$DEMO/replay/replay-failed.json" \
  --operator demo-operator \
  --created-at 2026-01-15T08:31:00Z
"$BENCH" --library "$LIB" import-run "$DEMO/recorded/human-run.json"
"$BENCH" --library "$LIB" import-run "$DEMO/recorded/other-product-run.json"
"$BENCH" --library "$LIB" list runs
```

The replay files are owner-only public-SDK envelopes produced by the existing
deterministic mock (`cd-triage-bench-adapter run --script …`) against this
same snapshot/task, then ingested with `record-replay`. Scripted mock envelope
fields such as `elapsed_ms` are **not** live measurements. Persisted bench
runs still record timing and cost as `{"status":"unknown"}`.

Equivalent helper:

```bash
./scripts/triage-comparison-demo.sh offline --library "$LIB"
```

Optional, still offline and still not `bench-compare`: generate a fresh mock
run instead of ingesting the checked-in replay.

```bash
"$ADAPTER" --library "$LIB" run "$TASK" --script completed \
  --operator demo-operator --created-at 2026-01-15T08:40:00Z
```

## 4. Owner-only and share-safe reports

`report` is a deterministic projection over whatever runs are already stored
(live, replay, or imported). It never executes a strategy.

```bash
"$BENCH" --library "$LIB" report --format markdown --privacy owner-only
"$BENCH" --library "$LIB" report --format json --privacy owner-only
"$BENCH" --library "$LIB" report --format markdown --privacy share-safe
"$BENCH" --library "$LIB" report --format json --privacy share-safe
```

Owner-only keeps exact model identities recovered from owner-only raw records.
Share-safe drops owner-only titles, rationales, reviewers, and exact model
identities. Use share-safe for anything that leaves the operator's machine.

```bash
./scripts/triage-comparison-demo.sh report --library "$LIB" --privacy owner-only
./scripts/triage-comparison-demo.sh report --library "$LIB" --privacy share-safe
```

## Honesty constraints

- No credentials, customer data, or network endpoints are in this package.
- No fabricated usage, cost, or wall-clock measurements are recorded on bench
  runs. Unknown stays `{"status":"unknown"}`.
- Live comparison and offline ingest are different commands. Do not describe
  `record-replay` as `bench-compare`.
- The live bridge v1 accepts raw log evidence only. This fixture is shaped for
  that rule; adding summaries or non-log items will make `bench-compare` refuse
  the task.
