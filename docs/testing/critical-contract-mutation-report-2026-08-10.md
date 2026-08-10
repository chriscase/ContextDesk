# Critical-contract mutation report — 2026-08-10

**Branch:** `test/critical-contract-mutations-v1`  
**Worktree:** `/Users/chriscase/Documents/GitHub/contextdesk-critical-mutations-v1`  
**Baseline SHA:** `10435d114e7e1faa0ca6e5f8447d70d41ad91492`  
**Mutation target dir (owned only by this task):** `/Users/chriscase/Documents/GitHub/contextdesk-mutants-target-v1`  
**Tool:** `cargo-mutants 27.1.0`  
**Package under test:** `cd-core`  
**Execution mode:** sequential (`-j 1`) with shared `CARGO_TARGET_DIR` under the dedicated mutants directory; filtered lib tests per file (`cargo test --lib <module>`). Parallel `-j 2` against a shared target dir produced false timeouts and was abandoned.

Companion ledger: [`critical-contract-mutation-ledger-2026-08-10.json`](./critical-contract-mutation-ledger-2026-08-10.json).

---

## 1. Selected files and justification

Chosen from Phase 1 mutation priorities (highest-risk trust boundaries on the acceptance tip). Whole-workspace mutation was **not** performed.

| # | File | Why selected | Mutated? |
|---|------|--------------|----------|
| 1 | `crates/cd-core/src/multi_stage_budget.rs` | Final-comparison reserve / admission / comparison gates | **Yes** (full logic; excluded diagnostic `as_str`/`detail`) |
| 2 | `crates/cd-core/src/investigation_answer.rs` | Opaque evidence IDs, fail-closed validation, ledger helpers | **Yes** (validation-focused excludes for presentation helpers) |
| 3 | `crates/cd-core/src/keychain_store.rs` | Protected-file credential fail-closed path | **Yes** (metadata + open core; broad Keychain impl body-replacements mostly unviable) |
| 4 | `crates/cd-core/src/triage_quality.rs` | Production scorer role integrity | **Skipped** — known product defect (`len()==1`) already fixed on `fix/triage-role-integrity-v1` (`3c50f0f4`); not duplicated here per assignment |
| 5 | `crates/cd-core/src/capability_qualification.rs` | Readiness / evidence store | **Skipped** — large surface; deferred to next batch (disk + wall time) |
| 6 | `crates/cd-core/src/quality_eval/answer_score.rs` | Lab role integrity | **Skipped** — already hardened on acceptance (`e69327f1`); lower residual risk than production scorer |

---

## 2. Baseline

Commands (from mutation worktree):

```bash
export CARGO_TARGET_DIR=/Users/chriscase/Documents/GitHub/contextdesk-mutants-target-v1/target
cargo test -p cd-core --lib multi_stage_budget
cargo test -p cd-core --lib investigation_answer
cargo test -p cd-core --lib triage_quality
cargo test -p cd-core --lib keychain_store
cargo clippy -p cd-core --lib -- -D warnings
```

**Results (pre- and post-test-additions):** all focused suites green; strict Clippy on `cd-core` lib green after changes.

---

## 3. Mutation results by file

### 3.1 `multi_stage_budget.rs`

**Command pattern:**

```bash
cargo mutants \
  -f 'crates/cd-core/src/multi_stage_budget.rs' -p cd-core -j 1 \
  --test-tool=cargo \
  --output …/out-budget-verify \
  -E 'AdmissionDenial::(as_str|detail)' \
  --timeout-multiplier 4.0 --minimum-test-timeout 120 \
  -- --lib multi_stage_budget
```

| Stage | Total | Caught | Missed | Unviable | Timeout |
|-------|-------|--------|--------|----------|---------|
| Initial | 24 | 18 | 5 | 1 | 0 |
| After new tests (verify) | 24 | **23** | **0** | 1 | 0 |

**Viable kill rate (final):** 23/23 = **100%**  
**Unviable:** `synthesis_reserve -> Default::default()` (type not Default).

**Initial survivors (all killed by added tests):**

| Mutant | Classification | Kill |
|--------|----------------|------|
| `admit_candidate`: `>` → `>=` on needed rounds | missing test (exact `needed == max` legal) | `admit_when_needed_rounds_exactly_equal_max` |
| `synthesis_operation_cap_ms` → None / Some(0) / Some(1) | missing tests (function unused by other tests) | `synthesis_operation_cap_uses_remaining_without_extra_reserve` |
| `can_run_comparison`: `>` → `<` on used+1 vs max | missing test (equality-only fixture made invert equivalent) | `comparison_round_gate_is_strict_and_directional` |

No product defect found in budget math beyond missing boundary coverage.

### 3.2 `investigation_answer.rs`

**Command pattern:** validation-focused excludes for presentation/redaction helpers.

| Stage | Total | Caught | Missed | Unviable | Timeout |
|-------|-------|--------|--------|----------|---------|
| Initial | 33 | 21 | 6 | 6 | 0 |
| After new tests (verify) | 33 | **26** | **1** | 6 | 0 |

**Viable kill rate (final):** 26/27 = **96.3%**

**Survivors after tests:**

| Mutant | Classification | Notes |
|--------|----------------|-------|
| `validate_model_answer` L394: `\|\|` → `&&` on corpus/revision check | **equivalent / unobservable** | `HostEvidenceLedger::new` already rejects corpus or revision drift; validate-path check is defense-in-depth and cannot be reached with a ledger built only via `new` |
| (killed) `HostEvidenceLedger::get` → None | missing public-API test | killed by `ledger_get_and_candidate_ids_expose_host_bound_rows` |
| (killed) `candidate_ids` → empty / foreign | missing public-API test | same |
| (killed) empty-evidence `kind != Missing` → `==` | missing negative | killed by `empty_evidence_ids_fail_except_for_missing_evidence_claims` |

**Unviable (6):** body replacements returning `Default` for types without useful Default / leak patterns.

### 3.3 `keychain_store.rs` (focused core)

**Scope:** metadata validation + open_protected + related (exclude pure Memory/Keychain store body dumps, path helpers already well covered).

| Total | Caught | Missed | Unviable | Timeout |
|-------|--------|--------|----------|---------|
| 55 | 11 | 4 | 40 | 0 |

**Viable kill rate (at run time):** 11/15 = **73.3%** (before max-byte test; see below).

**Survivors:**

| Mutant | Classification | Follow-up |
|--------|----------------|-----------|
| `64 * 1024` → `64 + 1024` | missing size-ceiling test | killed by new `protected_file_accepts_exactly_max_bytes` (64KiB body) |
| `len > MAX` → `len >= MAX` | missing exact-bound test | killed by same test (inclusive upper bound) |
| `O_NOFOLLOW \| O_CLOEXEC` → `&` / `^` | **tool/platform limitation + defense-in-depth** | symlink fail-closed already enforced via `symlink_metadata` before open; open flags are second line of defense; no TOCTOU race harness in hermetic suite |

High unviable count: cargo-mutants body-replacing `CoreResult`/`File` constructors that do not type-check.

### 3.4 Files deliberately not mutated this night

- **`triage_quality.rs`:** product hole documented in Phase 1 (`INT-001`); correct fix lives on `fix/triage-role-integrity-v1` @ `3c50f0f4` / `7f4ebb98`. Duplicating would risk dual-branch conflict.  
- **`capability_qualification.rs` / `quality_eval/answer_score.rs`:** deferred (size, disk, diminishing return after budget/IA).

---

## 4. Tests added

| Module | Tests | Intent |
|--------|-------|--------|
| `multi_stage_budget` | `admit_when_needed_rounds_exactly_equal_max` | strict `>` on round admission |
| | `synthesis_operation_cap_uses_remaining_without_extra_reserve` | final-phase cap contract |
| | `comparison_round_gate_is_strict_and_directional` | comparison round gate directionality |
| `investigation_answer` | `ledger_get_and_candidate_ids_expose_host_bound_rows` | public ledger lookup API |
| | `empty_evidence_ids_fail_except_for_missing_evidence_claims` | EmptyEvidence vs MissingEvidence |
| | `validate_rejects_corpus_mismatch_even_when_revision_matches` | ledger construction WrongRevision on corpus drift |
| `keychain_store` | `protected_file_accepts_exactly_max_bytes` | inclusive MAX_FILE_SECRET_BYTES |

**Product fixes:** none. No assertions weakened; no timeouts expanded to hide hangs.

---

## 5. Defects fixed

None in product code. Remaining product defect **INT-001** (production `symptom_vs_cause` multi-candidate mask) is fixed on another branch and intentionally not reimplemented here.

---

## 6. Remaining mutation gaps

1. Re-run keychain core after max-byte test to confirm 2/4 survivors dead (expected).  
2. TOCTOU race harness for `O_NOFOLLOW` (needs controlled path swap under open).  
3. Full `triage_quality` campaign **after** integrating `fix/triage-role-integrity-v1`.  
4. `capability_qualification` store/stale/fingerprint operators.  
5. `agent.rs` final-comparison orchestration (large; needs slice by function).  
6. Defense-in-depth `||` in `validate_model_answer` remains equivalent under private ledger construction.

---

## 7. Disk

| Milestone | Free space (approx.) |
|-----------|----------------------|
| Phase 2 start | 131 GiB |
| After baseline compile | 127 GiB |
| High-water during campaign | ~94 GiB free (lowest observed) |
| Mutants target dir size (end) | ~30 GiB under `contextdesk-mutants-target-v1` only |
| Floor policy | Stop if &lt; 65 GiB free — **not reached** |

No cleanup of other worktrees or protected RC `…/contextdesk-evidence-final-rc2/target`.

---

## 8. Recommended next mutation batch

1. Integrate triage role-integrity first, then mutate `triage_quality.rs` symptom/cause gates.  
2. `capability_qualification.rs` with scripted-transport unit filter only.  
3. `agent.rs` slices: admission loop + validate_model_answer call sites.  
4. Keychain: TOCTOU + `O_NOFOLLOW` custom flag contract under unix cfg.  
5. Optional: re-score keychain after max-byte test for ledger completeness.

---

## 9. Aggregate score (files fully re-verified)

| File | Viable mutants | Killed | Survived | Score |
|------|----------------|--------|----------|-------|
| multi_stage_budget | 23 | 23 | 0 | **100%** |
| investigation_answer | 27 | 26 | 1 (equiv.) | **96.3%** |
| keychain core (pre max-byte re-run) | 15 | 11 | 4 | **73.3%** (expected ↑ after new test) |

**Combined (budget + IA verified):** 49/50 viable = **98%** (counting equivalent survivor as non-kill).

---

## 10. Safety

- No live providers, Keychain OS access for mutation runs (file-backed temp only).  
- No acceptance branch disturbance.  
- No PRs opened.  
- Push only `test/critical-contract-mutations-v1`.
