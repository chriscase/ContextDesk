# cd-triage-bench

Headless **source-neutral incident-triage evaluation bench**: a local library of
cases, immutable evidence snapshots, imported strategy runs, expert
adjudication, and honest comparison reports.

This crate is **not** the ContextDesk engine, GUI, or web collaboration layer.
It has no `cd-core` dependency, no network client, and no keychain access.
ContextDesk participates later as one strategy among many (#879), through public
SDK contracts, not by absorbing case management.

Working name: `cd-triage-bench` (rename-friendly; crate prefix stays `cd-*`).

Status on this branch: **local integration** (Refs #877–#879). First-slice
store/import is on `integrate/rc`. This branch adds the **public-SDK mock
adapter** (#879). Not shipped on `main`. Not release-ready. Live providers
are out of default CI.

## Layout

```text
<library>/
  library.json
  cases/<case_id>.json
  snapshots/<snapshot_id>.json
  tasks/<task_id>.json
  runs/<run_id>.json
  adjudications/<adjudication_id>.json
  scores/<score_id>.json
  packets/<packet_id>.json
  blobs/sha256/<hh>/<hex>
```

- Snapshot, task, run, adjudication, and score identities are content-addressed
  (SHA-256 of canonical JSON of the digest body).
- Records are **immutable**. A second write with different bytes fails closed.
  Identical bytes are idempotent. Corrections are new records.
- Default privacy class is `owner_only`. `share_safe` is explicit.
- Original evidence bytes live in the blob store. Attributed summaries sit
  beside items and never replace originals.
- Case `resolution` (adjudicated root cause, fix, domain expertise) is
  evaluation-only. Task packets are a distinct type that cannot carry it.

## Identities

| Record | Identity |
| --- | --- |
| `Case` | caller-assigned `case_id` |
| `EvidenceSnapshot` | `snap-<sha256>` of canonical manifest **without** `snapshot_id` |
| `EvaluationTask` | `task-<sha256>` of question, protocol, visibility, snapshot |
| `TriageRun` | `run-<sha256>` of task, snapshot, source, strategy, raw digest, fairness |
| `Adjudication` | `adj-<sha256>` of reviewer, rubric, outcomes, run binding |
| `ScoreReview` | `score-<sha256>` derived from an adjudication; never rewritten |

## Privacy, unknown, and fairness

- Unknown cost, timing, prompt, workflow, and version serialize as
  `{"status":"unknown"}`. That is distinct from zero, empty, or omitted-and-defaulted.
- Fairness class is mandatory on import: `same_snapshot`, `extra_evidence`
  (with description), or `unknown_visibility`.
- Comparisons are valid only for the same `EvaluationTask` + snapshot.
  Anything else is reported as **incomparable**, never force-ranked.
- Reports do not emit readiness, qualification, or routing badges.

## Schema versioning and migration

Schema ids are exact strings (`contextdesk.triage_bench.*.v1`). Unknown fields
are rejected on stored records **and** on CLI import documents, including the
happy path that omits generated `snapshot_id` / `task_id` / `adjudication_id` /
`score_id` / `run_id`. Additive change requires a new schema id (`v2`); v1
records stay readable and are never rewritten in place. There is no implicit
upgrade.

Valid and invalid fixtures live in [`fixtures/valid`](fixtures/valid) and
[`fixtures/invalid`](fixtures/invalid). Content-addressed identity mismatches
fail closed. This slice does not close #877 on its own; treat it as **Refs #877**.

## CLI examples

All commands are offline. `--library` is required.

```bash
cd-triage-bench --library ./bench-lib init

cd-triage-bench --library ./bench-lib import-case ./case.json
cd-triage-bench --library ./bench-lib import-snapshot ./snapshot.json --blob ./app.log
cd-triage-bench --library ./bench-lib import-task ./task.json

# Human markdown template, web transcript JSON, or other-product export:
cd-triage-bench --library ./bench-lib import-run ./human.md
cd-triage-bench --library ./bench-lib import-run ./web.json
cd-triage-bench --library ./bench-lib import-run ./other.json --raw ./other.txt

cd-triage-bench --library ./bench-lib list runs
cd-triage-bench --library ./bench-lib show runs "$RUN_ID"
cd-triage-bench --library ./bench-lib packet "$TASK_ID"
cd-triage-bench --library ./bench-lib run-sdk "$TASK_ID" --engine mock --script completed
cd-triage-bench --library ./bench-lib import-adjudication ./adj.json
cd-triage-bench --library ./bench-lib report --format json --privacy share-safe
```

`run-sdk` materializes the task packet under the task visibility policy,
drives the published compile/preflight/execute/cancel/replay/evaluate seams
through a deterministic mock engine, and records a `contextdesk_sdk`
`TriageRun`. Failed, partial, timed-out, cancelled, and preflight-rejected
attempts are stored runs. Usage and cost stay `unknown`. There is no live
provider path in this crate.

Human submission template: [`fixtures/templates/human-run.md`](fixtures/templates/human-run.md).

## Rubric v1 dimensions

1. Diagnosis correctness (n/a on unresolved cases)
2. Evidence support
3. Actionability
4. Uncertainty/calibration
5. Unsafe unsupported claims

Deterministic citation-existence checks may set **assist flags**. They never
produce scores. Human experts remain the scoring authority. Disagreement is
preserved as separate adjudications.

## Future scope (explicitly not this slice)

- Web collaboration / shared review UI (#883–#888)
- Object-storage ingestion for large corpora
- Direct web-tool / browser automation (manual import is the path here)
- Multi-strategy synthesis
- Similar-case retrieval
- Live ContextDesk provider execution (the mock adapter is the #879 CI path)
- LLM-as-judge (forbidden as scoring authority; any later judge follows #867)

## Non-goals

- GUI, `cd-server`, or live incident-response
- Duplicating production triage orchestration
- Writing ContextDesk compatibility, qualification, readiness, or routing state
- Inventing root causes to make unresolved cases scorable
