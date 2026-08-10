# Triage quality adversarial suite (hermetic)

Status: **hermetic infrastructure** on branch `test/triage-quality-benchmark-expansion-v1`.
This document describes a versioned adversarial fixture suite and safe multi-suite
matrix. It does **not** claim any live model, embedding, or reranker is useful.

Companion docs:

- [`QUALITY_EVAL_HARNESS.md`](QUALITY_EVAL_HARNESS.md) — cage contracts
- [`quality-eval-coverage-v1.json`](quality-eval-coverage-v1.json) — machine-readable coverage inventory

## Evidence boundaries

| Allowed | Forbidden |
| --- | --- |
| Synthetic public-safe fixtures | Live provider / model / embedding / rerank calls |
| Host-only `truth.json` | Truth tokens in model-visible runtime |
| Scripted candidates + rankings | Readiness / compatibility badge writes |
| Per-suite digests + matrix summary | Merging or rewriting historical digests |

Quality results never alter model readiness stores.

## Relationship to open-v1

`fixtures/quality-eval/open-v1` remains the historical baseline. Its digest is
**not** mutated by this work. Adversarial coverage lives in a separate suite:

```text
fixtures/quality-eval/adversarial-v1/
  suite.json
  README.md
  cases/<case-id>/{runtime.json,truth.json}
```

| Suite | Suite id | Role |
| --- | --- | --- |
| open-v1 | `quality-eval-open-v1` | Historical hermetic baseline |
| adversarial-v1 | `quality-eval-adversarial-v1` | Causal-role / abstention / retrieval ablation stress |

## What adversarial-v1 measures

Fourteen multi-dimensional cases. Each case includes:

- model-visible synthetic runtime material
- host-only truth (roles, required/forbidden identities, expectations)
- opaque evidence ids (`d01`, `d02`, …)
- at least one expected-good scripted candidate
- targeted expected-fail mutations
- packets and/or rankings that separate retrieval loss from answer failure
- a documented reason to exist (see coverage JSON)

### Case map

| Case | Primary pressure |
| --- | --- |
| `adv01-three-independent-incidents` | Collapse / absorb multiple independents |
| `adv02-multi-legitimate-triggers` | Drop or replace a second legitimate initiator |
| `adv03-shared-symptom-separate-causes` | Shared symptom with separate upstream faults |
| `adv04-trigger-plus-promoted-symptom` | Valid trigger masking promoted symptom; citation sprinkle |
| `adv05-independent-absorbed` | Independent demoted into main chain; foreign id |
| `adv06-loud-decoy-before-trigger` | Frequency + precedence decoys |
| `adv07-recovery-and-config-change` | Config-change chronology; recovery-as-cause |
| `adv08-cross-service-chain` | Multi-hop gate→worker→api chain |
| `adv09-vocab-identity-traps` | Same vocab / wrong identity; paraphrase same incident |
| `adv10-missing-initiating-abstention` | Observation-backed abstention vs hedged certainty |
| `adv11-partial-observation-contradiction` | Structured/prose contradictions |
| `adv12-chronology-and-time` | Order-only chronology; ambiguous vs resolved time |
| `adv13-cross-source-duplicates` | Correlation ids + near-duplicate renderings |
| `adv14-retrieval-packet-ablations` | Scripted lexical/semantic/hybrid/rerank/dropped/short/padded lists |

## Retrieval and packet ablations

Ablations are **scripted rankings / packets**, not claims about a real embedding
or reranker. `adv14` encodes:

- oracle / fixed / product-shaped packets
- lexical, synthetic semantic, synthetic hybrid rankings
- reranked shortlist with upstream list
- shortlist after decisive evidence is dropped
- short and decoy-padded lists

Measured metrics (existing hermetic schemas):

- Recall@K, MRR, nDCG@K
- must-include recall, must-exclude rate
- foreign-incident hit count
- upstream versus final recall

Invalid rankings still fail closed. No production retrieval dialect was invented.

## Answer-scoring contracts covered

Focused tests prove the deterministic scorer fails closed for:

- valid trigger + separately promoted symptom
- valid trigger + absorbed independent incident
- hedged wording with structured causal claims under abstention
- generic abstention without an established observation
- citations without decisive fact coverage
- decisive facts with foreign identities
- truth / answer-key vocabulary never in runtime packets
- unknown roles / confidence fail closed
- expected-fail mutations are cage successes, not harness failures
- candidate names carry no evaluator authority

## Commands

```bash
# Validate suites independently (digests preserved)
cargo run -p cd-core --bin cd-quality-eval-lab -- validate --suite fixtures/quality-eval/open-v1
cargo run -p cd-core --bin cd-quality-eval-lab -- validate --suite fixtures/quality-eval/adversarial-v1

# Run suites independently
cargo run -p cd-core --bin cd-quality-eval-lab -- run --suite fixtures/quality-eval/open-v1
cargo run -p cd-core --bin cd-quality-eval-lab -- run --suite fixtures/quality-eval/adversarial-v1

# Combined safe summary (does not merge digests; does not touch readiness)
cargo run -p cd-core --bin cd-quality-eval-lab -- matrix --suite open-v1 --suite adversarial-v1
cargo run -p cd-core --bin cd-quality-eval-lab -- matrix --suite open-v1 --suite adversarial-v1 --output matrix.json

# Convenience script
./scripts/quality-eval-suite-matrix.sh
./scripts/quality-eval-suite-matrix.sh /tmp/matrix.json --force
```

Matrix output separates:

- expected-good candidates met / missed
- expected-fail mutations correctly rejected
- unexpected passes
- unexpected failures (expected-good missed)
- retrieval metric row counts
- answer metric row counts
- skipped / not-scheduled lanes (`judge`, `live_optional`, orchestration)

## Tests

```bash
cargo test -p cd-core --lib quality_eval
cargo test -p cd-core --test quality_eval_lab
cargo test -p cd-core --test quality_eval_adversarial_lab
```

## Survivor / gap section (live work still required)

Hermetic scripted candidates **must not** be read as model usefulness.

1. **Semantic entailment** — lexical citation overlap cannot catch every hedged
   paraphrase that still asserts causality. Needs a blinded judge lane that may
   veto deterministic passes but never rescue deterministic failures.
2. **Real retrieval systems** — attach live embedding / hybrid / rerank
   `RetrievalRanking` records per `QualityUnit` without rewriting suite digests.
3. **Production rubric parity** — `triage_quality.rs` still needs a separate
   hardening pass for trigger+promoted-symptom and independent-absorption
   invariants; quality-eval success is not production proof.
4. **Cross-model comparison** — later compare DeepSeek, Grok, GPT-OSS, Mistral,
   Qwen on fixed-packet then product-path packets; keep readiness untouched.
5. **Parser-resolved chronology** — adv12 encodes resolved timestamps as text;
   real timezone/parser pipelines still need live attachment.

Recommended later sequence:

1. Fixed-packet live answers on open-v1 + adversarial-v1 (cheap models first).
2. Product-path live answers on the same quality units.
3. Attach embedding / hybrid / rerank rankings to `adv14` query ids.
4. Blinded pairwise judge on abstention/hedging survivors only.
5. Only then discuss relative usefulness — never compatibility badges.
