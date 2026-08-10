# Overnight integration audit — 2026-08-10

**Audit branch:** `audit/overnight-integration-readiness-v1`  
**Audit worktree:** `/Users/chriscase/Documents/GitHub/contextdesk-overnight-integration-audit-v1`  
**Acceptance candidate:** `10435d114e7e1faa0ca6e5f8447d70d41ad91492` (`integrate/model-readiness-quality-v1`)  
**Acceptance tip subject:** `fix(agent): harden live multi-stage triage`  
**Main at audit time:** `eee1e6d2b089a2f1857824861446ad4215e17c8e` (ancestor of acceptance; **108 commits behind**)  
**Method:** read-only `git worktree list`, `merge-base`, `rev-list`, `diff`, `patch-id --stable`, `merge-tree`, plus direct reading of implementation and tests (not commit subjects alone).  
**Proof vs inference:** statements tagged **[proof]** cite SHA/path evidence; statements tagged **[inference]** are reasoned judgments.

Companion machine-readable ledger: [`overnight-integration-ledger-2026-08-10.json`](./overnight-integration-ledger-2026-08-10.json).

---

## 1. Executive verdict

**[proof]** The acceptance candidate `10435d11` already consolidates the majority of parallel “fix/feat” worktrees into a single coherent lineage ~108 commits ahead of `main`. Patch-id equivalence shows that **gateway contract fixtures**, **quality-eval harness**, **eval CLI**, **QE role-confusion fix**, **typed final manifest**, **turn credential cache**, **progress UX**, **multistage budget reserve**, and **Vercel basics refinement** are already present under different SHAs (or as direct ancestors) on the acceptance branch.

**[proof]** One high-value production defect remains **outside** the acceptance tip and is already fixed on a branch that **contains** acceptance:

| Item | Branch | Head | Severity |
|------|--------|------|----------|
| Production triage scorer masks promoted symptoms when a valid trigger coexists (`causal_candidates.len() == 1`) | `fix/triage-role-integrity-v1` | `7f4ebb985c0f…` | **Release-critical post-acceptance** (lab scorer was fixed; production scorer was not) |

**[proof]** At `10435d11`, `crates/cd-core/src/triage_quality.rs` still gates symptom-as-cause on `answer.causal_candidates.len() == 1`. At the same SHA, `crates/cd-core/src/quality_eval/answer_score.rs` (via `e69327f1`) already fails closed on symptom promotion without that multiplicity gate. The dual-scorer split is a real integration hazard, not a doc-only concern.

**[proof]** True net-new product surface not in acceptance:

1. **`fix/triage-role-integrity-v1`** — 2 commits on top of `10435d11` (fix + design note).
2. **`feature/forensic-trace-v1`** — 4 commits, 62 behind acceptance; large DiagnosticTraceV1 + desktop capture; **many `merge-tree` “changed in both”** paths vs acceptance.
3. **`feature/repository-health-metrics-v1`** — scripts/docs only, based on `main`; non-blocking for product acceptance.

**[inference]** First post-acceptance integration batch should be **only** triage role integrity (fast-forward or cherry-pick onto the accepted tip), then a carefully rebased forensic lane, then optional repo-health. Do **not** re-integrate patch-id-equivalent worktrees; treat them as historical worktree residue.

**Disk at audit start:** ~131 GiB free (above floors). Acceptance worktree and other lanes were not modified.

---

## 2. Complete worktree inventory

Generated from `git worktree list --porcelain` against base `10435d114e7e1faa0ca6e5f8447d70d41ad91492`. All listed worktrees were **clean** at audit time.

| Path | Branch | Head (12) | Ahead / behind vs acceptance | Clean | Classification |
|------|--------|-----------|------------------------------|-------|----------------|
| `…/ContextDesk` | `main` | `eee1e6d2b089` | 0 / 108 | yes | ancestor baseline |
| `…/contextdesk-model-readiness-quality-v1` | `integrate/model-readiness-quality-v1` | `10435d114e7e` | 0 / 0 | yes | **acceptance candidate** |
| `…/contextdesk-overnight-integration-audit-v1` | `audit/overnight-integration-readiness-v1` | `10435d114e7e` | 0 / 0 | yes | this audit (docs only) |
| `…/contextdesk-triage-role-integrity-v1` | `fix/triage-role-integrity-v1` | `7f4ebb985c0f` | **2 / 0** | yes | **integrate after acceptance** |
| `…/contextdesk-forensic-trace-v1` | `feature/forensic-trace-v1` | `ba428326387b` | **4 / 62** | yes | integrate after additional work (rebase) |
| `…/contextdesk-repository-health-metrics-v1` | `feature/repository-health-metrics-v1` | `701c01eaae2d` | **2 / 108** | yes | documentation/tooling; optional post-release |
| `…/contextdesk-audit-cred-file-refs-v1` | `audit/cred-file-refs-adversarial-v1` | `ddaef08be9d5` | 1 / 7* | yes | **superseded** (tree-identical to acceptance for touched files) |
| `…/contextdesk-eval-cli-v1` | `feat/eval-cli-v1` | `3fba441d56ce` | 1 / 17* | yes | **superseded** (patch-id ≡ `44a8db22`) |
| `…/contextdesk-gateway-contract-fixtures-v1` | `test/gateway-contract-fixtures-v1` | `1878f898b80c` | 2 / 24* | yes | **superseded** (patch-id ≡ `9a6a3aa3` + `5877e0c4`) |
| `…/contextdesk-progress-ux-parity-v1` | `fix/progress-ux-parity-v1` | `92ee61d7f224` | 1 / 38* | yes | **superseded** (patch-id ≡ `37905a37`) |
| `…/contextdesk-qe-role-confusion-v1` | `fix/qe-live-role-confusion-v1` | `42319b4466e0` | 1 / 6* | yes | **superseded** (patch-id ≡ `e69327f1`) |
| `…/contextdesk-quality-eval-harness-v1` | `feat/quality-eval-harness-v1` | `17b102ee55f0` | 3 / 26* | yes | **superseded** (content in `250260db` + follow-ons) |
| `…/contextdesk-turn-provider-credential-cache-v1` | `fix/turn-provider-credential-cache-v1` | `c7dbd60761b9` | 1 / 38* | yes | **superseded** (patch-id ≡ `2348de04`) |
| `…/contextdesk-typed-final-manifest-v1` | `fix/typed-final-manifest-v1` | `eac6880737b3` | 1 / 39* | yes | **superseded** (patch-id ≡ `15617c06`) |
| `…/contextdesk-multistage-budget-v1` | `fix/multistage-budget-reserve-v1` | `0deac2805b43` | 0 / 22 | yes | **superseded** (ancestor; later V2 at `10435d11`) |
| `…/contextdesk-vercel-basics-refinement-v1` | `fix/vercel-basics-refinement-v1` | `d17a120d06b7` | 0 / 24 | yes | **superseded** (ancestor) |
| `…/contextdesk-evidence-final-rc2` | `integrate/evidence-investigation-final-rc2` | `37905a3788f0` | 0 / 36 | yes | **superseded** (ancestor; includes progress UX tip) |

\* “Ahead” counts are unique SHAs not reachable from acceptance; many are patch-id equivalent to commits already on acceptance (see §3).

### 2.1 Per-lane capability notes (implementation-backed)

#### Acceptance — `integrate/model-readiness-quality-v1` @ `10435d11`

**[proof]** Capability already on tip includes:

- Gateway discovery + role readiness: `crates/cd-core/src/capability_qualification.rs`, `model_curation.rs`; CLI `cd-cli` models commands; fixtures `fixtures/gateway-contracts/v1/**`; tests `tests/gateway_contract_fixtures.rs`.
- Multi-stage budget V2 half-turn reserve: `multi_stage_budget.rs` (`MULTI_STAGE_BUDGET_POLICY_V2`); live hardening in `agent.rs` / `tool_host.rs` at `10435d11`.
- Typed final manifest + opaque evidence validation: `investigation_answer.rs` (`FinalAnswerManifestV1`, `validate_model_answer`, `UnknownEvidence` / `WrongScope`).
- Protected-file credentials: `keychain_store.rs` (`file:` refs, O_NOFOLLOW, permission checks); adversarial audit `1ef05b15`.
- Turn provider credential cache: `cd-workflow/src/provider.rs` `TurnProviderCredentialCache`.
- Quality-eval harness + CLI: `quality_eval/**`, `cd-cli` eval commands, fixtures `fixtures/quality-eval/open-v1/**`.
- Progress stream: commit `37905a37` in history; CLI progress admission tests `73143222`.
- QE role-confusion fail-closed: `e69327f1` in `quality_eval/answer_score.rs`.

#### `fix/triage-role-integrity-v1` @ `7f4ebb98` — **integrate after acceptance**

**[proof]** Commits:

1. `3c50f0f4` — `fix(triage): reject promoted symptoms even when a valid trigger coexists`  
   - Touches: `crates/cd-core/src/triage_quality.rs`, `docs/benchmarks/QUALITY_EVAL_HARNESS.md`
2. `7f4ebb98` — `docs(triage): independent-incident truth is insufficient for a safe rule`  
   - Adds: `docs/design/TRIAGE_INDEPENDENT_INCIDENT_TRUTH.md`

**[proof]** Behavioral change: remove `&& answer.causal_candidates.len() == 1` from `symptom_vs_cause`; fail when any causal candidate cites a host symptom token without role `symptom|unknown`. Hermetic tests added in-module (`valid_trigger_does_not_mask_symptom_promoted_to_trigger`, etc.).

**[inference]** Tests prove the rubric dimension under synthetic host facts; they do **not** prove live multi-stage emission of that shape (needs live or transport-oracle evidence). Still the strongest production scorer fix available.

#### `feature/forensic-trace-v1` @ `ba428326` — **integrate after additional work**

**[proof]** Unique commits (not in acceptance by SHA or patch-id):

- `2d0b8ec5` DiagnosticTraceV1 core + pipeline observer + CLI flags  
- `6ce4a5dc` desktop forensic capture host session, paged IPC, Activity panel  
- `b7b0c626` contract gates, CLI e2e, disk-guard regressions  
- `ba428326` synthetic secret fixtures from fragments at runtime  

**[proof]** ~6.1k LOC across 25 files; new module `crates/cd-core/src/diagnostic/{mod,bundle,writer}.rs` **absent** at acceptance.  
**[proof]** `git merge-tree` vs acceptance shows **many “changed in both”** files (`cli.rs`, `chat.rs`, `agent.rs`, workflow, desktop `lib.rs`, docs).  
**[inference]** Rebase onto accepted tip required; conflicts concentrated where acceptance already extended CLI progress/flags and agent multi-stage paths. Classification: valuable post-release observability, not a model-readiness acceptance blocker.

#### `feature/repository-health-metrics-v1` @ `701c01ea` — **documentation/tooling**

**[proof]** Files: `scripts/repository_health.py`, tests, `docs/development/REPOSITORY_HEALTH.md`, snapshot JSON, small README/DEV.md links. Based on `main` (`eee1e6d2`).  
**[proof]** `merge-tree` vs acceptance: “changed in both” (doc/README collision risk only).  
**[inference]** Safe optional batch after product merges; no runtime contract impact.

#### Superseded / absorbed lanes (do not re-integrate)

| Lane tip | Patch-id / content equivalence **[proof]** |
|----------|-----------------------------------------------|
| `feat/eval-cli-v1` `3fba441d` | ≡ `44a8db22` |
| `test/gateway-contract-fixtures-v1` `1878f898`+`9fe905f8` | ≡ `5877e0c4`+`9a6a3aa3` |
| `fix/progress-ux-parity-v1` `92ee61d7` | ≡ `37905a37` (acceptance is superset; +9 lines in `events.rs` only vs tip) |
| `fix/qe-live-role-confusion-v1` `42319b44` | ≡ `e69327f1` |
| `feat/quality-eval-harness-v1` | content via `250260db` / `ff7d808e` / `ae82daa3` |
| `fix/turn-provider-credential-cache-v1` `c7dbd607` | ≡ `2348de04` (zero tree diff vs integrate SHA for workflow paths) |
| `fix/typed-final-manifest-v1` `eac68807` | ≡ `15617c06` |
| `audit/cred-file-refs-adversarial-v1` `ddaef08b` | subject matches `1ef05b15`; **file trees for the 3 touched paths are identical to acceptance** (`git diff ddaef08b $BASE -- <paths>` empty) despite different patch-id (context-line drift in `cli.rs` commit) |
| `fix/multistage-budget-reserve-v1` `0deac280` | ancestor; superseded by V2 policy at `10435d11` |
| `fix/vercel-basics-refinement-v1` `d17a120d` | ancestor |
| `integrate/evidence-investigation-final-rc2` `37905a37` | ancestor |

---

## 3. Overlap / conflict matrix

| Lane A | Lane B | Relationship | Risk if both “re-integrated” |
|--------|--------|--------------|------------------------------|
| Most feat/fix worktrees | acceptance | patch-id or ancestor absorbed | duplicate commits, noisy history, false “new work” |
| `fix/qe-live-role-confusion-v1` | `fix/triage-role-integrity-v1` | **semantic sibling, different modules** | QE lab green while production scorer still soft; integrating only QE leaves prod hole **[proof]** |
| `fix/typed-final-manifest-v1` | agent multi-stage at `10435d11` | manifest already in tip; agent later hardened | re-applying eac68807 alone would miss later agent/tool_host changes |
| `fix/multistage-budget-reserve-v1` | `10435d11` budget V2 | V1→V2 policy rewrite | re-applying V1 would **regress** reserve math **[proof]** |
| `feature/forensic-trace-v1` | acceptance CLI/agent/workflow | heavy file overlap | high conflict; risk of dropping progress flags or budget hardening during naïve merge |
| `feature/repository-health-metrics-v1` | acceptance docs | README/DEV only | low; resolve doc links |
| `audit/cred-file-refs` | `1ef05b15` | content-identical | no product delta |

---

## 4. Integration dependency graph

```
main (eee1e6d2)
  └── … 108 commits …
        └── integrate/model-readiness-quality-v1 (10435d11)  ← ACCEPTANCE CANDIDATE
              │
              ├──[Batch 1 — fast]──► fix/triage-role-integrity-v1 (3c50f0f4 → 7f4ebb98)
              │                         depends on: acceptance triage_quality + QE harness docs
              │
              ├──[Batch 2 — rebase]──► feature/forensic-trace-v1 (rebase 4 commits onto Batch1 tip)
              │                         depends on: stable CLI flag surface, agent event hooks,
              │                         workflow turn entrypoints after acceptance hardening
              │
              └──[Batch 3 — optional]──► feature/repository-health-metrics-v1
                                            depends on: doc tree only; may land on main-first promote
```

**Exact proposed commit ordering (post-acceptance):**

1. Fast-forward or merge `3c50f0f4` then `7f4ebb98` onto the **accepted** tip (already based on `10435d11` — **[proof]** `behind=0`).  
2. Rebase forensic series onto (1); resolve CLI/`chat.rs`/`agent.rs` conflicts preferring acceptance multi-stage + progress behavior.  
3. Cherry-pick or rebase `9e2b9a8a` + `701c01ea` (repo health) onto resulting tip or onto `main` after promote — order flexible.

**Branches that should not be integrated:** all superseded rows in §2.1 table (eval-cli, gateway fixtures, progress-ux, qe-role-confusion, quality-eval-harness worktree tips, credential-cache, typed-final, multistage-budget V1 tip, vercel-basics tip, evidence-final-rc2 tip, cred-file-refs audit tip).

---

## 5. Release blockers vs post-acceptance work

### 5.1 Release-critical relative to claimed “model readiness / triage quality”

| Issue | Status on `10435d11` | Evidence | Action |
|-------|----------------------|----------|--------|
| Production `symptom_vs_cause` masks multi-candidate symptom promotion | **Open on acceptance** | `triage_quality.rs` still has `len() == 1`; fixed only on `3c50f0f4` | Integrate Batch 1 before claiming production rubric parity with QE lab |
| QE lab role confusion | Fixed | `e69327f1` / `answer_score.rs` | Already on acceptance |
| Opaque evidence / typed final fail-closed | Present | `investigation_answer.rs` + unit tests | Already on acceptance |
| Budget V2 half-turn reserve | Present | `multi_stage_budget.rs` + `10435d11` | Already on acceptance |
| Protected-file TOCTOU / Keychain avoidance | Present | `keychain_store.rs` + `1ef05b15` | Already on acceptance |
| Gateway hermetic fixtures | Present | `gateway_contract_fixtures.rs` | Already on acceptance |

### 5.2 Post-acceptance / post-release

- Forensic DiagnosticTraceV1 + desktop panel (large; conflict-heavy).  
- Repository health metrics script.  
- Live-only residual: Vercel/provider edge cases that fixtures cannot fully replay (see §11).  
- Mutation campaign hardening of critical contracts (Phase 2 of this assignment).

---

## 6. Contract traceability matrix

Legend: **RC** = release-critical for model-readiness acceptance story; **PR** = post-release.

### C1 — Gateway discovery → qualification → saved evidence → model selection

| Field | Content |
|-------|---------|
| Owning modules | `capability_qualification.rs`, `model_curation.rs`, CLI `commands/models.rs`, store path helpers |
| Current tests | In-module readiness/store/stale/catalog drift tests; `tests/gateway_contract_fixtures.rs` scripted transport |
| Missing negative tests | Concurrent store writers; corrupted partial JSON mid-write recovery beyond overwrite refuse; catalog change during in-flight qualification |
| False-positive risks | Scripted transport may not exercise real SSE framing edge cases; name-hint tests exist but UI may still over-trust labels |
| High-value mutation operators | Flip `mark_stale_if_mismatch`; drop endpoint fingerprint from key; treat `Limited` as `Verified`; ignore catalog removal staleness |
| Strongest branch | Already on acceptance (`b2cb84c2` lineage) |
| Status | **RC** for readiness claims; fixtures **RC** for offline |

### C2 — Gateway / profile / model / endpoint fingerprinting

| Field | Content |
|-------|---------|
| Owning modules | `QualificationKey`, `fingerprint_endpoint`, `fingerprint_model_catalog`, catalog storage ids |
| Current tests | `endpoint_or_model_change_changes_cache_key`, catalog drift, sibling isolation |
| Missing negatives | URL normalization tricks (`http://` vs trailing slash vs default port); unicode host spoofing |
| False-positive risks | Tests use simple base URLs |
| Mutation operators | Remove fingerprint components; case-fold model ids inconsistently |
| Strongest branch | acceptance |
| Status | **RC** |

### C3 — Protected-file secret resolution and Keychain avoidance

| Field | Content |
|-------|---------|
| Owning modules | `keychain_store.rs`, workflow `provider.rs` resolve paths, CLI config init |
| Current tests | permissions, symlink reject, relative/NUL/oversized, no Keychain fallback, concurrent readers, file-ref set/delete refuse |
| Missing negatives | Directory hard-link races; ACL-only platforms; TOCTOU after open (mitigated by O_NOFOLLOW+fstat — still worth mutation) |
| False-positive risks | Tests create temp files with known modes; production FS semantics differ on network volumes |
| Mutation operators | Drop `O_NOFOLLOW`; skip mode check; fall through to Keychain on file error; accept group-readable |
| Strongest branch | acceptance (`349c9999` + `1ef05b15`); audit worktree content-identical |
| Status | **RC** |

### C4 — Multi-stage retrieval → candidate analysis → final comparison → validation

| Field | Content |
|-------|---------|
| Owning modules | `agent.rs`, `tool_host.rs`, `multi_model/pipeline.rs`, `investigation_answer.rs`, `multi_stage_budget.rs` |
| Current tests | `multi_model_pipeline`, transport semantic oracle, investigation_answer unit tests, budget unit tests |
| Missing negatives | Mid-loop cancel after draft materialization; comparison with exactly-at-reserve edge; draft count boundary with poisoned draft |
| False-positive risks | Pipeline tests may stub time; live latency motivated V2 reserve but unit tests pin fixed numbers |
| Mutation operators | Admit when `remaining == reserve`; allow comparison with &lt;2 drafts; skip `validate_model_answer` on path; emit unvalidated prose |
| Strongest branch | acceptance tip `10435d11` (live multi-stage harden) |
| Status | **RC** |

### C5 — Opaque evidence-ID admission and fail-closed validation

| Field | Content |
|-------|---------|
| Owning modules | `investigation_answer.rs` (`validate_model_answer`, ledger, manifest), agent final prompt scaffolding |
| Current tests | unknown/wrong-scope/duplicate/empty evidence; manifest content-free; rendering isolation |
| Missing negatives | Evidence id with whitespace twin; candidate missing from proposal but present in ledger already checked (`candidate_ids != ledger_candidates`); cross-claim reuse of id within allowed candidate (allowed today — document intent) |
| False-positive risks | Fixtures use short ids `e-a`/`e-b`; production ids `e:{group}:{seq}` may hide parser issues |
| Mutation operators | Map unknown id → skip; drop WrongScope check; treat empty evidence as ok for non-missing kinds; auto-insert missing candidates |
| Strongest branch | acceptance (`15617c06` + later agent wiring) |
| Status | **RC** |

### C6 — Retry / correction behavior

| Field | Content |
|-------|---------|
| Owning modules | `agent.rs` final comparison correction text + re-prompt with same manifest |
| Current tests | oracle/pipeline paths for semantic correction categories (`142184a7` lineage) |
| Missing negatives | Infinite correction loop budget; correction that mutates host ledger (must be impossible) |
| Mutation operators | Allow second ledger; strip manifest on retry; count success without re-validate |
| Strongest branch | acceptance |
| Status | **RC** (behavioral), tests partially prove |

### C7 — Cancellation, deadlines, token budgets, reserved final-comparison budget

| Field | Content |
|-------|---------|
| Owning modules | `multi_stage_budget.rs`, `router::TurnDeadlinePlan`, agent admission loop, context budgeting |
| Current tests | reserve math, refuse at reserve, candidate cap protects reserve, cancel/deadline block |
| Missing negatives | `total_ms == 1` extreme; race between admit and deadline tick; interaction of char ceiling (`93a75a5e`) with time reserve |
| False-positive risks | Unit tests do not run real clocks; V2 half-turn chosen from live experience **[inference: policy comment cites live latency]** |
| Mutation operators | Use V1 quarter-floor formula; set `round_reserve=0`; invert `remaining <= reserve` comparison |
| Strongest branch | acceptance V2 (`10435d11`) |
| Status | **RC** |

### C8 — CLI / GUI progress and capability parity

| Field | Content |
|-------|---------|
| Owning modules | `activity.rs`, `events.rs`, `turn_trace.rs`, CLI render/envelope, desktop `TurnProgressTimeline`, `turn.ts` |
| Current tests | CLI progress line admission; desktop timeline tests on progress branch (merged) |
| Missing negatives | JSON/JSONL closed-stream contracts vs text follow; desktop missing event kinds CLI emits |
| Mutation operators | Drop event kinds; map stage incorrectly; ack gates bypass |
| Strongest branch | acceptance (superset of `37905a37`) |
| Status | **PR** for polish; core progress **RC** if product claims parity |

### C9 — Offline fixture replay vs live-provider behavior

| Field | Content |
|-------|---------|
| Owning modules | `fixtures/gateway-contracts/**`, quality-eval fixtures, scripted transports |
| Current tests | fail-closed embedding/rerank matrices; no-secrets fixture scan |
| Missing negatives | Live schema drift after fixture freeze; auth error shapes |
| False-positive risks | High if treated as live proof — fixtures are **replay**, not live |
| Mutation operators | Accept chat-shaped embedding; reorder-tolerant wrong rerank |
| Strongest branch | acceptance |
| Status | **RC** as offline gate; live remains residual |

### C10 — Ordinary chat vs triage requirements

| Field | Content |
|-------|---------|
| Owning modules | agent mode branching, triage contract system text, tool host linked-log validation |
| Current tests | multi-model pipeline; triage quality rubrics; doctor grounding (`8009e0dc`) |
| Missing negatives | Chat path accidentally requiring triage schema; triage without linked log |
| Mutation operators | Apply triage validator to chat; skip linked snapshot validate |
| Strongest branch | acceptance |
| Status | **RC** |

### C11 — Embedding and reranking role separation

| Field | Content |
|-------|---------|
| Owning modules | capability probes embed/rerank; retrieval lanes; Vercel envelope validators in gateway tests |
| Current tests | specialty-only probes; fail-closed matrices; Vercel v4 envelope tests in history |
| Missing negatives | Model advertised as both chat+embed without dual probe |
| Mutation operators | Run chat probes for embed role; accept non-finite embeddings |
| Strongest branch | acceptance + gateway fixtures |
| Status | **RC** for retrieval quality claims |

### C12 — Scorer role integrity and causal-candidate handling

| Field | Content |
|-------|---------|
| Owning modules | **`triage_quality.rs` (production)**, **`quality_eval/answer_score.rs` (lab)** — **two scorers** |
| Current tests | Lab: multi-candidate promotion fails (`e69327f1`). Prod on acceptance: **still `len()==1`**. Prod on `3c50f0f4`: fixed + tests |
| Missing negatives on acceptance | Exactly the tests added in `3c50f0f4` |
| False-positive risks | Lab green ≠ production green today **[proof]** |
| Mutation operators | Restore `len()==1`; treat any multi-candidate as pass; ignore role field |
| Strongest branch | **`fix/triage-role-integrity-v1`** for production scorer |
| Status | **RC** — Batch 1 |

---

## 7. Test-confidence assessment

| Area | Confidence | Rationale |
|------|------------|-----------|
| Opaque evidence validation | **High** | Dense unit tests; fail-closed categories stable |
| Capability qualification store/stale | **High** for hermetic; **Medium** for live gateways | Scripted transport + fixtures; live residual |
| Protected-file credentials | **High** hermetic | Adversarial cases present; no live Keychain in CI (correct) |
| Multi-stage budget math | **High** unit; **Medium** integration | V2 constants tested; live latency only partially reflected |
| Production triage role integrity | **Low on acceptance**; **High on triage branch** | Dual-scorer skew |
| Progress CLI/GUI parity | **Medium** | Tests exist; not full e2e desktop in default CI |
| Forensic capture | **Medium on its branch** | Dedicated tests; not on acceptance |
| Credential cache | **High** | Counting secret reads per turn; panic-on-access guards |

**False-positive patterns observed:**

1. Patch-id-different commits with **identical trees** (cred-file audit) — do not treat as new product work.  
2. Lab scorer fixed while production scorer lagging — suite green can hide prod hole.  
3. Ancestor worktrees still checked out — inventory noise if only subjects are read.

---

## 8. Mutation-testing priorities (input to Phase 2)

Select **3–6** highest-risk files on SHA `10435d11` (not whole workspace):

| Priority | File | Package | Why |
|----------|------|---------|-----|
| 1 | `crates/cd-core/src/investigation_answer.rs` | `cd-core` | Opaque IDs, WrongScope, root role — trust boundary |
| 2 | `crates/cd-core/src/multi_stage_budget.rs` | `cd-core` | Final-comparison reserve; easy comparison flips |
| 3 | `crates/cd-core/src/triage_quality.rs` | `cd-core` | Known production bug surface; scorer integrity |
| 4 | `crates/cd-core/src/capability_qualification.rs` | `cd-core` | Readiness/evidence matching; large but critical paths |
| 5 | `crates/cd-core/src/keychain_store.rs` | `cd-core` | Protected-file fail-closed |
| 6 | `crates/cd-core/src/quality_eval/answer_score.rs` | `cd-core` | Lab role integrity (already hardened — validate tests kill mutants) |

**Out of scope for Phase 2:** desktop GUI e2e, live providers, full workspace CI, forensic module (absent on base).

---

## 9. Recommended integration batches (summary)

### Batch A — immediate post-acceptance (order fixed)

1. `3c50f0f4` fix(triage): reject promoted symptoms…  
2. `7f4ebb98` docs(triage): independent-incident truth…

**Gate:** `cargo test -p cd-core triage_quality` (or full `cd-core` unit) + confirm `len() == 1` gone.

### Batch B — observability (after A; rebase required)

Forensic series `2d0b8ec5` → `6ce4a5dc` → `b7b0c626` → `ba428326` rebased onto A.  
**Gate:** diagnostic tests + CLI help/flags + no secret capture (existing tests).

### Batch C — repo hygiene (optional)

`9e2b9a8a` + `701c01ea` repository health.

### Do-not-touch during promote

- Acceptance worktree path / branch while independent acceptance runs.  
- Protected RC build cache at `…/contextdesk-evidence-final-rc2/target`.  
- Superseded worktrees (leave as historical; do not merge).

---

## 10. Durable issue backlog

| ID | Severity | Title | Evidence | Affected files | Acceptance criteria | Recommended lane |
|----|----------|-------|----------|----------------|---------------------|------------------|
| INT-001 | **P0** | Production triage scorer masks promoted symptom when valid trigger coexists | `10435d11:triage_quality.rs` still has `len()==1`; fixed in `3c50f0f4` | `triage_quality.rs`, QUALITY_EVAL_HARNESS.md | Hermetic tests from `3c50f0f4` pass on integrate tip; no `len()==1` gate | `fix/triage-role-integrity-v1` |
| INT-002 | P1 | Dual scorer drift (lab vs production) can re-diverge | QE `answer_score` vs `triage_quality` parallel dimensions | both scorers | Shared invariant doc + regression pair in both scorers for promotion shapes | new chore on post-accept tip |
| INT-003 | P2 | Forensic capture not on acceptance | `diagnostic/mod.rs` absent at `10435d11` | diagnostic/*, desktop, CLI | Rebased green tests; capability ACL review for Tauri IPC | `feature/forensic-trace-v1` |
| INT-004 | P3 | Repo health metrics off main only | branch based on `eee1e6d2` | scripts/*, docs | Script tests pass; docs linked from DEV.md | `feature/repository-health-metrics-v1` |
| INT-005 | P2 | Budget V2 vs context char ceiling interaction under-specified | history `93a75a5e` + V2 reserve | `multi_stage_budget.rs`, context budgeting | Hermetic test where both bind | post-accept test lane |
| INT-006 | P2 | Mutation gap on investigation_answer WrongScope / UnknownEvidence | test list lacks several mutants | `investigation_answer.rs` | Phase 2 mutation score + new tests | `test/critical-contract-mutations-v1` |
| INT-007 | P3 | Worktree residue confuses future agents | 10+ superseded clean worktrees | n/a | Inventory doc (this file); optional worktree prune by human | process |
| INT-008 | P2 | Live gateway drift after fixture freeze | fixtures dated from live evidence commits | `fixtures/gateway-contracts/**` | Periodic live refresh protocol (manual) | docs only until live window |
| INT-009 | P1 | Independent-incident rule incomplete for “safe” automation | `7f4ebb98` design note | design doc + scorers | Explicit product decision before auto-fail independent-incident shapes | follow design note; do not invent rule |
| INT-010 | P3 | Progress event surface still slightly diverges tip vs later commits | `events.rs` +9 lines on acceptance vs progress tip | `events.rs` | Desktop admits all CLI progress kinds | already mostly done; verify in Batch A regression |

---

## 11. Unresolved questions requiring live evidence

These **cannot** be closed hermetically:

1. Whether V2 half-turn reserve is sufficient for the slowest **compatibility-qualified** model under real gateway latency (policy comment cites need &gt;30s under 120s ceiling — **[proof: comment in multi_stage_budget.rs at 10435d11]**; measurement needs live).  
2. Whether protected-file credentials on corporate FS (ACLs, non-UNIX ownership) fail closed without Keychain fallback.  
3. Whether live Vercel catalog/role hints still match `fixtures/providers/model-role-hints.v1.json`.  
4. Whether multi-stage live triage still emits dual causal candidates that would have been masked by INT-001 (motivates Batch 1 + live spot check).  
5. Credential cache effectiveness under real multi-profile reviewer turns (counts proven hermetically; latency benefit is live).

**Not unresolved (closed by this audit):** whether to re-merge superseded worktrees — **no**.

---

## 12. Strongest implementation branch by theme

| Theme | Strongest tip | Notes |
|-------|---------------|-------|
| Model readiness / qualification | acceptance `10435d11` | includes discovery + fixtures |
| Typed final / opaque evidence | acceptance (via `15617c06`) | do not use old worktree tip alone |
| Budget reserve | acceptance V2 | not V1 worktree |
| Protected credentials | acceptance | tree ≡ audit tip |
| Credential cache | acceptance | ≡ `2348de04` |
| QE lab role integrity | acceptance (`e69327f1`) | |
| **Production triage role integrity** | **`7f4ebb98`** | only branch with fix |
| Progress UX | acceptance | ≡/superset of progress tip |
| Forensic tracing | `ba428326` | not in acceptance |
| Repo health | `701c01ea` | docs/scripts |

---

## 13. Audit process notes

- Acceptance candidate and all pre-existing worktrees were **not** modified, rebased, or cleaned.  
- No live providers, Keychain, or network-dependent qualification runs.  
- GitHub metadata not required for conclusions above.  
- Phase 2 proceeds only if free disk remains **&gt; 100 GiB** after Phase 1 commit, per assignment.

---

## 14. Handbook impact

Handbook impact: **none for this docs-only audit commit** — no product pipeline change. When Batch 1 lands, triage `docs/design/PROVEN_METHODS.md` / triage chapter only if scorer trust boundary text needs update; `3c50f0f4` already claimed “Handbook impact: none — production rubric hardening only.”
