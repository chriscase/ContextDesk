# Vocabulary-agnostic known-root investigation

Status: shipped on this branch (hermetic gates); live-model certification
remains open. Companion tests: `crates/cd-core/tests/vocab_generalization_gates.rs`.

## Problem

The known-root/symptom distinction in the single-model linked path was partly
**vocabulary-coupled**: production recognized the frozen triage-lab fixture's
literal wording and acted on it. Renaming the fixture's free text flipped
host behavior, which means the hermetic green was partially proving phrase
recognition, not reasoning or typed enforcement.

## Leak map (before this change)

| # | Site | Coupling | Disposition |
|---|------|----------|-------------|
| L1 | `agent.rs` `evidence_requires_cause_not_established` | Substring-matched raw bounded evidence for fixture phrases: `symptom only:`, `symptom-only`, `root cause not established`, `cause unknown`, `not present in this import`, `not included in this import`, `source unavailable in the corpus`, `source is unavailable in the corpus`, `causal source is outside the import` — a transcription of `fixtures/triage-root-cause-lab/cases/missing-root-evidence` log lines. Untrusted corpus text could steer host behavior. | Removed |
| L2 | `agent.rs` `host_cause_not_established_answer` | Host-fabricated `Cause not established:` answer replacing the model's answer when L1 fired — string matching presented as causal truth. | Removed |
| L3 | `agent.rs` linked synthesis call site | `causal_overclaim = L1(evidence) && answer_overclaims_cause(answer)` drove a retry then a rewrite (`linked_causal_overclaim_rejected`, `linked_host_cause_not_established`). | Removed; citation-identity grounding (retry → appendix → withhold) unchanged |
| L4 | `agent.rs` inline unit test | Embedded the fixture lexicon in a scanned runtime file. | Removed with L1–L3 |
| L5 | `triage_quality.rs` `triage_answer_contract_system_text` | Production prompt quoted `not present in this import` and `source unavailable in the corpus` and echoed the fixture's `symptom-only` convention — a vocabulary gift teaching models the fixture-recognizable phrasing. | Rewritten: same principles, semantic wording, explicitly "in whatever wording the corpus itself uses" |
| L6 | `triage_quality.rs` unit test | Asserted the prompt **contains** `not present in this import`, pinning the gift. | Inverted; absence enforced by the derived scan |

Audited and found **not** coupled (kept unchanged): `classify_structural_template_pattern`
(cross-language stack-structure syntax, format-level), `triage_interpretation_brief_guardrails`
(typed facts/rules), tool-host correlation ranking (count/order formulas, no
token matching), `search.rs` / `hybrid_retrieval.rs` / `linked_search_bound.rs`
(identity/count mechanics, no aliases), multi-model prompts and contracts
(typed sections, host-only establishment), rubric/answer keys (evaluator-only,
frozen). No `token_aliases` table exists in production; the ban is now scanned
across nine runtime files instead of five.

## Design position

The host cannot deterministically decide, from arbitrary log text, that
"the evidence self-describes as symptom-only with a coverage gap." Any phrase
list, synonym set, or regex that pretends otherwise is memorization that
untrusted corpus content can also steer. So the host no longer decides that
question at all:

- **Host authority (kept, all vocabulary-free):** claim-scoped evidence
  attachment and anti-union scope checks, bounded sections, fail-closed
  citation-identity grounding with one retry then appendix/withhold, durable
  locators, typed establishment only from `EvidenceRole::Cause` provenance
  (production assigns only `Neutral` today, so establishment stays withheld —
  `Root cause established: no` — until a typed provenance source exists),
  role-withhold (`ClaimStatus::Withheld`) when cited evidence cannot support
  an initiating-cause claim.
- **Model judgment (under the de-vocabularized contract):** whether evidence
  semantically establishes a mechanism, expressed through the contract leads
  (`Likely cause:` / `Cause not established:`) and the bounded sections, with
  explicit uncertainty required when the causal source is outside the corpus.
- **Multi-model path:** unchanged; establishment was already host-only and
  typed at final synthesis, and stage-2 investigators structurally cannot
  express establishment.

Consequence accepted deliberately: a model that overclaims a cause with valid
citations is no longer silently rewritten by the host. That honesty gap is a
model-quality property, measured by the evaluator rubric and future live
qualification — not something a string matcher can fix, only fake.

## How the gates resist overfitting

`vocab_generalization_gates.rs`:

- **Metamorphic invariance:** the same shipped linked/broad turn runs over the
  fixture-echo lexicon and three alpha-renamed corpora (including a hedged
  phrasing), under three answer styles (confident lead, withheld lead, plain
  prose). Outcome fingerprints (verbatim release, error codes, completion
  reasons, demotion markers) must be equal across vocabularies — a
  vocabulary-coupled branch anywhere in the path breaks equality. Passing by
  recognizing words is impossible by construction.
- **Unseen-rename honesty:** the alien marker words are asserted absent from
  the entire fixture tree and the production sources before the renames are
  trusted as "unseen".
- **Fail-closed positive control:** fabricated citation identities are
  withheld identically across all vocabularies.
- **Typed establishment controls:** establishment and claim status flip with
  the typed evidence role while text is held constant, and stay fixed while
  text flips between causal-flavored and bland-alien content; anti-union
  scope rejection holds under both lexicons at stage 2 and final synthesis.
- **Derived lexicon scan:** the forbidden lexicon is derived at run time from
  the frozen fixture tree (word-boundary prefixes of message-bearing
  answer-key tokens ≥ 12 chars; 3–6-word import-message phrases ≥ 14 chars),
  so the ban list grows with the fixtures and cannot be satisfied by renaming
  a hardcoded list. Contract identifiers (typed section/field names) are not
  message-bearing and stay legal. `token_aliases` remains banned everywhere.

## Residual limitations

- Hermetic gates prove host invariance and typed enforcement; they cannot
  prove live models actually reason about renamed corpora. Live-provider
  qualification on renamed/paraphrased corpora remains the open certification
  step (no paid calls from this branch).
- The derived scan bans lexicon from `fixtures/triage-root-cause-lab` in nine
  runtime files; other fixture families remain covered by the existing
  security-gate scan for the retrieval-ablation tree.
- `EvidenceRole::Cause` has no production assigner yet; single-model typed
  establishment therefore stays conservatively withheld.
