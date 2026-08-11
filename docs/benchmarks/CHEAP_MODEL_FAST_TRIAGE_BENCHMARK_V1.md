# Cheap-model fast-triage contribution benchmark v1

**Status:** hermetic product-design and quality benchmark only.  
**Does not claim any live model is verified, useful, or ready.**

Branch surface: `test/cheap-model-fast-triage-benchmark-v1`  
Code: `cd_core::cheap_model_fast_triage_benchmark`  
Validator authority: `cd_core::fast_triage::validate_fast_answer` + host packet builder.

## Purpose

Measure whether a **cheap/fast model can contribute bounded work** on host-grounded linked-log triage **without** becoming final authority. Final acceptance, evidence ids, causal roles, chronology, and citations remain **host-owned**.

## What is measured

| Path | Shape |
| --- | --- |
| **A** | One scripted full investigation-answer proposal through the real fast-triage validator. |
| **B** | Role decomposition → host deterministic assembly → same validator. |

### Roles represented (scripted, not live HTTP)

1. **Extraction / classification** — observations grounded on host ids.  
2. **Causal-role proposal** — initiating cause / symptom / competing placement.  
3. **Contradiction / abstention check** — reject claim ids; optional force-abstention demotion.  
4. **Optional reviewer synthesis** — may supply a full proposal; still host-validated or rejected.

### Synthetic case pack

Fixed share-safe linked-log cases include initiating causes, downstream symptoms, independent noise, chronology, same-source neighborhood, cross-source context, recovery, decoy narratives, contradictions, and opaque host evidence ids (`e:…`).

### Candidate failure / success shapes

Strong structured · sloppy-but-recoverable · unsupported causal claims · fabricated citations · omitted evidence · chronology errors · overconfident prose · useful partial extraction · symptom-as-cause · independent-noise-as-chain · role confusion · invalid structure.

## Authority and credit rules

1. Host truth and packet roles are authoritative.  
2. `validate_fast_answer` is the gate (same as production fast-triage).  
3. **Persuasive prose alone never earns credit** (overconfident free-text is fail-closed).  
4. Partial extraction may earn **partial contribution credit** when structure binds to host ids but role coverage fails — it never establishes root cause alone.  
5. Fabricated ids, unsupported roots, role confusion, chronology inversions, and invalid structure **fail closed**.  
6. Latency ms and token-budget fields on matrix rows are **labels only** — not readiness, not quality passes.

## Precedence (contribution assembly)

```text
per-role proposals (scripted) → host assembly (path B) → validate_fast_answer
single full proposal (path A) → validate_fast_answer
```

Nothing in this benchmark writes AppConfig, qualification stores, credentials, or corpora.

## Hermetic matrix

- Schema: `contextdesk.cheap_model_fast_triage_benchmark.matrix.v1`  
- Size: **4 cases × 12 kinds × 2 paths = 96** golden cells  
- Runner: `run_benchmark_matrix()` — deterministic; two runs must match.

### What cheap models can safely contribute (under host gates)

| Contribution | Safe when… |
| --- | --- |
| Structured extraction of observations | Cites only host-minted ids; host still owns roles. |
| Causal *proposals* | Host-labelled cause/symptom placement validates. |
| Contradiction / abstention signals | Used to demote or drop unsafe claims before accept. |
| Sloppy-but-schema-valid JSON | Host validator accepts; prose length is irrelevant. |

### What they must not be trusted for

| Failure mode | Host outcome |
| --- | --- |
| Fabricated evidence ids | `foreign_evidence_id` reject |
| Unsupported / noise-as-root | `root_unsupported` / independent promotion reject |
| Symptom promoted to cause | `symptom_promoted_to_cause` |
| Chronology inversion | `chronology_inverted` (and related) |
| Role confusion (same id as cause and symptom) | `contradictory_roles` |
| Overconfident free-text | `malformed_terminal` / schema reject — **no prose credit** |
| Omitted role coverage | reject; optional partial extraction credit only |

## How to run

```bash
cargo test -p cd-core --lib cheap_model_fast_triage_benchmark
cargo test -p cd-core --test cheap_model_fast_triage_benchmark
cargo test -p cd-core --test fast_triage_production_path
cargo test -p cd-core --test quality_eval_lab
```

No network, Keychain, credentials, or provider transport is required.

## Explicit non-claims

- No live OpenAI / Anthropic / Ollama / Vercel / employer model is verified.  
- No readiness or capability-qualification store is updated.  
- Latency/token labels are not SLOs and not promotion criteria.  
- Adaptive latency learning and automatic cheap-model final authority remain **out of scope**.

## Remaining gaps

- Live attachment of path A/B against a real cheap model (optional, separate credentialed lane).  
- Blinded semantic review of hedged prose that still passes deterministic structure (known quality-eval limitation).  
- Desktop UI surface for this matrix (not required for this hermetic design).  
- ToolHost end-to-end log import of the synthetic cases (packet is built from the same host ledger types production uses; corpus import is not re-run here).
