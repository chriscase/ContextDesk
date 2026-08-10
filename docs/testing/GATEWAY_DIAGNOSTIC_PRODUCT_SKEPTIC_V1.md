# Gateway diagnostic product-skeptic audit v1

**Branch:** `test/gateway-diagnostic-product-skeptic-v1`  
**Base:** `60107c5e1b784e785216862bf26a846023532acd`  
**Suite tip (tests):** `e2450564c8d3e7873760eac917d5cac17c14f9a4`  
**Branch tip:** docs-only stamps after suite tip — run `git rev-parse HEAD` on this branch; suite tip above is authoritative for hermetic tests  
**Kind:** adversarial hermetic audit of the **shipped** `contextdesk gateway diagnose` orchestrator  
**Scope:** tests + docs; no production behavior change unless a hermetic test proved a provider-neutral defect (none required in this lane)

## Purpose

Prove the product diagnostic suite meets its contracts under adversarial
hermetic scrutiny: exact profile/model binding, reuse of production
qualification/chat/cleanup/redaction seams, honest deadline/failure
classification, protected-file credentials without Keychain, share-safe
artifact boundaries, and checksum integrity — all without live providers.

## Inventory at base

| Seam | Location |
| --- | --- |
| Orchestrator | `crates/cd-cli/src/commands/gateway.rs` |
| Binary hermetic suite | `crates/cd-cli/tests/gateway_diagnose.rs` |
| CLI wiring | `GatewayAction::Diagnose` / `GatewayDiagnoseArgs` |
| Prior contract audit (workflow reuse) | `docs/testing/GATEWAY_DIAGNOSTIC_CONTRACT_AUDIT_V1.md` |

Existing binary coverage at base (8 tests): consent gate, raw ack, JSONL
plan/terminal, cleanup+checksum, raw owner-only, stall wall-clock bound,
preexisting corpus safety, exact profile/model binding.

## Gaps closed this lane

| AC2 contract class | New / strengthened proof |
| --- | --- |
| Profile/model binding (both lanes) | Existing + mutation inversion |
| Production path reuse (no parallel client) | Unit: structural source guard (`run_qualification`, `run_chat_workflow`, `LogCorpus::discard`, …; forbids local `reqwest`/`OpenAiCompatibleClient` construction in production code) |
| Unsupported / not-run ≠ pass | Embedding-role plan gating; investigator name-hint cannot force Compatible; classify/NotRun unit tests |
| Deadline / stall honesty | `deadline_exceeded=true`, `cancelled=false`, no Compatible for non-executed product lanes |
| Cleanup on failure + timeout | Hard 500 terminal + stall terminal balance corpora/sessions |
| Protected-file credentials | Wire Authorization carries secret; share-safe forbids secret; unit: SecretStore read exactly once for direct-lane resolve; Ollama zero reads |
| Share-safe / JSONL / `--no-color` / raw | Identity + endpoint + path + Authorization leakage tests; JSONL artifact classes; `--no-color` no ANSI; existing raw 0600/0700 |
| Checksum / manifest | Existing + redaction path re-check; mutation inversion |
| Fail-closed before provider contact | Missing `--profile` → 0 requests |

## Commands

```bash
cargo test -p cd-cli --test gateway_diagnose -- --nocapture
cargo test -p cd-cli --bin contextdesk gateway::tests -- --nocapture
cargo test -p cd-cli
cargo test -p cd-workflow
cargo fmt --all -- --check
cargo clippy -p cd-cli -p cd-workflow --all-targets -- -D warnings
git diff --check
```

## Counts (green)

| Suite | Result |
| --- | --- |
| `gateway_diagnose` binary hermetic | **17** passed |
| `commands::gateway::tests` unit | **25** passed |
| `cargo test -p cd-cli` | all green (exit 0) |
| `cargo test -p cd-workflow` | all green (exit 0) |
| fmt / clippy (`cd-cli`, `cd-workflow`) | pass |
| `git diff --check` | pass |

## Mutation inversions (invert → fail → restore → green)

| Failure mode | Inversion | Outcome |
| --- | --- | --- |
| Wrong model ID | expect wire model = decoy | fail → restore green |
| Deadline misclassification | expect `deadline_exceeded=false` | fail → restore green |
| Failure marked compatible | expect `gateway_model_compatible=true` | fail → restore green |
| Leaked secret in share-safe | assert report contains secret | fail → restore green |
| Broken checksum accepted | expect sha = `deadbeef` | fail → restore green |
| Missing production symbol | require `run_chat_workflow_COMPETING_PARALLEL` | fail → restore green |

## Production fixes

**None.** Hermetic tests did not prove a provider-neutral production defect
that required a behavior change. Residual product risks below are documented
blockers/follow-ups, not silent weakenings.

## Residuals / risks

1. **NotRun does not flip compatibility verdicts.** After a pure stall that
   skips every case as `not_run`, `verdicts.gateway_model_compatible` remains
   `true` because no `GatewayOrModelLikely` classification was recorded. The
   report still sets `deadline_exceeded=true` and lists cases as `not_run`.
   Operators must read both fields; a future product change could treat
   “zero cases measured” as inconclusive rather than compatible.
2. **Product-lane credential reads** still go through
   `run_chat_workflow`’s own cache (documented “at most twice” for a full
   run). Binary tests assert wire Authorization presence and zero secret
   emission; they do not instrument the host `CliSecretStore` read counter
   end-to-end.
3. **Ctrl-C cancel terminal** is exercised by control-flow (cleanup always
   after the case loop) and unit cleanup balancing, not by a flaky
   process-level SIGINT hermetic in this lane.
4. **Embedding specialty product path** may report `not_run` when no
   production OpenAI-compatible embedding backend is wired outside
   qualification — honest residual already noted in the orchestrator case
   text; not green-washed as Compatible.
5. **No live gateway / Keychain / desktop UI** exercised (by design).
6. **Release readiness is not claimed.**

## Non-goals confirmed

- No PR opened; release branch untouched.
- No live provider calls, real Keychain, or private corpus fixtures.
- No desktop / Tauri host changes.
- No weakening of pre-existing hermetic tests.
- No redesign of the diagnostic product surface beyond audit coverage.

## Changed files

- `crates/cd-cli/src/commands/gateway.rs` — unit tests only (classify/verdict/
  credential/production-path structural guards)
- `crates/cd-cli/tests/gateway_diagnose.rs` — expanded binary hermetic suite
- `docs/testing/GATEWAY_DIAGNOSTIC_PRODUCT_SKEPTIC_V1.md` — this record
