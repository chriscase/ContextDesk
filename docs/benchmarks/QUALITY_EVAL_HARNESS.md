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
Evidence-class markers are derived from rows actually present in the run;
their defaults are false, and an empty suite is rejected rather than reported
as executed quality evidence.

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
Storage-id components are length-framed, so provider/model strings containing
separator characters cannot collide with a different component split.
When `CD_GIT_SHA` is supplied, the full value is retained rather than a
display-shortened prefix so distinct builds cannot collapse into one quality
unit.
Suite digests use length-framed manifest, case-id, runtime, and truth segments,
so byte shifts between adjacent files cannot preserve the same digest.

## Lanes

| Lane | Hermetic form | Later live attachment |
| --- | --- | --- |
| `fixed_packet` | Same frozen evidence for every candidate | Live model completes on that packet |
| `oracle_packet` | Host-curated decisive rows | Upper bound for “can the model solve with evidence?” |
| `product_path_fixture` | Frozen retrieval shortlist through answer scoring | Product handoff vs answer defects |
| `lexical_retrieval` / `embedding_*` / `product_hybrid` | Schema reserved | Live runners add rankings only |

The optional judge lane is recorded as `not_scheduled` in hermetic runs.
Reserved retrieval lanes are absent until a runner invokes them; once a lane
is represented, `not_scheduled` / `blocked` / `cancelled` / `failed` never
count as a pass.

## Deterministic authority order

1. Host-only truth (`truth.json`) — never imported into runtime.
2. Deterministic retrieval metrics and answer dimensions.
3. Optional judge metadata — **advisory only**; cannot override deterministic failures (`JUDGE_OVERRIDE_REJECTED`).

Prose style / subjective usefulness is not a deterministic pass/fail in this milestone.

`LaneStatus::Executed` means the lane ran; it is not itself a quality pass.
`AnswerScore.passed` records the deterministic answer verdict. For the
hermetic cage, the overall run is `executed` only when every host-declared
expected-pass candidate passes and every host-declared mutation fails. Those
expectations live in `truth.json`; candidate names carry no evaluator authority.
The exported hermetic answer row carries the expected outcome and whether the
score matched it, so a deliberately failing mutation is not confused with a
failed expected-good candidate. Live answer scores omit those fixture fields.

An establishable case cannot pass through generic caution: the answer must
identify an established cause, cite the required identities, cover the
decisive facts, and provide a typed trigger claim. Unknown claim roles or
confidence labels fail the answer schema.
When the correct outcome is abstention, a generic “not enough information” is
also insufficient: the answer must identify and cite the observed condition
that the evidence does establish. It must explicitly state that the causal
evidence is insufficient, use cautious confidence, and contain no typed trigger
claim; a candidate cannot earn abstention credit merely by setting its
`asserts_root_cause_established` flag to false.

Establishability is resolved per evidence packet. A fixed or oracle packet may
establish a cause while an incomplete product-path packet for the same task
correctly requires abstention.

The citation text check is explicitly lexical overlap, not semantic
entailment. Host identity rules, required/forbidden citations, decisive facts,
and causal roles are authoritative; later blinded review may assess prose
support but cannot replace those checks.

### Known semantic boundary and mutation follow-up

The deterministic scorer does not understand arbitrary prose. A deliberately
self-contradictory answer can combine a valid abstention marker and cautious
structured fields with an unsupported causal sentence that uses an unforeseen
paraphrase. This is a disclosed P3 limitation, not deterministic semantic
credit. Before attaching live usefulness claims, add blinded semantic review
and adversarial “hedged certainty” candidates; judge failure may veto a
deterministic pass in that future lane but must never rescue a deterministic
failure.

After the gateway-contract and orchestration branches stabilize, run targeted
code mutation testing over `quality_eval::{answer_score,metrics,suite}` and the
gateway discovery/specialty-adapter validators. Prioritize surviving mutations
that remove fail-closed checks, alter truth authority, shrink scoring windows,
or weaken identity/privacy isolation rather than mutating the whole workspace.

The live-role-confusion mutation also exposed a separate production-rubric
follow-up in `triage_quality.rs`. The `symptom_vs_cause` masking defect
(promoted symptom greened whenever a valid trigger coexists) is hardened so
any causal candidate citing a host `symptom_message_token` without an explicit
`symptom`/`unknown` role fails, independent of candidate count. Multi-trigger
and non-symptom multi-candidate counterexamples remain green. The production
rubric still has no host-truth equivalent of quality-eval's
`independent_incident_separation` dimension; that gap is tracked separately
and must not be closed with lexical heuristics. Do not treat the
quality-evaluation scorer fix as proof that the production rubric already
covers independent-incident demotion.

## Adversarial expansion (causality + diagnostic honesty)

See [`QUALITY_EVAL_ADVERSARIAL_LANE_V1.md`](QUALITY_EVAL_ADVERSARIAL_LANE_V1.md)
for open-v1 cases qe09–qe14 (attempt usefulness, transport-vs-grounding, tool
non-progress/withdrawal, multi-model budget, chronology/contradiction, retrieval
ablation labels) and the deterministic matrix summary. That expansion reuses
this harness only; it does not claim live-provider usefulness.

## Fixture layout

```text
fixtures/quality-eval/open-v1/
  suite.json
  cases/<case-id>/
    runtime.json   # model-visible documents, packets, rankings, scripted candidates
    truth.json     # host-only relevance, roles, required/forbidden ids and candidate expectations
```

Isolation rules:

- Evaluator tokens (`must_include`, `root cause`, `decoy:`, …) must not appear in
  document text, questions, or candidate prose.
- Schema field names are not searchable document content.
- Fixture schemas reject unknown fields before scanning, so evaluator content
  cannot hide in a field that deserialization would otherwise discard.
- No employer data, credentials, private endpoints, usernames, or absolute paths.
- Model-visible evidence ids are opaque (`d01`, `d02`, …), never role or answer
  hints such as `trigger`, `foreign`, `noise`, or `bad`.
- Case directories, document/query/task/packet ids, packet contents, and all
  truth references are validated before scoring. Packet rows must be exact
  copies of corpus rows; a malformed fixture is not credited as model failure.

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
The truth manifest fixes the scoring K. A runtime ranking cannot declare a
smaller K to hide a later decoy or inflate nDCG; a conflicting K fails the
ranking contract. A short returned list is also scored against the full
host-fixed ideal window, so returning one relevant result cannot receive
perfect nDCG when additional relevant results were expected.

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

The provider-neutral, truth-isolated request/response boundary for the checked-in
known-answer cases is specified in
[`INVESTIGATION_TEAM_KNOWN_ANSWER_V1.md`](INVESTIGATION_TEAM_KNOWN_ANSWER_V1.md).
It prepares and deterministically scores provider responses, but deliberately
does not perform network execution or make readiness/recommendation claims.

Live DeepSeek / Grok / Vercel / embedding / rerank runners should:

1. Produce `RetrievalRanking` and/or `CandidateAnswer` records with the same schemas.
2. Bind a full `QualityUnit` (including real endpoint fingerprint and model id).
3. Call `score_retrieval` / `score_answer` without changing historical suite digests.
4. Mark live lanes `executed` only when they ran; leave hermetic-only lanes as-is.
5. Never write `model-qualifications.json` or readiness badges from quality scores.

## Security and privacy

- Default tests: zero network, Keychain, Grok session, or external model calls.
- Export gate rejects credential shapes and macOS, Linux, or Windows home paths
  case-insensitively.
- Lab refuses overwrite without `--force`.
- The no-overwrite open is atomic; a concurrent creator cannot turn the check
  into an accidental replacement.
- Lab stdout/stderr never prints absolute suite paths in success summaries when writing
  (basename only for `--output`).

## Non-goals

- General provider framework / plugin registry
- Production router or automatic “best model” selection
- Ensemble consensus engine
- Claiming live model usefulness
- Replacing retrieval-ablation or capability qualification

## Commands

### User CLI (product surface)

From a ContextDesk checkout (or with `--suite` / `CONTEXTDESK_QUALITY_EVAL_SUITE`):

```bash
# List bundled OPEN suites (relative path labels only)
contextdesk eval suites

# Validate fixture isolation + content digest
contextdesk eval validate
contextdesk eval validate --suite fixtures/quality-eval/open-v1

# Hermetic run — concise nontechnical text by default
contextdesk eval run

# Machine envelopes (global format flags)
contextdesk --json eval run
contextdesk --jsonl eval run

# Write a machine report (no clobber without --force)
contextdesk eval run --report-format json --output report.json
contextdesk eval run --report-format json --output report.json --force
```

`contextdesk eval` is **state-free**: it does not read app config, Keychain,
gateways, sessions, corpora, or `model-qualifications.json`, and it never
writes readiness or preference state. Outcomes always label:

- compatibility/readiness: **not evaluated**
- retrieval/answer quality: **hermetic fixture evidence only**
- live usefulness: **not evaluated**

This command does **not** prove live model usefulness, gateway verification,
embeddings, reranking, or optional judge results.

### Development lab binary

Still available for focused harness work:

```bash
cargo run -p cd-core --bin cd-quality-eval-lab -- validate
cargo run -p cd-core --bin cd-quality-eval-lab -- run
cargo test -p cd-core --lib quality_eval
cargo test -p cd-core --test quality_eval_lab
cargo test -p cd-cli --test eval_cli
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
| Suite load / isolation / catalog | `…/suite.rs` |
| Hermetic runner | `…/run.rs` |
| Export | `…/export.rs` |
| Lab binary | `crates/cd-core/src/bin/cd-quality-eval-lab.rs` |
| Product CLI | `crates/cd-cli/src/commands/eval.rs` |
| Integration tests | `crates/cd-core/tests/quality_eval_lab.rs`, `crates/cd-cli/tests/eval_cli.rs` |
| OPEN fixtures | `fixtures/quality-eval/open-v1/` |
