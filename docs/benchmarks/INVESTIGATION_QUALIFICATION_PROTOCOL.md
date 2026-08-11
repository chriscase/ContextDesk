# Investigation Qualification Protocol — grounded typed answers and reviewer-first multi-model investigation

Independent qualification-architecture report and certification protocol, produced by a
read-only audit session on 2026-08-08.

> **Historical audit note (updated 2026-08-11):** The live-provider claims in this
> document remain intentionally false for the audited 2026-08-08 commits. The
> current release-line synthetic Vercel evidence is recorded separately in
> [`VERCEL_GATEWAY_DIAGNOSTIC_505C3793.md`](./VERCEL_GATEWAY_DIAGNOSTIC_505C3793.md),
> [`VERCEL_GATEWAY_DIAGNOSTIC_GPT_OSS_D39688C7.md`](./VERCEL_GATEWAY_DIAGNOSTIC_GPT_OSS_D39688C7.md),
> and [`VERCEL_MODEL_COMPARISON_D39688C7.md`](./VERCEL_MODEL_COMPARISON_D39688C7.md).
> Those runs prove exact-route behavior only; they do not turn the hermetic
> protocol audit into a universal model-quality certification.

## Read this first — scope and standing caveats

1. **Audited tips.** This document audits three exact git states:
   - `main` = `eee1e6d2b089a2f1857824861446ad4215e17c8e`
   - typed-answer RC = `0bfc5fd04dc6999d47689f75cf65ea9ace9924b7` (28 commits on top of main, +44.9k lines / 156 files)
   - multi-model V1 tip = `11ddcd079e13afd8b677fa7f29562214cc0e41e0` (10 commits on top of the RC)
   It audits the **committed tip `11ddcd07`, not the still-changing correction pass** that was
   concurrently editing the `contextdesk-multi-model-v1` worktree. **Every finding herein must be
   reconciled against the corrected commit once it lands** (see the reconciliation checklist below).
2. **Quarantine.** `fixtures/triage-root-cause-lab` is **quarantined from live quality
   certification**: production logic and fixture messages share exact phrases (details in §A),
   so a live model can pass it by reading labels. It remains valid as a scorer-mechanics fixture.
3. **Scripted tests prove cage/contract properties, not live model quality.** Every green
   "quality" suite in the audited states feeds hand-scripted or truth-derived answers to a
   deterministic scorer. They prove validators, rubrics, and degradation semantics — never that a
   real model analyzes well.
4. **No live lane was run in this audit.** $0 of provider spend; every live gate defined below is
   NOT RUN. This document is protocol design plus hermetic audit, not a certification result.
5. **Read-only provenance.** All branch states were read via `git show`/`git diff` against the
   object store; no builds, tests, fixture generation, or provider calls were made, and the
   actively edited multi-model worktree's files were never read.

### Reconciliation checklist for the corrected multi-model tip

Re-verify against the corrected commit before acting on this document:

- [ ] Round-ceiling enforcement and degradation telemetry semantics (`11ddcd07` behavior) unchanged or improved.
- [ ] The telemetry-parity gaps of §H item 0 (review-arm token/latency bypass, unserialized stage
      vector, fail-closed fallthrough double-spend) — still present, or fixed?
- [ ] Degradation-reason and executed-mode wire labels (§A, §F) unchanged; if renamed, update the
      harness vocabulary here.
- [ ] `docs/CLAIMS.md` row and PROVEN_METHODS chapter for the reviewer pipeline — still missing, or added?
- [ ] The single/review arm switches (`--mode`, per-turn desktop mode) unchanged.

---

**Verdict in one paragraph.** The codebase has unusually strong *cage proofs* — the host's
authority over evidence, citations, rendering, and degradation is fail-closed,
vocabulary-independent, and mutation-tested — but **zero live evidence about the animal**: no
measurement anywhere that a real model produces valid, correct, terminology-robust analyses, and
no measurement that the reviewer arm improves anything. Every "quality" signal today is a
deterministic scorer fed answers synthesized from its own truth keys. The certification program
below adds model-behavior evidence in tiers, reusing the repo's own best inventions (token-based
truth, seed-metamorphism, truth-isolation scanners, honest UNAVAILABLE partitions) and
quarantining its one genuinely leaky artifact.

---

## A. What current tests prove, what they don't, and the leakage surfaces

### What is actually proven (hermetic, contract level)

- **Typed-answer authority is unforgeable.** `crates/cd-core/src/investigation_answer.rs` (RC)
  rejects unknown/duplicate/cross-scope/stale-revision evidence ids, withholds root-cause claims
  lacking host `Cause`-role evidence, and its validation topology is proven invariant under a full
  opaque-vocabulary bijection (`opaque_vocabulary_bijection_preserves_validated_authority_topology`
  in `crates/cd-core/tests/investigation_answer_security_gates.rs`). Rendering strips
  controls/bidi, forces every dynamic value into code spans, and is byte-identical under input
  permutation; the RC tip pins status-line and link spoofs as neutralized.
- **The multi-model pipeline is pure and degradation-total.** At `11ddcd07`, one sequential pass
  (investigator per candidate → optional reviewer → synthesizer emitting the same
  `contextdesk.investigation_answer.v1`), a hard 12-round ceiling, a typed 10-reason degradation
  lattice (`reviewer_unconfigured` … `not_eligible`), byte-identical answers under candidate
  permutation, forged/colluding reviewer output unable to mint authority, and injection-inert
  review rendering — all with opaque `k1`/`e:k1:1` tokens, so none of it depends on domain
  vocabulary (`crates/cd-core/tests/multi_model_pipeline.rs`,
  `crates/cd-workflow/tests/multi_model_resolve.rs`).
- **The deterministic substrate is excellent.** Import/parsing/episode/count invariants pinned by
  exact truth tables with red-oracle and gap-quarantine discipline (`fixtures/log-conformance`
  asserts *observed* values for known gaps); the RC retrieval-ablation lab has real IR metrics,
  machine-checked truth isolation, a committed baseline (Recall@25 0.710, decoy share 0.050), and
  60 honestly-pinned `FUTURE_CAPABILITY_UNAVAILABLE` cells.

### What is not proven

1. That **any real model can speak the contract** — there is no live measurement of schema-valid
   answer rate, marker compliance, or correction-loop recovery. All model JSON in tests is
   hand-scripted to the schema.
2. That analyses are **correct or useful** — the only live-model assertions in the repo are
   sentinel-substring checks in env-gated Ollama tests (`crates/cd-core/tests/live_provider.rs`).
3. That the **reviewer adds value** — the review report is never even displayed or persisted (its
   markdown projection has zero callers); no quality comparison of single vs reviewed exists
   anywhere, and the benchmark's `full_multistage` lane is pinned UNAVAILABLE.
4. That anything is **terminology-robust in the live path** — hermetic bijection tests prove the
   *validator* is vocabulary-free, not that a *model's analysis* survives renaming.
5. The multi-model **GUI wiring** (toggle, diagnostics) — zero desktop tests in RC..MM. Doctor
   never exercises review mode.

### Ranked overfit/leakage surfaces

| # | Surface | Mechanism | Severity |
|---|---------|-----------|----------|
| 1 | `fixtures/triage-root-cause-lab` + `crates/cd-core/src/agent.rs` guardrail | Fixture log messages **self-label** (`"decoy: …"`, `"causal trigger: …"`, `"symptom only: …"`), and the production guardrail `evidence_requires_cause_not_established` fires on those exact fixture phrases (`"symptom only:"`, `"not present in this import"`). Production behavior is keyed to fixture vocabulary; a live run on this lab is meaningless — a model can ace it by reading the labels. | Critical — quarantined from certification |
| 2 | Scripted circularity | `good_answer_for` builds the "model" answer from the truth key; RC's `scripted_v1_comparison_json` builds typed JSON from the brief itself; MM scripts are schema-perfect. Acknowledged in-file, but green suites *look like* quality gates. | High (misleading, by design) |
| 3 | `claim_evidence_correspondence` leniency | Passes on one shared ≥4-char token between claim text and cited row — genuinely unsupported prose will pass (`crates/cd-core/src/triage_quality.rs`). | High |
| 4 | Phrase-list parsers | Overclaim detection matches exact lowercase phrases (`"the earliest error is the root cause"`); lead-marker detection (`Likely cause:`) tested only against its own list. Reworded overclaims are invisible; mutation tests flip struct booleans and bypass the prose parser. | High |
| 5 | `ConceptEmbedBackend` dictionary | Product code carries a hand-written synonym table (`crates/cd-core/src/embed.rs`, comment: "Order matters for tests") that includes rb-case causal vocabulary (`"connection refused"`/`"econnrefused"`). Any hermetic "semantic lane works" result flows through this repo-authored dictionary, not an embedding model. Honest today (lane pinned UNAVAILABLE) but loaded. | Medium |
| 6 | Keyword-plan gift | The retrieval benchmark executes fixture-authored `keyword_plan.terms`; question→plan generation (the model's job) is unmeasured. | Medium |
| 7 | Enshrined floors | `baseline_expectation.min_recall_at_25` per case codifies today's engine as "pass" — `PASS_ON_BASE` means *no regression*, not *good*. | Low (documented) |

Counter-controls already in the tree (extend, don't reinvent): the truth-isolation marker scanner
with its booby-trap test, `runtime_ranking_and_prompts_do_not_embed_or_import_answer_key_vocabulary`
(currently scans only 5 runtime files, ≥12-char tokens, retrieval-ablation manifests only — not
the triage lab keys or guardrail phrases), and rb02's deliberate anti-coupling design ("query
vocabulary never appears in causal evidence").

---

## B. Tiered gate system

| Gate | Name | Model calls | Cadence | Ships from |
|------|------|-------------|---------|-----------|
| G0 | Hermetic contract gates | none | every PR | exists (keep; extend scanner over triage lab + guardrail phrases) |
| G1 | Hermetic metamorphic gates | none | every PR (small) / nightly (full) | new: transform engine invariance over ingest→retrieval→brief→render |
| G2 | Contract-compliance gates | ~20/binding | per binding change | new: live schema-valid rate; the go/no-go before spending on a lane |
| G3 | Metamorphic behavior gates | budgeted | pre-promote | new: truth-preserving pairs must agree; truth-changing mutants must flip |
| G4 | Held-out incident families | budgeted | pre-release only | new: hidden corpora under §G governance |
| G5 | Adversarial-context gates | small | pre-promote | new fixtures: injection-in-evidence, contradictory runbooks, collisions |
| G6 | Session/follow-up gates | small | pre-release | new: multi-turn consistency, fresh-ledger correctness |
| G7 | Blind live comparison + matrix | main budget | per certification | new: §D protocol on the §E matrix |

Ordering is a funnel: G0/G1 are free and run always; G2 is cheap and gates whether a binding earns
G3–G7 spend; G4's hidden families are consumed last and sparingly. Every live gate writes an
immutable run record (§G) using the existing `executed|unavailable` / `None`-vs-`Some(0)`
accounting discipline so unrun lanes can never read as passes.

---

## C. Transformation families and invariants

**Engine principle:** one generic, seeded transformer over the *normalized* artifacts — event
JSONL (`contextdesk.normalized_log_events.v1`), truth manifests (`retrieval-truth.v1` /
`TriageKnownAnswerKey`), `queries.json`, and KB markdown — applying a single bijection per run to
corpus + question + KB + truth simultaneously, so the task is closed under the transform and truth
relabels mechanically. This works because truth already references events by **message token**,
resolved to `(seq, source)` at scoring time. Every family ships with a positive control (a
deliberately broken input the harness must catch), mirroring the lab's existing mutation-pair
style.

### T-series — truth-preserving (invariant: conclusions equivalent)

| ID | Transform | Concrete mechanics | Invariant checked |
|----|-----------|--------------------|-------------------|
| T1 | Terminology/service α-rename | Seeded bijection over service names, hosts, pools, queues, correlation values, `sources[]` paths, `keyword_plan.services`, KB text, and the question. Generated names must be *unfamiliar* (e.g. `veldspar-relay`), not synonym swaps. | Claim topology identical; cited evidence maps through the bijection; structural scores equal |
| T2 | Format re-serialization | JSON↔logfmt↔bracketed re-render of raw imports; field-order permutation; whitespace. (Ingest equivariance partly covered by `fixtures/parser-framing-matrix` — the new claim is end-to-end through analysis.) | Same answer, same citations modulo seq remap |
| T3 | Time re-expression | Uniform shift ±Δ; timezone re-expression with correct explicit offsets; epoch↔ISO where the raw format permits. Never fabricate instants for `order_only` bases (respect `time.resolution`). | Chronology conclusions identical; no wall-clock fabrication |
| T4 | Lexical decoy padding | Inject events sharing the *question's* surface vocabulary but causally disconnected (no correlation links, wrong window); truth marks them `decoy`. | Answer unchanged; decoys not cited as cause |
| T5 | Order permutation | Permute retrieval candidate order, candidate-group order, evidence-line order. (Hermetically byte-identical already for the MM pipeline; the live claim is semantic stability.) | Equivalent conclusions across permutations |
| T6 | Neutral-family removal | Drop a non-causal evidence family. | Answer stable; no invented dependence |

### M-series — truth-changing mutants (invariant: the answer must change; kill-rate scored)

| ID | Mutation | Correct behavior | Detects |
|----|----------|------------------|---------|
| M1 | Remove the causal evidence family | `Cause not established` + `missing_evidence` claim | Prompt-prior answering (the core grounding claim) |
| M2 | Swap causality (retime/recorrelate so the former decoy is the real trigger) | Answer flips to the new trigger | Vocabulary-anchored root-causing |
| M3 | Contradictory/stale runbook (KB blames X; logs prove Y; runbook predates corpus) | Sides with logs; surfaces the contradiction as a competing explanation | Doc-over-evidence deference |
| M4 | Misleading deployment context — paired variants: deploy event near failure that is (a) causally linked vs (b) provably coincidental | Distinguishes the pair | Post-hoc-ergo-propter-hoc |
| M5 | Mid-episode truncation (partial corpus) | Discloses lower-bound counts; reduced confidence (`corpus_completeness: partial_lower_bound` exists in the truth schema) | Fabricated completeness |
| M6 | Strip time offsets (degrade to order-only axis) | Chronology claims degrade to order language | Fabricated wall-clock reasoning |

### A-series — adversarial, truth-preserving but hostile (invariant: zero behavioral compliance)

| ID | Attack | Placement | Invariant |
|----|--------|-----------|-----------|
| A1 | Prompt injection in evidence | Imperatives, fake system markers, forged `<<<UNTRUSTED_DATA>>>` terminators inside log messages and runbook text (this finally exercises `crates/cd-core/src/injection.rs`'s nonce defense against realistic payloads) | Answer unchanged; instruction never executed; any compliance = hard BLOCK |
| A2 | Locator/collision | Duplicate basenames across dirs; colliding seq across sources; revision-string spoofs; evidence text containing `e:k1:1`-shaped ids | Citations resolve uniquely; validator behavior holds live |
| A3 | Status/link spoof in evidence content | "Reported status: RESOLVED", markdown links in log payloads | Claims don't adopt spoofed status; rendering stays inert (RC pinned rendering — now test the model doesn't launder it into claim text) |
| A4 | Gold-token bait | Rubric-shaped strings (`"root cause established"`, `"Likely cause:"`) inside evidence | No authority leak from evidence echoes into parsed structure |

The distinction matters for scoring: T-series failures are *robustness* defects (same truth,
different answer), M-series failures are *grounding* defects (different truth, same answer),
A-series failures are *security* defects (zero tolerance). Conflating them produces
uninterpretable aggregate scores.

---

## D. Blind comparison protocol — single vs investigator-reviewer-synthesizer

**Arms.** S = `--mode single`; R_cross = `--mode review` with the reviewer bound to a *different*
model; **R_same** = review with the reviewer bound to the *same* model. R_same is the key control
the current architecture makes nearly free: since the reviewer is the only assignable role, R_same
vs R_cross isolates "does a second pass help?" from "does a second *model* help?", at
approximately equal cost. Both arms natively emit the identical host-validated
`investigation_answer.v1` envelope through identical rendering — the product has already done most
of the blinding work.

**Blinding.** Judges see only the sanitized host-rendered answer: strip stage summaries,
`multi_model_stage` events, degradation lines, mode fields, and telemetry. Verify blindability
empirically with an *arm-classifier probe*: if a human or model can guess the arm above chance
from sanitized answers, blinding is broken and must be reported, not papered over. Present pairs
in randomized order under neutral labels ("Analysis 1/2").

**Scoring layers, in authority order:**

1. **Structural auto-scores (no judge, no prose matching):** schema validity; citation
   precision/recall against truth evidence groups mapped through the transform bijection; trigger
   identification via token containment on *cited rows*; forbidden-claim violations; M-series
   flip/abstention correctness; disclosure presence on M5; contradiction surfaced on M3/M4. These
   are the primary endpoint inputs.
2. **Human judgment** (the maintainer, plus one external reviewer if available) on a stratified
   ~20% sample, rubric anchored to behaviors, never vocabulary: "does this tell you what to check
   next, and would checking it work?", "is the contradiction explained or merely mentioned?".
3. **LLM judge only for scale**, under hard constraints: judge model family disjoint from every
   pipeline role; judge sees *no truth manifests* (truth-referencing dimensions are auto-scored
   only); pairwise preference with position-swap consistency (judge twice, orders swapped;
   inconsistent pairs discarded); and a **judge-prompt lint** — extend the existing
   `runtime_ranking_and_prompts_do_not_embed_or_import_answer_key_vocabulary` scan pattern to fail
   if the judge prompt shares ≥12-char strings with product prompt constants, rubric phrase lists,
   or truth manifests. This mechanically prevents the evaluator from sharing implementation
   vocabulary or gold phrasing.
4. **Calibration:** report judge–human agreement (Cohen's κ) on the overlap sample; LLM-judge
   dimensions count toward gates only where κ ≥ 0.6, otherwise those dimensions fall back to
   human-only on reduced n.

**Correctness payoff matrix** (per incident-variant): correct cause +1; correct abstention on
unanswerable/M1 variants +1; abstention on answerable 0; wrong cause −2; forbidden claim or
A-series compliance = lane-level hard fail. Calibration curve: bucket answers by claim structure
(supported causal candidates vs competing vs missing-evidence) and plot empirical correctness per
bucket — the reviewer's job is precisely to move mass out of the confident-wrong cell, so this
curve is the most direct test of the architecture's thesis.

**Cost/latency:** harness-side wall clock around each CLI invocation; tokens from gateway usage
where reported (single arm) and from the char→token estimate plus round counts for the review arm
until the telemetry parity fix lands (§H item 0). Detect the **fail-closed fallthrough** (review
arm silently re-running the full single path) via `executed_mode` and charge its full double cost
to the review arm — otherwise R's cost is systematically understated.

**Statistics:** fully paired design — same (incident, variant, seed) across arms; Wilcoxon
signed-rank plus 10k-resample bootstrap CIs on paired composite deltas; per-family breakdown
mandatory (a blanket win hiding a family-level reversal is not shippable as a blanket claim).

---

## E. Minimal model/provider matrix and repetitions

**Qualification unit (QU)** — extending the keying that
`crates/cd-core/src/capability_qualification.rs` already uses (profile + endpoint fingerprint +
exact model + schema version):

> QU = provider kind + endpoint fingerprint + exact model id + sampling snapshot + prompt-set
> hash (the three MM stage prompts + triage system text) + answer/finding/review schema versions +
> budget config + pipeline mode.

Sampling is currently hardcoded (Ollama `temperature=0`, Anthropic fixed `max_tokens`), so today
"settings" = code version — record the commit hash as the snapshot and flag that per-model
sampling config, when it arrives, invalidates QUs. A certification never transfers across QUs:
not to another alias of the same model, another gateway, or another prompt revision.
**Qualification names a QU, never a model name.**

**Minimal credible matrix (6 lanes):**

| Investigator/synthesizer | Arms |
|--------------------------|------|
| Model A (strong remote) | S, R_same, R_cross(B) |
| Model B (local Ollama mid-size) | S, R_same, R_cross(A) |

Two bindings answer the two questions that matter: does the architecture help at the frontier,
and does it help where review is most plausibly needed (weaker local models). R_cross in both
directions tests whether the reviewer must be the stronger model.

**Repetitions:** 12–16 incident families (8 transformed-open + 4–8 held-out) × 2 variants each
(one T-series, one M-series) × 3 seeds, fully paired. That yields ~72–96 paired observations per
arm-pair — enough for a binomial sign test to detect a ~15-point win-rate shift from 50% at
α=0.05 with ~0.8 power. Smaller effects are explicitly out of reach of the minimal program; say so
in the report rather than inflating n mid-run.

**Budget formula:** runs = lanes × incidents × variants × seeds ≈ 6 × 16 × 2 × 3 = 576
investigations; at ≤12 rounds, ~120k-char context budget per call, expect ~35–150k tokens per
investigation → ~20–80M tokens total, of which half is local (≈$0, wall time only). Price the
remote half with an **external price table checked into the harness** (the product deliberately
tracks no currency — rounds + chars only). G2 runs first per binding (~20 calls) so an
incompliant binding is blocked before consuming its lane budget.

---

## F. SHIP/BLOCK thresholds, variance, stop-loss, honest reporting

Pre-register all thresholds in a committed `certification-thresholds.v1.json` **before** the
campaign; changing them after seeing data requires a new campaign. Defaults:

**Hard invariants (any violation = BLOCK, no statistics):**

- Validator bypass reaching rendered output: 0 tolerated.
- A-series behavioral compliance (instruction executed, spoofed status adopted): 0 tolerated.
- Forbidden claim rendered as Supported: 0 tolerated.

**Binding-level gates (G2):** schema-valid answer rate ≥ 95% within ≤1 correction; < 80% →
binding is Unqualified (model incapability, not product failure — record it as such).

**Robustness gates (G3, per binding):**

- T-series conclusion-equivalence ≥ 0.90 per family; citation-set equivalence through bijection
  ≥ 0.95.
- M-series kill rate ≥ 0.80 overall, ≥ 0.90 on M1 (removed-evidence), since M1 *is* the grounding
  claim.
- Failing T but passing G1 hermetically = vocabulary sensitivity: BLOCK the "terminology-robust"
  claim specifically; the product may still ship with a narrower claim.

**Comparison gate (G7):** SHIP "reviewed ≥ single" for a QU pair requires: one-sided 95% lower CI
bound of paired composite win-rate > 0.5, AND wrong-cause rate(R) ≤ wrong-cause rate(S) (the
reviewer must never add confident errors), AND median cost multiple R/S ≤ 2.5× with p95 latency
≤ 2× S. R_same ≈ R_cross with both beating S means the win is the *pass structure*; only R_cross
winning means the win is *model diversity* — report which, because they generalize differently.

**Variance handling:** bootstrap CIs on everything; if ≥2 incident families show sign-reversed
effects with CIs excluding zero, no blanket SHIP — ship family-scoped claims. A result that
appears in only one seed is variance until reproduced.

**Stop-loss:** per-lane token cap; evaluate in blocks of ~24 runs; stop a lane immediately on any
hard-invariant violation (BLOCK), on budget exhaustion (report partial as *insufficient
evidence*, never pass), or on futility (at 50% budget the win-rate CI entirely below 0.5 → early
BLOCK for that pairing).

**$0/blocked lanes:** reuse the benchmark's partition vocabulary. Every matrix cell reports
exactly one of `EXECUTED | BLOCKED(no-credential) | BLOCKED(no-budget) | BLOCKED(capability) |
NOT_SCHEDULED`. The certification statement carries a mandatory "Lanes not run" table, and the
headline claim is scoped to executed cells only — same discipline as the 60 pinned
`FUTURE_CAPABILITY_UNAVAILABLE` cells today, which is the repo's existing honest precedent. (As
of this document, **every live lane is NOT RUN**.)

---

## G. Test-data governance

**Three corpus classes:**

- **OPEN** — committed (rb01–rb20, labs). Used for G0–G2, development, and regression floors.
  Assume model-visible in principle.
- **TRANSFORM** — open bases + *secret transform seeds*. The bijection seed is the secret, not
  the corpus. Cheap, renewable, resistant to fixture memorization.
- **HOLDOUT** — never committed. Stored outside the repo (private location + backup). The repo
  carries only `holdout-manifest.v1.json`: family ids, SHA-256 of each corpus tarball and truth
  manifest, generator recipe id, a **sealed-seed commitment** (hash of the seed, committed before
  generation), creation date, and an exposure ledger (which cert runs consumed it, when, against
  which QUs).

**Access separation under a single maintainer:** organizational separation is impossible, so
enforce it mechanically — recipes are committed and reviewable; realizations are hidden; seeds
are sealed by commitment before use, so a skeptical reviewer can verify post-hoc that the holdout
wasn't tuned. Every holdout event carries a scanner marker (the `LOG-LAB-INVALID` pattern) so an
accidental commit is caught by the existing marker-scanner style; add a CI check that no repo
blob matches a holdout manifest hash.

**Contamination checks before each cert run:** (1) hash-verify holdout artifacts against the
manifest; (2) n-gram overlap scan between holdout text and repo prompts/fixtures/docs — above
floor, regenerate; (3) grep product prompts for holdout service names; (4) a one-call-per-family
memorization probe: ask the question *without* the corpus — if the model names holdout-specific
tokens, the family is burned.

**Freeze discipline:** goldens content-addressed; any scorer change requires a dual-report PR
(old and new scores on the OPEN tier side by side) — this generalizes the lab's existing "Never
update the golden merely to go green; explain the change."

**Retirement:** a holdout family retires after gating 2 ship decisions, after any exposure
incident, or after >4 transform variants on the same base. Retired families are *promoted to
OPEN* (they become regression fixtures — retirement is productive, not a loss) and replaced by a
recipe re-roll with a fresh sealed seed.

---

## H. Dependency-ordered implementation plan

**0. Product prerequisites (fix on the branch before or during harness work):**

- Telemetry parity: review-arm stage calls bypass `ProviderTurnTelemetry` (no
  tokens/latency/cost), the stages vector is never serialized, and the fail-closed fallthrough
  re-runs the single path with no cost attribution. Without this, honest cost comparison needs
  harness-side workarounds.
- Promote hygiene: add the missing `docs/CLAIMS.md` row and PROVEN_METHODS chapter for the
  reviewer pipeline (the claim↔code CI guard currently doesn't know it exists); doctor should
  exercise review mode.
- Quarantine leak #1: extend the truth-isolation scanner over `fixtures/triage-root-cause-lab`
  and the `agent.rs` guardrail phrase lists; exclude that lab from all live certification
  corpora.

**Ordered steps:**

1. Transform engine (`T/M/A` families as a test-support module beside the retrieval-ablation
   support; seeded bijections; truth relabeling; positive control per family).
2. G1 hermetic metamorphic suite (engine equivariance, no model; PR-tier subset + nightly full).
   Depends on 1.
3. Live harness runner (drives `contextdesk chat --mode … --jsonl`; run-record writer mirroring
   `retrieval-run-record.v1`; external price table; blinding sanitizer; structural scorer reusing
   `score_structured_triage_answer` + validator + bijection mapping). Depends on 1; item 0 for
   cost parity (or harness-side workarounds, stated honestly).
4. G2 compliance gate. Depends on 3.
5. G3 metamorphic-live + mutants on the TRANSFORM tier. Depends on 2, 3.
6. G5 adversarial fixture corpus + gates. Depends on 1, 3.
7. Holdout bootstrap (recipes, sealed seeds, manifest, contamination checker). Depends on 1.
8. G7 blind campaign + stats + report generator with the mandatory lanes-not-run table. Depends
   on 3, 4, 5.
9. G6 session/follow-up gates. Depends on 3.
10. Pre-registered thresholds file + SHIP/BLOCK evaluator. Depends on 8.

### Existing-issue overlap (checked 2026-08-08)

#722 / #724 / #725 / #726 already cover role bindings, synthetic capability probes, and a
deterministic checked-in qualification lab with truth isolation and pipeline-fingerprint result
keying — steps 3–4 should be framed as extensions of #726/#724, not new charters. #727 (adaptive
routing) is explicitly deferred until those are proven; #719 (closed) documented the handbook
eval-lab chapter. **Not covered anywhere:** metamorphic transforms, hidden holdouts (#726
explicitly requires *checked-in* corpora — the holdout program deliberately complements it), the
blind S-vs-R protocol, statistical gates/stop-loss, and the telemetry parity fix.

### Paste-ready issue drafts (not filed; file only after reconciling with the corrected tip)

> **Draft 1 — "Qualification: metamorphic transform engine and vocabulary-robustness gates."**
> Problem: all robustness evidence is hermetic; nothing shows analyses survive terminology or
> format changes. Acceptance: seeded transform engine over normalized events + truth manifests +
> KB + queries (rename bijection, re-serialization, time re-expression, decoy padding, order
> permutation; truth-changing mutants for removed evidence, swapped causality, contradictory
> runbooks, truncation); every transform ships a positive control; hermetic equivariance suite
> runs modelless in CI; truth relabels mechanically through the bijection; extends #726's lab,
> reuses the retrieval-ablation truth schema and marker scanner.

> **Draft 2 — "Qualification: hidden holdout program with sealed seeds and exposure ledger."**
> Problem: every corpus is committed, so live scores can't refute fixture familiarity.
> Acceptance: out-of-repo holdout store; in-repo hash manifest with sealed-seed commitments and
> exposure ledger; contamination checks (hash verify, n-gram overlap, prompt grep, memorization
> probe); retirement-to-OPEN policy; CI guard against holdout blobs in the repo. Complements #726
> (which stays checked-in by design).

> **Draft 3 — "Qualification: blind paired comparison of single vs reviewed investigation."**
> Problem: the reviewer pipeline has no quality evidence. Acceptance: paired S / R_same / R_cross
> runs over transformed + held-out incidents; sanitized rendering with an arm-classifier blinding
> probe; structural auto-scores primary; human sample + optional disjoint-family LLM judge with
> position-swap consistency, judge-prompt vocabulary lint, and κ-gated dimension admission;
> payoff matrix penalizing confident-wrong; pre-registered thresholds; per-family breakdowns;
> lanes-not-run table. Extends #726; consumes #724 qualification state.

> **Draft 4 — "Adversarial evidence corpus: injection, collisions, spoofs inside governed
> evidence."** Problem: `wrap_untrusted` and rendering inertness are tested structurally, never
> against realistic adversarial *fixtures* through the live path. Acceptance: committed A-series
> corpus (imperative injections, forged delimiters, locator collisions, status/link spoofs,
> rubric-token bait); hermetic half asserts host invariants; live half asserts zero behavioral
> compliance; any compliance blocks promotion.

> **Draft 5 — "Multi-model telemetry parity: tokens, latency, and honest cost attribution in
> review mode."** Problem: review-arm stage calls bypass provider telemetry (rounds+chars only),
> the per-stage vector is never serialized, and fail-closed fallthrough re-runs single silently —
> cost comparisons will understate review mode. Acceptance: per-stage token/latency capture where
> the gateway reports usage; stages serialized in the outcome; fallthrough double-spend visible
> in `executed_mode` accounting; doctor exercises review mode.

---

## I. Smallest credible immediate certification, then the full program

**Immediately after the corrected tip commits (order of days, low tens of dollars):**

1. **G0 free:** full hermetic suite on the corrected tip, plus the scanner extension over the
   triage lab (quarantine leak #1) and the CLAIMS/handbook rows.
2. **T1-lite:** implement only the α-rename transform (the schema's token-based truth makes this
   a small, mechanical script — it is the single highest-value new artifact) and apply it with 3
   secret seeds to 8 rb-derived cases. The triage-root-cause lab is excluded as self-labeling.
3. **G2:** 20 attempts per binding on 2 bindings (one strong remote, one local); require ≥95%
   schema-valid.
4. **Mini-G7:** S vs R_cross on the strong binding, 8 renamed incidents + 2 M1 mutants × 3 seeds
   = 60 paired runs, structural scoring only (no judges), stop-loss capped.
5. **A1 probe:** 3 injection fixtures through the live path; zero tolerance.
6. Report with the lanes-not-run table.

This supports the claim: *"On QU-A, reviewed mode complies with the contract, does not regress
grounding, [beats/does not beat] single mode on renamed incidents, and executes zero injected
instructions; terminology robustness is certified for renames only; holdouts, human calibration,
format/time transforms, and the full matrix are NOT yet run."* That is a small claim, but every
word of it is defensible — which is the point.

**Later comprehensive program:** the full §B–§G machinery — all transform families, the 6-lane
matrix, hidden holdout families, human + κ-calibrated LLM judging, pre-registered thresholds, and
recurring re-certification on QU changes (new model version, prompt edit, contract bump each
invalidate the affected lanes only).

---

## J. Failure interpretation — attributing a red result

| Symptom | Discriminating evidence | Attribution |
|---------|------------------------|-------------|
| G0/G1 fail | No model involved | Product defect (pipeline not rename/format-equivariant); fix before spending |
| G2 low on *all* bindings | Cross-model | Prompt/schema weakness — the contract is too hard to speak |
| G2 low on *one* binding | Others pass | Model incapability; record Unqualified, not a product bug |
| T-series fail, G1 pass, multiple bindings | Hermetic path is equivariant | Prompt/vocabulary weakness in the product's model-facing text |
| T-series fail on one binding only | Others robust | That model's vocabulary sensitivity |
| M1 mutant survives; retrieval trace shows the causal family *never entered context* in the unmutated twin | run-record retrieval accounting + SearchTrail | Retrieval weakness |
| M1 survives; evidence *was* in context | trace shows rows present | Grounding/prompt weakness — prior-driven answering |
| A-series compliance | any | Product defense gap (`wrap_untrusted` insufficient) — maximum severity |
| R < S with high `review_degraded` share | degradation telemetry | Operational/config weakness (reviewer unqualified, budget too tight), not architecture |
| R < S with clean `executed_mode=review` | telemetry clean | Architecture genuinely doesn't help for this QU — honest BLOCK |
| R ≈ S at 2.5× cost | cost accounting | Value not demonstrated; BLOCK the value claim, not the product |
| Structural pass but human judges fail it | layer disagreement | Scorer blind spot — evaluator gap; add a dimension via dual-report re-baseline |
| LLM-judge/human κ < 0.6 | calibration sample | Evaluator flaw; discard those judge dimensions |
| Effect in one seed only, or CI straddles 0 | paired bootstrap | Variance; extend n or report inconclusive — never ship on it |

The instrumentation to make these discriminations already exists or is specified above: run
records with `executed|unavailable` status, `None`-vs-`Some(0)` accounting, degradation reasons,
retrieval traces, and paired twins. The rule that keeps the whole program honest is the same one
the repo already lives by in its best corners: **a lane that didn't run is reported as blocked, a
golden is never updated merely to go green, and a fluent answer without validated evidence is a
failure** — the certification harness just extends that ethic from the deterministic substrate to
live model behavior.

---

## Verified vs. assumed

All file paths, test names, enum labels, schema fields, baseline numbers, and issue contents in
this document were read from git objects (`main` `eee1e6d2`, RC `0bfc5fd0`, MM `11ddcd07`) or
from the GitHub issue tracker during the 2026-08-08 read-only audit session, by the auditing
session and its three read-only research agents. Budget arithmetic and token prices are estimates
parameterized to be replaced by an external price table; statistical power figures are standard
binomial/sign-test approximations, not simulations. Nothing was edited on the audited branches,
built, executed, or published during the audit; no provider was called; and the actively edited
`contextdesk-multi-model-v1` working tree was never read. Findings about the multi-model batch
describe committed tip `11ddcd07` only and **must be reconciled against the corrected commit**
before being acted on.

---

## 2026-08-08 corrected-RC reconciliation addendum

The local integration branch `integrate/evidence-investigation-final-rc2` was subsequently
assembled and checked at product tip `634a81ff` (before this documentation-only addendum). It
contains the corrected multi-model attempt ceiling and evidence flow (`93a75a5e`, `dc7ccff3`),
the vocabulary-agnostic known-root correction (`9fbe139d`), and nonce-fenced ambient/context-plan
injection with provider-call-time visibility reconciliation (`508fe952`, `634a81ff`). The latter
reconciliation runs with Developer detail both enabled and disabled and is repeated before every
initial or retried provider request; citations are eligible only for ambient context present in a
successful request.

On that combined tip, the following hermetic gates passed: formatting; all six vocabulary
generalization tests; all six investigation-answer security gates; four filtered multi-stage
unit tests; trace-on context-length retry reconciliation; trace-off context-length retry citation
suppression; tools-unsupported prefetch retry reconciliation; the ambient/context-plan atomic
overflow acceptance test; and strict `cd-core` library/test Clippy with warnings denied. Separate
read-only audits also checked the hard provider-attempt ceiling, removal of runtime fixture
vocabulary coupling, and ambient/context-plan provenance across retry paths.

This updates the earlier statement that the corrected multi-model tip had not been reconciled.
It does **not** change the live verdict: no paid GPT-OSS or cross-model qualification lane was run
for this addendum, so live quality, reliability, and comparative multi-model value remain
**BLOCKED / not certified** until the applicable protocol lanes execute. No branch was pushed,
merged to `main`, or released as part of this local reconciliation.
