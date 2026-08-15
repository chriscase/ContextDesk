# cd-triage-bench

Headless **source-neutral incident-triage evaluation bench**: a local library of
cases, immutable evidence snapshots, imported strategy runs, expert
adjudication, and honest comparison reports.

This crate is **not** the ContextDesk engine, GUI, or web collaboration layer.
It has no `cd-core` dependency, no network client, and no keychain access.
ContextDesk participates later as one strategy among many (#879), through public
SDK contracts, not by absorbing case management.

Working name: `cd-triage-bench` (rename-friendly; crate prefix stays `cd-*`).

Status: first slice (#877 store/entities plus a report-only #881 sketch)
is on `main` via #890/#891. This branch adds **manual import / provenance**
(#878) and **rubric v1 + expert adjudication** (#880). Not a close of epic
#876. Not release-ready. ContextDesk SDK adapter remains #879. Comparison
report aggregation remains #881.

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
cd-triage-bench --library ./bench-lib review-packet "$RUN_ID" --phase support
cd-triage-bench --library ./bench-lib import-adjudication ./adj.json
cd-triage-bench --library ./bench-lib review-packet "$RUN_ID" --phase diagnosis
cd-triage-bench --library ./bench-lib show adjudications "$ADJ_ID"
cd-triage-bench --library ./bench-lib report --format json --privacy share-safe
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
`duplicate <run_id>`. A different raw hash, or the same raw bytes with a
different fairness/strategy identity, prints `created <run_id>` (and
`near_duplicate_of=` when the raw digest already exists). There is no edit
verb; changing fairness on a stored record fails closed.

## Rubric v1 and adjudication

Documented rubric and score schema:
[`docs/RUBRIC_V1.md`](docs/RUBRIC_V1.md).
Worked adjudication example:
[`fixtures/templates/adjudication.example.json`](fixtures/templates/adjudication.example.json).

`review-packet --phase support` is a blinded review packet: no structured
strategy identity and no case resolution. If masking is impossible, the
packet records why (`blinding.kind = unblinded`). Diagnosis phase is
allowed only after a support adjudication exists.

`import-adjudication` attaches deterministic citation-existence **flags**
(`citation_not_in_snapshot:<id>`). It never writes scores. Two reviewers
are two records; `show adjudications` renders both rationales. Re-scoring
under rubric v2 creates new records and leaves v1 scores byte-identical.

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
