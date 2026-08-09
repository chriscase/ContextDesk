# Quality-evaluation harness (hermetic milestone)

Status: **local integration** on branch `feat/quality-eval-harness-v1` (issue #867).
This document describes the **cage** for measuring model/retrieval usefulness.
It does **not** claim any live model is useful or verified.

## Evidence boundaries

| Evidence class | What it is | Written by this harness? |
| --- | --- | --- |
| **Compatibility** | Synthetic probe readiness (`capability_qualification`) | **Never** |
| **Retrieval quality** | Recall@k, MRR, nDCG, must-include/exclude, leakage | Yes (deterministic) |
| **Answer quality** | Schema, citations, facts, abstention, role separation | Yes (deterministic) |
| **Orchestration quality** | Multi-model / policy outcomes | Schema-ready only (`none` fingerprint) |
| **Live optional** | Real gateway experiments | Defaults to `not_scheduled` |

Quality results must never alter model compatibility/readiness stores.

## Quality-unit identity

A quality unit is the full subject of a score. Results do not transfer across units.

Fields (see `QualityUnit` in `cd_core::quality_eval::types`):

- build/commit identity
- gateway profile id + endpoint fingerprint + exact model id
- task mode
- prompt-set hash
- answer-schema version
- suite id + suite content digest
- retrieval mode label
- sampling configuration
- orchestration-policy fingerprint
- quality-eval schema version

**Same model id on two gateways = two subjects.** Storage ids include the gateway profile id.

## Lanes

| Lane | Hermetic form | Later live attachment |
| --- | --- | --- |
| `fixed_packet` | Same frozen evidence for every candidate | Live model completes on that packet |
| `oracle_packet` | Host-curated decisive rows | Upper bound for “can the model solve with evidence?” |
| `product_path_fixture` | Frozen retrieval shortlist through answer scoring | Product handoff vs answer defects |
| `lexical_retrieval` / `embedding_*` / `product_hybrid` | Schema reserved | Live runners add rankings only |

Unrun lanes use `not_scheduled` / `blocked` / `cancelled` / `failed` — never silent pass.

## Deterministic authority order

1. Host-only truth (`truth.json`) — never imported into runtime.
2. Deterministic retrieval metrics and answer dimensions.
3. Optional judge metadata — **advisory only**; cannot override deterministic failures (`JUDGE_OVERRIDE_REJECTED`).

Prose style / subjective usefulness is not a deterministic pass/fail in this milestone.

## Fixture layout

```text
fixtures/quality-eval/open-v1/
  suite.json
  cases/<case-id>/
    runtime.json   # model-visible documents, packets, rankings, scripted candidates
    truth.json     # host-only relevance, roles, required/forbidden ids
```

Isolation rules:

- Evaluator tokens (`must_include`, `root cause`, `decoy:`, …) must not appear in
  document text, questions, or candidate prose.
- Schema field names are not searchable document content.
- No employer data, credentials, private endpoints, usernames, or absolute paths.

## Retrieval metrics

Implemented in `cd_core::quality_eval::metrics`:

- Recall@K
- MRR
- nDCG@K (graded gains; default gain 1)
- must-include recall
- must-exclude rate
- foreign-incident hit count
- upstream vs final recall when both lists exist

Invalid rankings (empty when required structure fails, duplicate ids, unknown ids)
**fail closed** with typed reasons — no manufactured credit.

## Optional blinded Grok / reference judging

Not scheduled in this milestone. Records always include:

```json
"judge": { "status": "not_scheduled", "note": "optional_judge_not_scheduled_in_hermetic_milestone" }
```

Future policy (non-binding design):

1. Host scores first.
2. Anonymize packets / answers.
3. Pairwise position-swap; inconsistent pairs discarded.
4. Judge never sees truth manifests for auto-scored dimensions.
5. Deterministic failures always win.

## Attaching later live experiments

Live DeepSeek / Grok / Vercel / embedding / rerank runners should:

1. Produce `RetrievalRanking` and/or `CandidateAnswer` records with the same schemas.
2. Bind a full `QualityUnit` (including real endpoint fingerprint and model id).
3. Call `score_retrieval` / `score_answer` without changing historical suite digests.
4. Mark live lanes `executed` only when they ran; leave hermetic-only lanes as-is.
5. Never write `model-qualifications.json` or readiness badges from quality scores.

## Security and privacy

- Default tests: zero network, Keychain, Grok session, or external model calls.
- Export gate rejects `sk-`, `Bearer `, home paths, etc.
- Lab refuses overwrite without `--force`.
- Lab stdout/stderr never prints absolute suite paths in success summaries when writing
  (basename only for `--output`).

## Non-goals

- General provider framework / plugin registry
- Production router or automatic “best model” selection
- Ensemble consensus engine
- Claiming live model usefulness
- Replacing retrieval-ablation or capability qualification

## Commands

From the repository root (or any cwd that can walk to `fixtures/quality-eval/open-v1`):

```bash
# Validate fixture isolation + digest
cargo run -p cd-core --bin cd-quality-eval-lab -- validate

# Hermetic run → JSON on stdout
cargo run -p cd-core --bin cd-quality-eval-lab -- run

# Explicit suite path + write (no overwrite without --force)
cargo run -p cd-core --bin cd-quality-eval-lab -- run \
  --suite fixtures/quality-eval/open-v1 \
  --format json \
  --output /tmp/quality-eval-report.json

# Focused tests
cargo test -p cd-core --lib quality_eval
cargo test -p cd-core --test quality_eval_lab
```

Environment:

- `CONTEXTDESK_QUALITY_EVAL_SUITE` — override suite directory
- `CD_GIT_SHA` — optional build identity for the quality unit

## Implementation map

| Concern | Location |
| --- | --- |
| Types / schemas | `crates/cd-core/src/quality_eval/types.rs` |
| Retrieval metrics | `…/metrics.rs` |
| Answer scoring | `…/answer_score.rs` |
| Suite load / isolation | `…/suite.rs` |
| Hermetic runner | `…/run.rs` |
| Export | `…/export.rs` |
| Lab binary | `crates/cd-core/src/bin/cd-quality-eval-lab.rs` |
| Integration tests | `crates/cd-core/tests/quality_eval_lab.rs` |
| OPEN fixtures | `fixtures/quality-eval/open-v1/` |
