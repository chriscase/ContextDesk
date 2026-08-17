# cd-triage-bench

Headless **source-neutral incident-triage evaluation bench**: a local library of
cases, immutable evidence snapshots, imported strategy runs, expert
adjudication, and honest comparison reports.

This crate is **not** the ContextDesk engine, GUI, or web collaboration layer.
It has no `cd-core` dependency, no network client, and no keychain access.
ContextDesk participates later as one strategy among many (#879), through public
SDK contracts, not by absorbing case management.

Working name: `cd-triage-bench` (rename-friendly; crate prefix stays `cd-*`).

Status: first slice (#877 store/entities) is on `main` via #890/#891. This
branch adds **manual import / provenance** (#878), **rubric v1 + expert
adjudication** (#880), and **report-only comparison** over stored records
(#881). Not a close of epic #876. Not release-ready. The SDK-driven batch
runner is residual until #879. No composite leaderboards.

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
  review-packets/<packet_id>.json
  blobs/sha256/<hh>/<hex>
```

- Snapshot, task, run, adjudication, and score identities are content-addressed
  (SHA-256 of canonical JSON of the digest body).
- Records are **immutable**. A second write with different bytes fails closed.
  Identical full payloads are idempotent. Corrections are new records.
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
| `TriageRun` | `run-<sha256>` of task, snapshot, source, strategy, raw digest, metadata, and fairness |
| `Adjudication` | `adj-<sha256>` of reviewer, rubric, outcomes, phase, and review-packet binding |
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
`score_id` / `run_id`. Additive changes use a new schema id (`v2`); legacy v1
adjudications without phase or packet fields remain readable with their
historical digest and are never rewritten in place. There is no implicit
upgrade. Current report output is `backtest_report.v2`.

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
cd-triage-bench --library ./bench-lib review-packet "$RUN_ID" --phase support
cd-triage-bench --library ./bench-lib import-adjudication ./adj.json
cd-triage-bench --library ./bench-lib review-packet "$RUN_ID" --phase diagnosis
cd-triage-bench --library ./bench-lib show adjudications "$ADJ_ID"
cd-triage-bench --library ./bench-lib report --format json --privacy share-safe
cd-triage-bench --library ./bench-lib report --format jsonl --privacy owner-only
cd-triage-bench --library ./bench-lib report --format markdown
```

Human submission template: [`fixtures/templates/human-run.md`](fixtures/templates/human-run.md).
Worked example: [`fixtures/templates/human-run.example.md`](fixtures/templates/human-run.example.md).

The markdown body after the closing ` ``` ` fence is the raw write-up. Import
skips only that one leading newline and otherwise stores the body byte-exact
(trailing spaces included). `raw_output_utf8` in the JSON, when present, wins
over the markdown body. `--raw` wins over both and is the binary-safe path.

`show runs <id>` prints completeness (`exact` / `partial` / `unknown`) and
leaves unknown cost, timing, prompt, workflow, and strategy version as
`{"status":"unknown"}`. Re-importing an identical payload prints
`duplicate <run_id>`. A different raw hash, or the same raw bytes with
different material metadata, fairness, or strategy identity, prints
`created <run_id>` (and `near_duplicate_of=` when the raw digest already
exists). There is no edit verb; changing fairness or other metadata on a
stored record fails closed.

## Rubric v1 and adjudication

Documented rubric and score schema:
[`docs/RUBRIC_V1.md`](docs/RUBRIC_V1.md).
Worked adjudication example:
[`fixtures/templates/adjudication.example.json`](fixtures/templates/adjudication.example.json).

`review-packet --phase support` is a blinded review packet: no structured
strategy identity and no case resolution. If masking is impossible, the
packet records why (`blinding.kind = unblinded`). Each adjudication carries
the generated `review_packet_id`; the store verifies packet identity and
blinding, and diagnosis phase also requires a prior support record by the same
reviewer. Missing raw artifacts fail closed rather than claiming blinding.

`import-adjudication` attaches deterministic citation-existence **flags**
(`citation_not_in_snapshot:<id>`). It never writes scores. Two reviewers
are two records; `show adjudications` renders both rationales. Re-scoring
under rubric v2 creates new records and leaves v1 scores byte-identical.

## Report-only comparison (#881)

`report` is a deterministic projection over stored runs and adjudications.
It never creates judgments and never executes a strategy. JSON, JSONL, and
markdown are byte-stable for the same records. Groups are exact
task + snapshot identity. Different snapshots or fairness classes are
**incomparable** (reason included), never force-ranked. Version N vs N−1
pairs list improved/regressed/unchanged dimensions with drill-down to runs
and adjudications. Unscored, failed, and partial runs stay visible and are
not treated as zero. Partial dimension coverage is reported separately from
fully scored runs. Version pairs skip incomparable fairness/snapshot pairs,
non-completed baselines, and source/build identity mismatches. Scores are
never pooled across rubric versions. `share_safe` drops owner-only
records/titles/rationales/reviewers and fails closed on a privacy scan;
withheld scores are counted separately from genuine absence. `owner_only`
keeps that detail.

**Residual:** an SDK-driven batch runner that executes ContextDesk across a
case set, including mid-batch failure coverage. That needs #879. Imported
runs already join this report from storage.

## Future scope (explicitly not this slice)

- Web collaboration / shared review UI (#883–#888)
- Object-storage ingestion for large corpora
- Direct web-tool / browser automation (manual import is the path here)
- Multi-strategy synthesis
- Similar-case retrieval
- ContextDesk public-SDK adapter (#879)
- LLM-as-judge (forbidden as scoring authority; any later judge follows #867)

## Non-goals

- GUI, `cd-server`, or live incident-response
- Duplicating production triage orchestration
- Writing ContextDesk compatibility, qualification, readiness, or routing state
- Inventing root causes to make unresolved cases scorable
