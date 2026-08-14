# Multi-model retrieval benchmark (retrieval-ablation lab)

A permanent, versioned, deterministic hidden-truth benchmark that measures the
**incremental value** of:

1. structured + keyword retrieval (current production baseline);
2. keyword + semantic embeddings (the BGE-M3 measurement lane);
3. keyword + embeddings + reranking (the Qwen reranker measurement lane);
4. complete bounded multi-stage LLM investigation.

The suite never assumes a capability is beneficial. Until a lane is
implemented, its rows display `FUTURE_CAPABILITY_UNAVAILABLE` — an unavailable
mode is never substituted, never scored, and never counted as passing.

The separate [fixed-corpus six-lane ablation](FIXED_CORPUS_RETRIEVAL_ABLATION_V1.md)
executes all retrieval combinations with deterministic synthetic adapters
through the production import/fusion seams. Those observations validate
plumbing and retention metrics only; they do not change the real BGE-M3/Qwen
capability rows or create model-quality claims.

Everything is offline and deterministic: no network, credentials, providers,
or model downloads in any default test.

## Where things live

| Concern | Location |
|---|---|
| Suite manifest + cases | `fixtures/log-lab/scenarios/retrieval-ablation/` |
| Contract documents | `fixtures/log-lab/schema/retrieval-*.v1.schema.json` |
| Committed baseline report | `fixtures/log-lab/scenarios/retrieval-ablation/reports/baseline/` |
| Generator / builder | `crates/cd-core/tests/support/retrieval_ablation*.rs` (child of the frozen `log_lab_generator.rs`) |
| Harness + mode contract | `crates/cd-core/tests/support/retrieval_ablation_harness.rs` |
| Scorer / partition / report | `crates/cd-core/tests/support/retrieval_ablation_scoring.rs` |
| Integration tests (CI) | `crates/cd-core/tests/retrieval_ablation_lab.rs` |
| Runner script | `scripts/retrieval-ablation-benchmark.sh` |
| Generated bulk tiers (never committed) | `fixtures/log-lab/generated/retrieval-ablation/` (git-ignored) |

Each case directory follows the established Log Lab hidden-truth split:

```text
cases/<case-id>/import/       # model-visible logs — the ONLY import root
cases/<case-id>/queries.json  # harness input (questions + committed keyword plans)
cases/<case-id>/truth/        # evaluator-only manifest — never import, never attach
```

`import/` is the logical `model-input/` tree and `truth/` the logical
`evaluator-truth/` tree of the benchmark contract; the repository's existing
`import/` + `truth/` naming is reused deliberately instead of creating a
parallel hierarchy.

## Hidden-truth contract

- Truth references model-visible events by **unique opaque message token**
  resolved to `(seq, source)` at scoring time (the `triage-root-cause-lab`
  convention). Group tokens are UPPERCASE hex so they can never collide with
  lowercase neutral noise ids; scorer matching is case-sensitive while the
  production search stays case-insensitive.
- Evaluator identifiers (`group_id`s, the truth schema id, `evaluator_only`,
  `answer_key`, `semantic_truth_digest`) never appear under `import/`.
  Enforced three ways: builder asserts at generation, a tree scanner over the
  committed fixtures, and a post-import probe proving those markers are not
  searchable in the durable store. A booby-trap test plants a truth manifest
  in a copy of an import tree and proves the scanner catches it.
- Neutral surface (identifiers, hosts jitter, the suite epoch ±3 days) is
  seeded (`--seed`); semantic structure is code-fixed. Tests prove
  same seed → byte-identical trees and corpus identity, and
  different seed → different neutral identities with **identical**
  `semantic_truth_digest` per case.
- Content obeys the frozen Log Lab safety scan: `.example` hosts, RFC 5737
  IPs, `LOG-LAB-INVALID` credential markers, no near-now epochs, and no
  `alpha.alpha` dotted tokens outside reserved TLDs (exception names are
  dot-free; stack frames use slash paths).

## Tiers

| Tier | Events (default seed) | How it runs |
|---|---|---|
| `small` | 10,983 (committed) | default CI via `cargo test -p cd-core --test retrieval_ablation_lab` |
| `medium` | ~250k | explicit: `scripts/retrieval-ablation-benchmark.sh medium` |
| `large` | ≥1M | explicit + resource warning: `scripts/retrieval-ablation-benchmark.sh large` |

Only neutral noise scales with tier (`x28` medium, `x124` large); truth events
stay constant, so rarity gets harder as tiers grow. Structural cases cap their
multiplier (`scale_cap`, disclosed in `suite.json` and every report).
Generation is per-case bounded in memory and a case is dropped from memory
once written. Direct generator invocation:

```bash
cargo run -p cd-core --example generate_log_lab -- \
  --profile retrieval-ablation --tier medium \
  --output fixtures/log-lab/generated/retrieval-ablation/medium
```

Every report disclosures block carries: requested tier, actual event count,
generator version, seed, truth schema id, byte size, generation duration, and
the corpus identity SHA-256. Substituting a smaller tier or corpus without
disclosure is a scored violation (`V_TIER_SUBSTITUTION`), exercised by
mutation tests.

## The twenty cases

| Case | Probe |
|---|---|
| rb01-lexical-easy | control: query and causal evidence share terminology |
| rb02-semantic-gap | database-availability question vs JDBC/IceCube/managed-connection evidence |
| rb03-rare-causal | causal records buried inside a wildcard template family |
| rb04-frequency-decoy | high-severity repetitive errors vs a small shutdown cascade |
| rb05-cross-source | trigger/propagation/symptom/recovery across four vocabularies |
| rb06-duplicate-renderings | one failure as full stack + ~200 wrapped stderr records |
| rb07-interleaved | identical exceptions from unrelated threads stay separate |
| rb08-rotations-nested | `.log.1`, date suffixes, nested basenames, ZIP/folder parity |
| rb09-time-uncertainty | mixed offsets, DST-ambiguous local time, order-only records |
| rb10-competing-roots | two equally supported explanations must both survive |
| rb11-missing-trigger | symptoms only; root must remain unknown |
| rb12-semantic-near-miss | near-identical wording across different services/incidents |
| rb13-multilingual | trigger DE / propagation ES / symptom EN / recovery FR |
| rb14-secrets-malformed | credential-shaped values, malformed UTF-8, binary + markup noise |
| rb15-recovery-evidence | recovery records must not be classified as triggers |
| rb16-search-non-progress | cosmetic query variants must return identical evidence |
| rb17-provider-interruption | transport failure stays distinct from semantic failure |
| rb18-template-heterogeneity | rare material events inside a repetitive wildcard template |
| rb19-severity-isolated | an unrelated FATAL must not outrank the supported chain |
| rb20-partial-corpus | rotation gap: totals are lower bounds, coverage never "complete" |

Each case commits seven-plus queries (broad, causal, symptom, identifier,
negative, competing, chronology) with transparent keyword plans, and a truth
manifest with incidents, causal roles (trigger/propagation/symptom/recovery/
decoy/neutral), per-query expected evidence with nDCG gains, required and
forbidden claims, competing explanations, permitted uncertainty, privacy
markers, retrieval exclusions, timestamp-certainty classes, and
raw/rendering/occurrence geometry.

## Modes and the adapter contract

`RaRetrievalAdapter` (harness) is the host-neutral seam; `RaRunRecord`
(`contextdesk.log_lab.retrieval_run_record.v1`) is the wire contract. Future
BGE-M3 / Qwen adapters plug in **without changing truth data, queries,
evidence identities, or scoring** — proven by a contract test that runs the
production semantic path end-to-end with the deterministic offline
`ConceptEmbedBackend` through the identical validator and scorer. That test is
contract validation only; it is never reported as the embedding capability.

The `structured_keyword` baseline runs through production retrieval end to
end: reviewed import (`preview_import_plan` → `verify_import_plan` →
`ingest_path_with_policy_selection_and_observer`) and event search
(`search_events_advanced`). The production literal search is a full-phrase
substring match, so a multi-term plan executes as one production search per
term — the bounded per-probe searches an investigator issues — merged in the
same chronological `(ts, seq)` order the product presents, truncated to k=50.
Rank therefore means presentation order, not relevance; the report disclosures
say so explicitly.

Accounting is fail-closed: `None` call counts mean *unknown* (blocks an
executed mode), `Some(0)` means measured zero. An executed embedding mode
without a model identity and nonzero embedding calls is a scored
`V_MODE_MISLABEL` (baseline results relabeled as embedding results).

## Metrics and partition

Per query: recall@10/25/50, precision@k, MRR, nDCG@k (graded gains, each group
credited once at its best rank), decoy contamination at 25, supplied context
characters at 25, evidence omitted at 50, engine `matched_total`/`partial`.
Per case/mode: mean recall/MRR over answerable queries, max decoy share,
rare-trigger recall (trigger groups over broad+causal queries), causal-role
coverage at 50, false-grouping contaminations, runtimes. Corpus-level
conservation (mode-independent): importer/truth event and per-source
agreement, exact token census through production queries, exclusion honoring,
secret-in-store scan, and exception geometry via
`analyze_exception_episodes` (raw/application/stderr records and semantic
occurrences). All floats round to six decimals so goldens are stable across
platforms.

Every (case, mode) classifies as exactly one of `PASS_ON_BASE`,
`BASELINE_LIMITATION`, `FUTURE_CAPABILITY_UNAVAILABLE`, `RED_REQUIRED_FIX`.
Violations force RED. Baseline gates encode **observed** small-tier reality as
regression floors (`baseline_expectation` in each truth manifest) — never
hoped-for future capability. No LLM judge exists anywhere in the pipeline.

## Committed small-tier baseline (historical snapshot, ContextDesk `7b8638f6`)

The table below is intentionally the frozen pre-adapter baseline.  The current
release line now contains production embedding/reranker factory wiring and a
workflow-level protected-file credential seam proof (see
`docs/benchmarks/FIXED_CORPUS_RETRIEVAL_ABLATION_V1.md`).  That plumbing does
not by itself constitute a live BGE-M3/Qwen quality measurement, so these
historical rows remain `FUTURE_CAPABILITY_UNAVAILABLE` until the identical
frozen corpus is run against an explicitly identified live endpoint.

From `reports/baseline/small-structured_keyword.report.md`:

| Mode | Recall@25 | Rare trigger | Decoy rate | Runtime |
|------|-----------|--------------|------------|---------|
| Structured + keyword | 0.710 | 0.583 | 0.050 | ~0.8 s |
| + semantic embedding | FUTURE_CAPABILITY_UNAVAILABLE | — | — | — |
| + reranking | FUTURE_CAPABILITY_UNAVAILABLE | — | — | — |
| + bounded multi-stage analysis | FUTURE_CAPABILITY_UNAVAILABLE | — | — | — |

Partition: 15 `PASS_ON_BASE` + 5 `BASELINE_LIMITATION` (rb02, rb03, rb04,
rb13, rb18 — exactly the semantic-gap, rare-in-template, frequency-decoy,
multilingual, and template-heterogeneity probes) + 60
`FUTURE_CAPABILITY_UNAVAILABLE`. The recurring baseline failure shape is
chronological keyword burial: broad queries whose terms also match noise fill
top-k with earlier routine events (rb04's broad query hits 100% decoy
contamination). That is the honest gap the future lanes must close — and the
suite will measure whether they actually do.

## Final-analysis hard gates

The future `full_multistage` lane is scored by the **production** triage
rubric, not a new authority: `ra_triage_key()` maps each truth manifest onto
`cd_core::triage_quality::TriageKnownAnswerKey`, and
`score_structured_triage_answer` enforces root-cause honesty,
claim-to-evidence correspondence, citation validity, competing-explanation
retention, raw/rendering/occurrence separation, chronology honesty, and
disclosure requirements. Deterministic tests already drive these gates with
honest and adversarial synthetic answers over the benchmark corpora (decoy
crowned, citation transplanted, raw volume as occurrence count, recovery as
trigger, confident order-only chronology, competing-root collapse). Context
and tool-loop bounds reuse `context_budgeting` and
`LinkedSearchProgressTracker`; rb16's committed cosmetic query variants map to
the known `SearchIntentKey` findings (R1/R2 in
`docs/TRIAGE_RELIABILITY_ORACLES.md`).

## False-green mutations

`retrieval_ablation_lab.rs` proves the scorer rejects, each paired with a
positive control: truth leaked into model input; citations transplanted to
wrong claims; raw volume as incident count; rare causal records pruned from
top-k; frequency/severity decoys crowned; unrelated incidents merged;
unavailable modes carrying results; k lowered without disclosure; tier or
corpus substituted; duplicated trials; baseline relabeled as embeddings;
identity/seed/generator omitted; partial corpus claimed complete;
recovery-as-trigger; confident order-only chronology; and the degenerate
strategies (return nothing, retrieve more than k).

## CI and regeneration

- Small tier runs in normal CI automatically: `cargo test --workspace` picks
  up `retrieval_ablation_lab.rs` on all three OSes; clippy covers it via
  `--all-targets`. No registration was needed.
- `scripts/retrieval-ablation-benchmark.sh small` is the local one-command
  gate (prints `RETRIEVAL_ABLATION_SMALL_PASS`).
- Medium/large are `#[ignore]` tests invoked by the script; they write under
  the git-ignored `fixtures/log-lab/generated/` and never gate CI.
- Wall-clock numbers are informational only; goldens exclude them.
- Missing or unreadable fixtures fail loudly with the regeneration command —
  nothing self-skips as green.

### Intentional golden updates

The committed suite (fixtures + `suite.json` + baseline reports) is frozen by
regeneration tests. To change it deliberately: edit the generator, regenerate
into an empty directory, review the complete diff, copy over the committed
tree, regenerate the baseline report (`CD_GIT_SHA=$(git rev-parse HEAD) cargo
test -p cd-core --test retrieval_ablation_lab baseline_small` writes a fresh
copy under the cargo target tmp dir), and paste the changed hashes/counts and
the reason in the PR. Never update hashes merely to make a failing regression
green.

## Honest limitations

- The medium/large tiers share the small tier's generator code path but were
  not executed in the authoring session (bulk generation is deliberately
  outside targeted validation); their event counts in `--estimate-only` are
  estimates until first generation prints exact numbers.
- `full_multistage` is `requires_live_provider` in this deterministic suite;
  its gates are exercised with synthetic answers, not live investigations.
- Baseline rank order is chronological presentation order (the product has no
  relevance ranking for literal search); recall@k measures what a bounded
  reader would actually see, which is the point.
- rb16's intent-key equivalence at the workflow layer inherits the open R1/R2
  findings; the benchmark asserts engine-level result equivalence, which holds
  today.

## Acceptance requirements for the BGE-M3 / Qwen reranker lane

See the final section of `fixtures/log-lab/README.md` § Retrieval-ablation
benchmark, and the paste-ready checklist in the close proof of the branch that
introduced this suite (`audit/multi-model-retrieval-benchmark`). In short: an
implementation must plug into `RaRetrievalAdapter`/`RaRunRecord` v1 unchanged,
carry real model identities and nonzero call counts, run the identical
committed queries and truth, beat or honestly not-beat the committed baseline
metrics, keep every conservation and isolation gate green, and flip
`FUTURE_CAPABILITY_UNAVAILABLE` to measured rows only for the modes that
actually executed.
