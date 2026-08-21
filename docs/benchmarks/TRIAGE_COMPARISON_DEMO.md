# Triage comparison demo runbook

Synthetic, non-sensitive package for a same-snapshot comparison demo.

This is **not** an offline `bench-compare` mode. Two existing paths stay distinct:

| Path | Command | Needs host config + credentials? |
| --- | --- | --- |
| Live same-snapshot comparison | `contextdesk bench-compare` | **Yes.** Provider execution through the host. |
| Offline recorded / replay fallback | `cd-triage-bench import-run` and `cd-triage-bench-adapter record-replay` | **No.** Existing import and replay-ingest commands only. |
| Report projection | `cd-triage-bench report` | **No.** Reads stored runs only; never executes a strategy. |
| Evidence-agreement projection | `cd-triage-bench agreement` | **No.** Reads stored runs only; never compares raw text or executes a strategy. |

Do not add `--offline` to `bench-compare`. If live credentials are missing, use
the recorded/replay fallback, then the same report command.

Fixtures: [`fixtures/triage-comparison-demo/`](../../fixtures/triage-comparison-demo/).
Helper script: [`scripts/triage-comparison-demo.sh`](../../scripts/triage-comparison-demo.sh).
Role experiment protocol: [`docs/benchmarks/EMPLOYER_MODEL_ROLE_EXPERIMENTS_V1.md`](EMPLOYER_MODEL_ROLE_EXPERIMENTS_V1.md).

## Model lanes

The required live baseline is three distinct exact chat model ids from the
employer gateway:

| Lane | Exact model id | Intended experiment role |
| --- | --- | --- |
| A | `qwen-3.6-27b` | quality-oriented candidate/reviewer |
| B | `gpt-oss-120b` | fast bounded contributor |
| C | `ministral-3-14b-instruct-2512` | fast provisional challenger |

The host profile id is deliberately not checked in. Copy it from the host
catalog and pass it to `preflight`/`run-live`. The helper rejects duplicate
model ids, DeepSeek, embedding ids, and reranker ids in this chat lane.

These model names are selection inputs, not quality claims. `models discover`
and `models verify` must be run for the exact profile/model pairs before a
live acceptance result is treated as evidence.

## Fixed identities

Re-importing these exact files must reproduce:

- case: `case-demo-checkout-timeout`
- snapshot: `snap-5a75de4d710765b3fbb87afdc85beb25fd96f23b46ef4c59d416aa7ae61bbceb`
- task: `task-162aec8ca84e72ecfc9164d4168d18b6e41367e7c10e9c23aef086bf83bfd007`
- abstention task: `task-a234e534de674b597def0297299b0dfbd1a078d9d5cb976973e8abc1c2157ecb`
- contradiction task: `task-fb25638d4a48bf43144167d4448a3811452946acb5f7e4fd0e9087c87f3985fe`

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
export TASK_ABSTENTION="task-a234e534de674b597def0297299b0dfbd1a078d9d5cb976973e8abc1c2157ecb"
export TASK_CONTRADICTION="task-fb25638d4a48bf43144167d4448a3811452946acb5f7e4fd0e9087c87f3985fe"
```

## 1. Initialize and import the demo library

```bash
rm -rf "$LIB"
"$BENCH" --library "$LIB" init
"$BENCH" --library "$LIB" import-case "$DEMO/case.json"
"$BENCH" --library "$LIB" import-snapshot "$DEMO/snapshot.json" --blob "$DEMO/blobs/checkout.log"
"$BENCH" --library "$LIB" import-task "$DEMO/task.json"
"$BENCH" --library "$LIB" import-task "$DEMO/tasks/abstention.json"
"$BENCH" --library "$LIB" import-task "$DEMO/tasks/contradiction.json"
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

1. A host `--data-dir` / AppConfig with the exact provider profiles.
2. Credentials in the OS keychain (or an explicit owner-only `file:` secret
   reference already configured on each profile). This package does not ship
   keys, endpoints, or `auth.json`.
3. Exact catalog ids for the three model lanes in the table above. Do not
   substitute a namespaced id from another gateway.
4. Role qualification evidence already saved by the host for that exact
   profile/model, if your host requires it before triage.
5. Network reachability to the already-configured providers.

**Mixed-provider credentials.** Do not set `CONTEXTDESK_PROVIDER_API_KEY` for a
live comparison that uses more than one credentialed profile (employer gateway
plus Vercel, or per-candidate `--profile-a/b/c`). The CLI rejects that
ambiguous process-wide override before opening the library or calling a
provider, and it never prints secret bytes. Qualify each profile on its own:

```bash
unset CONTEXTDESK_PROVIDER_API_KEY
contextdesk --data-dir "$HOST_DATA_DIR" --profile PROFILE_A models verify MODEL_A --yes
contextdesk --data-dir "$HOST_DATA_DIR" --profile PROFILE_B models verify MODEL_B --yes
contextdesk --data-dir "$HOST_DATA_DIR" --profile PROFILE_C models verify MODEL_C --yes
```

A single-profile comparison may still use the global override for that one
Keychain-style `provider/<id>/api_key` reference. Protected `file:` refs are
never replaced by it.

```bash
# The helper generates three temporary candidate files from these exact ids.
./scripts/triage-comparison-demo.sh run-live \
  --library "$LIB" \
  --profile-id HOST_PROFILE_ID \
  --model-a qwen-3.6-27b \
  --model-b gpt-oss-120b \
  --model-c ministral-3-14b-instruct-2512
```

Use your real host data-dir (or `--app-config`) instead of inventing one.
The live helper prints an owner-only comparison followed by owner-only and
share-safe evidence-agreement projections. Failed and partial rows are
retained; no ranking or readiness badge is emitted.
Add --format json to the run-live or matrix command when you need the complete
owner-only payload and its scanner-gated share_safe projection for automation.

For live catalog discovery and exact compatibility verification, run:

`bench-compare` prints an **owner-only** comparison. Candidate lanes default
to two in flight (`--concurrency 1` is sequential; the published ceiling is
4). Failed and partial rows are retained. It does not rank candidates or emit
readiness badges.

```bash
./scripts/triage-comparison-demo.sh preflight \
  --profile-id HOST_PROFILE_ID \
  --model-a qwen-3.6-27b \
  --model-b gpt-oss-120b \
  --model-c ministral-3-14b-instruct-2512 \
  --discover --verify
```

Print the workflow without executing it:

```bash
./scripts/triage-comparison-demo.sh print-live --library "$LIB"
```

## 3. Repeated acceptance matrix and role experiments

The comparison command handles one task per invocation. The helper's
`matrix` command repeats the same three candidates over an already imported
library. The import helper loads the public answerable, abstention, and
contradiction fixtures and prints their fixed ids:

```bash
./scripts/triage-comparison-demo.sh matrix \
  --library "$LIB" \
  --profile-id HOST_PROFILE_ID \
  --task "$TASK" \
  --task "$TASK_ABSTENTION" \
  --task "$TASK_CONTRADICTION"
```

The same ids can also be placed one per line in a task-file when adding
repetitions or a larger imported task library. The helper does not invent
quality labels; adjudication remains a separate host-scored step.

The matrix is intended for controlled experiments, not a leaderboard:

1. Freeze the build, packet visibility, task wording, deadline, provider-call
   bound, and repetition count.
2. Run the employer trio on answerable, abstention/insufficient-evidence, and
   contradiction/decoy tasks.
3. Repeat each task at least three times before promoting a model to a final
   answer role.
4. Compare host-scored dimensions separately: required cause, exact evidence
   citations, symptom separation, independent-noise separation, contradiction
   handling, unsupported-claim rejection, structured-output validity, latency,
   provider calls, timeouts, and cost.

To study role sensitivity, hold the task and packet constant and change only
the model assigned to a role. The useful contrasts are:

| Experiment | Fixed | Variable |
| --- | --- | --- |
| finalizer swap | contributor set, packet, policy budget | finalizer model |
| contributor swap | finalizer, packet, budget | observation/causal contributor model |
| reviewer swap | contributor outputs, packet, budget | reviewer model |
| mixed routing | packet, task, role budgets | employer model vs Grok/Luna assignment |

This shows whether a model's value comes from its reasoning quality, its
structured-output discipline, or simply its speed. A faster transport result
is never treated as a quality win.

## 4. Optional direct Grok Build / Luna challenger lane

Grok Build can be used directly; it does not need the Vercel gateway. For a
fair comparison, give it the same public task packet and ask it to return a
validated `contextdesk.triage.replay.v1` envelope with its exact model identity,
packet id, and evidence citations. Ingest that envelope with
`cd-triage-bench-adapter record-replay` and then run the same agreement
projection. This is the preferred external challenger path.

If Grok Build or a Luna lane only provides pasted chat text, import it with
`cd-triage-bench import-run` and a raw text file. It remains useful in the
owner-only report, but it is labeled external/imported and cannot count as
independent model corroboration without proof of exact model identity and
same-packet binding. Never infer those facts from a display name.

Use Grok/Luna as role variants—not as an untracked extra winner:

- Grok as a causal proposer versus each employer model as finalizer.
- Grok as finalizer over employer contributors.
- Luna as a fast observation extractor, with Qwen or Grok as reviewer.
- Employer-only and mixed-role runs with identical budgets and three repeats.

## 5. Offline recorded / replay fallback (not `bench-compare`)

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

## 6. Owner-only and share-safe reports

`report` is a deterministic projection over whatever runs are already stored
(live, replay, or imported). It never executes a strategy.

```bash
"$BENCH" --library "$LIB" report --format markdown --privacy owner-only
"$BENCH" --library "$LIB" report --format json --privacy owner-only
"$BENCH" --library "$LIB" report --format markdown --privacy share-safe
"$BENCH" --library "$LIB" report --format json --privacy share-safe

# Evidence-backed convergence, independent of claim wording:
"$BENCH" --library "$LIB" agreement --format markdown --privacy owner-only
"$BENCH" --library "$LIB" agreement --format json --privacy share-safe
```

Owner-only keeps exact model identities recovered from owner-only raw records.
Share-safe drops owner-only titles, rationales, reviewers, and exact model
identities. Use share-safe for anything that leaves the operator's machine.

```bash
./scripts/triage-comparison-demo.sh report --library "$LIB" --privacy owner-only
./scripts/triage-comparison-demo.sh report --library "$LIB" --privacy share-safe
./scripts/triage-comparison-demo.sh agreement --library "$LIB" --privacy owner-only
./scripts/triage-comparison-demo.sh agreement --library "$LIB" --privacy share-safe
```

The agreement projection is deterministic and host-side. It groups only exact
task/snapshot runs, anchors claims to visible evidence and typed roles, reports
role conflicts and unsupported/uncited claims, and marks `independent` only
when two distinct exact model identities support the same evidence-role anchor.
The checked-in replay fallback contains one mock model plus imported rows, so
it proves the projection and privacy path but does not fabricate a two-model
consensus. A live run with two distinct models can populate that field. A live
run may remain an honest `partial` when the host has not proven a causal role;
host-validated evidence observations can still appear in agreement, but they
never upgrade the run into a grounded root-cause result.

## Honesty constraints

- No credentials, customer data, or network endpoints are in this package.
- No fabricated usage, cost, or wall-clock measurements are recorded on bench
  runs. Unknown stays `{"status":"unknown"}`.
- Live comparison and offline ingest are different commands. Do not describe
  `record-replay` as `bench-compare`.
- The live bridge v1 accepts raw log evidence only. This fixture is shaped for
  that rule; adding summaries or non-log items will make `bench-compare` refuse
  the task.
