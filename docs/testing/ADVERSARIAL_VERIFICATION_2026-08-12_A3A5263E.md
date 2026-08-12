# Provider-free adversarial verification — code SHA a3a5263e

Run identity:

- repository: `chriscase/ContextDesk`
- audited code SHA: `a3a5263e408c8c1cd3030f470be690e334f1adad`
  (`fix(triage): honor cancellation during role qualification`)
- verification branch: `claude/contextdesk-adversarial-verify-m82zyb`
- method: detached worktree pinned at the exact SHA. Hermetic
  scripted/counting/hanging backends and a loopback `cd-test-gateway` only.
  No live gateway, credential store, Keychain, or private corpus was read.
  No release worktree was modified. No PR was opened.
- This report makes no live-provider compatibility or release-readiness
  claim; it verifies host-side invariants at the pinned source only.

> **Status (2026-08-12, post-run): historical baseline.** After this
> verification ran, integration moved past `a3a5263e` (typed
> contribution-runtime fail-closed resolution, host phase-cap handling,
> and CLI runtime-preflight rejection landed on
> `integrate/triage-policy-sdk-v2` and its successors). This report is
> the pinned evidence for `a3a5263e` plus this branch's Ollama transport
> fix only; it is **not** the acceptance verdict for the current
> integration, which requires its own audit at the exact integration SHA.

## What was verified and held

1. **Pre-cancelled probes never reach the backend, for every role.** All
   seven V2 slot kinds (five contributors, Reviewer, Finalizer) return
   `Unqualified` / `cancelled` / `physical_provider_calls = 0` with zero
   dispatches observed by a counting backend
   (`pre_cancelled_probe_never_calls_backend_for_any_role`).
2. **A cancellation observed while the finalizer probe waits fails closed
   with zero call credit** and can never mint `Qualified`
   (`cancel_observed_while_finalizer_waits_fails_closed_with_zero_credit`).
3. **Deadline expiry classifies as `deadline`** with a truthful one-call
   credit on the finalizer path; a contributor deadline also fails closed
   (`finalizer_deadline_expiry_classifies_as_deadline`,
   `contributor_deadline_expiry_fails_closed`).
4. **Invalid requests fail closed before any backend use**: zero and
   over-maximum (`> MAX_TRIAGE_DEADLINE_MS_V2`) deadlines and blank
   profile/base-url/model identities
   (`invalid_deadlines_and_identities_fail_closed_before_any_backend_use`).
5. **Role semantics are exact.** A TimelineAnalyst probe rejects a
   wrong-role contribution; a Reviewer probe keeps contribution semantics
   and rejects a finalizer-shaped answer; a Finalizer probe rejects
   contribution-shaped answers, foreign evidence ids, and stale packet ids.
6. **Malformed, refused, empty, and provider-error responses fail closed**
   with truthful call credit (`refusal_prose_fails_closed_*`,
   `empty_completion_fails_closed`,
   `provider_failure_classifies_as_provider_failed_with_one_call`).
7. **Shared production seams.** Role qualification
   (`qualify_configured_role_v2`) and the V2 triage host
   (`resolve_v2_host`) build backends through the same
   `resolve_provider_profile` →
   `resolve_turn_inputs_from_profile_with_credential_cache` →
   `backend_for_resolved_turn` sequence. No second chat-capable HTTP
   implementation is reachable from production chat; the desktop host
   delegates (existing architecture test).
8. **The explicit 600 s chat deadline reaches the OpenAI-compatible
   transport** end to end (`--deadline` → `deadline_controls` bounds check
   → explicit router budget → `TurnDeadlinePlan` → `provider_request_timeout`
   → pinned reqwest client), with out-of-range values rejected rather than
   clamped (existing `deadline_controls` and wire-latency tests).
9. **Gateway diagnostic answer integrity.** Malformed provider output
   cannot become a grounded pass: grounding requires a host-emitted
   citation bound to the run's disposable corpus plus a finished tool
   phase; typed-contract failures and empty projections classify as
   failures/inconclusive, never pass. The persisted share-safe bundle
   carries pseudonyms, endpoint fingerprints, and category-only failure
   summaries; raw bodies are discarded by `failure_summary`. The absolute
   artifact path on local stdout is documented, deliberate behavior
   (`docs/CLI.md`), not a leak of the persisted artifact.
10. **Retrieval diagnostics** create no temporary corpus/session state and
    make no provider/credential work when pre-cancelled (existing suite).

## Defects found

### P1 — fixed on this branch

- **Hidden 120 s transport cap on the Ollama dialect.**
  `backend_for_with_timeout_and_effort` dropped the caller's
  `request_timeout` for `ProviderKind::Ollama`: `OllamaClient::new`
  hardcoded a 120 s reqwest ceiling, so neither an explicit
  `--deadline 600s` nor the router's own 300 s patient local plan ever
  reached Ollama transport — requests died at 120 s while the turn clock
  waited. This contradicted the factory's documented contract ("the
  transport ceiling follows the host-owned turn budget") and hit exactly
  the provider class `provider_prefers_patient_deadlines` singles out as
  needing more time. Fixed by adding `OllamaClient::new_with_timeout`
  (zero rejected, mirroring the OpenAI/Anthropic constructors) and
  threading the resolved timeout through the Ollama arm. Focused proof:
  `cargo test -p cd-core --test ollama_transport_deadline`. The
  fix-reverted mutation fails the new wire test (see mutation table).

### P2 — demonstrated and documented, intentionally not fixed here

Production changes were restricted to demonstrated P0/P1 defects; these
carry committed, `#[ignore]`-marked reproductions
(`cargo test -p cd-workflow --test
triage_role_qualification_adversarial_verify -- --ignored`).

- **Cancel-during-call race can mint `Qualified`.** A cancellation raised
  while the provider round is in flight loses the completion race when a
  valid response lands within the 10 ms cancel-poll window; the probe then
  validates and records `Qualified` / `role_probe_passed` / 1 call —
  contradicting the module's own "a cancelled probe must never mint
  qualification" comment. Applies to both the finalizer path
  (`complete_once` also passes `None` as the backend cancel signal) and
  the contributor pipeline (no post-success cancel re-check). The pinned
  cancellation doc only promises *observed* cancellations fail closed, so
  this is a gap between the release invariant as stated and as shipped.
- **Contributor cancellation bookkeeping diverges from the finalizer.**
  A cancellation observed mid-wait on a contributor probe persists
  `role_probe_response_rejected` with `physical_provider_calls = 1`,
  while the finalizer path persists `cancelled` with zero credit for the
  same event. The stored reason misstates what happened (no response was
  rejected) and the zero-credit rule holds only for the finalizer.
- **The cancellation seam is unreachable from production hosts.** Both
  hosts pass `cancel: None` into `qualify_configured_role_v2`
  (`crates/cd-cli/src/commands/triage_policy.rs:328`,
  `desktop/src-tauri/src/lib.rs`), so the hardening this SHA adds is
  exercisable only by tests/SDK callers. "Cancellation-hardened" is true
  at the seam, unwired at every host surface.
- **Qualify output misreports egress for TimelineAnalyst/Reviewer.** The
  CLI/Tauri qualify commands emit `network: false` and
  `credentials_read: false` for those roles, but at this SHA both roles
  make one real provider call (the module's own test asserts
  `physical_provider_calls == 1`). Stale `needs_provider` predicate from
  the era when those roles were refused locally; the same JSON
  self-contradicts via `physical_provider_calls: 1`.
- **Per-turn `--deadline` never reaches optional-role transports.**
  Reviewer, contribution, and fast-triage backends are built from the
  saved `cfg.router` (180 s/300 s adaptive) rather than the host budget
  the CLI just overrode, contradicting `backend_for_resolved_turn`'s own
  doc that those roles "must not expire earlier than an explicit
  user-authored deadline". Roles degrade closed when transport expires
  early. The pinned acceptance turn excludes these roles.
- **`gateway diagnose` orphans a synthetic corpus on mid-seed failure.**
  `seed_marker_corpus` / `seed_triage_corpus` create the corpus on disk
  first and register it for cleanup only after seeding fully succeeds;
  a failure in `push_events` / `upsert_templates` /
  `write_ingest_summary` / `flush` leaks the directory and misreports
  "could not create synthetic corpus". Success, post-seed failure,
  per-case timeout, overall deadline, and Ctrl-C terminals all clean up
  correctly (verified in source and by the end-to-end CLI test).

### P3 — notes

- The V2 production runner classifies a backend-observed mid-stream
  cancellation as `provider_failed` (no post-error cancel re-check,
  unlike the contribution pipeline's `Cancelled` mapping).
- Streaming requests never set `stream_options.include_usage`, so
  token/cost transport telemetry is absent on the streaming path — and V2
  triage always streams. Role/outcome (host-side) and requested/effective
  effort labels are preserved on both paths; dialect identity is carried
  as the protocol fingerprint by design. Ollama/Anthropic clients emit no
  transport telemetry on any path (pre-existing).
- The role-probe deadline bound (`MAX_TRIAGE_DEADLINE_MS_V2` = 3 600 000)
  intentionally exceeds chat's sanitized 600 000 maximum and is applied
  after `TurnDeadlinePlan` is computed, leaving the plan's phase fields
  internally inconsistent (inert today: only `total_ms` feeds transport).
- `triage run` does not consume the global `--deadline` flag (policy
  budget, else explicit config, else 300 s).
- Discovery preflight (`ai_probe`) uses a second, deliberately unpinned
  reqwest client for GET-only catalog probes that carries the bearer
  credential; documented in its header, but it is an SSRF-pinning
  divergence from every other credentialed path.
- `gateway diagnose` cleanup is a call, not an RAII guard: a panic or
  SIGTERM between seeding and cleanup leaks synthetic state, and the
  headline cleanup test simulates cleanup with a local helper rather than
  exercising the production `cleanup_all`.
- Production embedding (60 s/30 s) and rerank (8 s) adapters keep fixed
  transport budgets regardless of the turn deadline.

## Mutation verification

Each guard was inverted in place, the focused suite was run to prove it
fails, and the source was restored (verified green afterwards).

| # | Mutated guard | Killed by |
| --- | --- | --- |
| M1 | pre-cancel guard inverted (`triage_role_qualification.rs`) | focused lib suite |
| M2 | cancelled-probe call credit forced to 1 | adversarial `cancel_observed_while_finalizer` |
| M3 | zero-deadline validation dropped | adversarial `invalid_deadlines` |
| M4 | finalizer Qualified/Unqualified verdict swapped | focused lib suite |
| M5 | contributor Completed check inverted | focused lib suite |
| M6 | finalizer deadline reason mislabeled `provider_failed` | adversarial `finalizer_deadline_expiry` |
| M7 | pipeline pre-dispatch cancel guard inverted (`contribution_pipeline.rs`) | cd-core pipeline suite |
| M8 | contribution role binding disabled (`contributions.rs`) | adversarial `timeline_analyst_rejects` |
| M9 | Ollama timeout threading reverted (`research.rs`) | `ollama_transport_deadline` wire test |
| M10 | `redact_text` turned into identity (`redact.rs`) | cd-core redact suite |
| M11 | turn-clock pre-cancel guard inverted (`agent.rs`) | cd-core cancellation suite |

Result: 11/11 mutations killed; the source was restored and re-verified
green after every mutation.

Two coverage observations from M11. First, the focused role-qualification
suites alone did not kill the turn-clock pre-cancel inversion — every
non-ignored qualification test reaching that guard uses `cancel: None` or
is short-circuited by the module's earlier pre-cancel check, so the
guard's polarity is pinned only by cd-core's own cancellation tests.
Second, the kill there is soft: 48 of the 49 filtered cancellation tests
still passed under the inversion, and the one detector
(`broad_host_brief_mid_build_cancel_interrupts_and_joins_worker`) fails
by livelocking rather than by assertion — in CI this mutation dies by
suite timeout, not by a crisp polarity check. A small direct test of
`within_turn_deadline_with_cap` with a live-but-unset flag would close
both gaps.

## Commands

```bash
cargo test -p cd-workflow --lib triage_role_qualification
cargo test -p cd-workflow --test triage_role_qualification_adversarial_verify
cargo test -p cd-workflow --test triage_role_qualification_adversarial_verify -- --ignored  # P2 reproductions
cargo test -p cd-core --test ollama_transport_deadline
cargo fmt --all --check
cargo clippy -p cd-core -p cd-workflow -p cd-cli --all-targets -- -D warnings
```

## Test evidence (staged scoped sweep)

`cargo fmt --all --check` and the clippy invocation above ran clean
before the sweep. Two full-workspace `cargo test --workspace` attempts
were interrupted by environment failures (disk exhaustion, then a
container restart), so the recorded evidence is a staged scoped run in
the pinned worktree covering every crate the audit touched or depends
on; the cd-core stage was resumed after the restart and completed
cleanly. All stages exited 0 with zero failures:

| Stage | Result |
| --- | --- |
| `cd-test-gateway` (loopback fixture crate) | 11 passed |
| `cd-workflow --lib` | 143 passed |
| `cd-workflow` integration, 13 suites (adversarial-verify, gateway diagnostic contract/wire, retrieval diagnostic, triage policy v2 + production adapter, transport oracle, reasoning-effort, provider-failure projection, architecture, fast/multi-model resolve) | 122 passed, 3 ignored (committed P2 reproductions) |
| `cd-core --lib` | 2173 passed, 5 ignored (pre-existing) |
| `cd-core` wire, 4 suites (`ollama_transport_deadline`, `gateway_wire_latency_cancellation`, `transport_semantic_attempt_oracle`, `openai_compatible_provider_matrix`) | 77 passed |

Total: 2526 passed, 0 failed, 8 ignored.

## Acceptance impact

The P1 Ollama transport cap violated the audited property "no hidden
120-second transport cap remains on production paths" and is fixed on this
branch with focused wire proof. With that fix in place, no remaining
finding blocks acceptance of the pinned release scenario (explicit 600 s
chat deadline against an OpenAI-compatible gateway, reviewer/second-model
modes excluded): the P2 items are bounded bookkeeping/hygiene defects on
paths outside that scenario or unreachable from production surfaces, and
they are documented above with committed reproductions. The P2 list should
be triaged before any claim that broadens beyond the pinned scenario
(local-provider patience beyond one turn role, reviewer/fast-triage roles
under explicit deadlines, or operator-facing egress reporting of
TimelineAnalyst/Reviewer qualification).
