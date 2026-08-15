# Rubric v1 and score schema

Schema id: `contextdesk.triage_bench.rubric.v1`

Human experts are the scoring authority. Deterministic assists may pre-fill
**flags** only. They never produce scores. There is no LLM judge.

Every `ScoreReview` (`contextdesk.triage_bench.score_review.v1`) stores
`rubric_version` and binds `case_id` + `task_id` + `snapshot_id` + `run_id` +
`adjudication_id`. A rubric change never rewrites an existing score.
Re-adjudication under `contextdesk.triage_bench.rubric.v2` (or later) creates
new records.

## Dimensions

Scores are integers `0..=3`, or `not_applicable`, or `unscorable` with a
reason. Composite indices and rankings are out of scope (#881).

1. **diagnosis_correctness** — judged only against the evaluation-only
   resolution. `not_applicable` on unresolved or unscorable cases. Reviewers
   must not invent a root cause.
2. **evidence_support** — do cited items exist in the snapshot, and do they
   support the claims? This dimension is scored from a **support-phase**
   review packet that excludes case resolution.
3. **actionability** — would the proposed next steps have moved the incident
   forward?
4. **uncertainty_calibration** — is expressed confidence honest relative to
   the evidence?
5. **unsafe_unsupported_claims** — confident fabrications, invented
   citations, or invented root causes are penalized explicitly.

## Verdicts

| kind | meaning |
| --- | --- |
| `score` + `value` | Expert score `0..=3` |
| `not_applicable` | Dimension does not apply (diagnosis on unresolved cases) |
| `unscorable` + `reason` | First-class at case (`lifecycle: unscorable`), run (`status: unscorable`), and dimension level |

## Review workflow

1. `review-packet <run_id> --phase support` — blinded packet: no structured
   strategy identity, no case resolution. If masking is impossible (non-UTF-8
   raw, or the raw text contains the strategy name), `blinding` is
   `unblinded` with a reason.
2. Expert writes an adjudication JSON (see
   [`../fixtures/templates/adjudication.example.json`](../fixtures/templates/adjudication.example.json)).
3. `import-adjudication` stores the adjudication and a derived `ScoreReview`.
   Citation-existence checks attach `citation_not_in_snapshot:<id>` flags on
   evidence_support and unsafe_unsupported_claims. Verdicts are unchanged.
4. `review-packet <run_id> --phase diagnosis` — allowed only after a support
   adjudication exists; may reveal resolution so diagnosis can be scored.
5. A second reviewer is a second adjudication. Disagreement is preserved.
   Nothing averages the two.

`show adjudications <id>` prints reviewer identity, conflict-of-interest,
blinding, per-dimension verdicts, rationales, and assist flags.
