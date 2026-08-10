# Gateway diagnostic contract audit v1

**Branch:** `test/gateway-diagnostic-contract-audit-v1`
**Base:** `2339c38aeee31dcf5869c3d81bd373bf6974a30c`
**Tip:** `6efb55e16f46487f2666df1748c90279da812ff7` (audit suite commit containing tests; branch tip may be a docs-only stamp)
**Kind:** test/docs only — no production behavior change; no competing
gateway-diagnostic command.

## Purpose

Prove a future provider-neutral gateway diagnostic can safely **reuse**
ContextDesk production plumbing (discovery, `backend_for`, qualification,
credential cache, activity/trace, redaction, session/corpus cleanup, linked-log
bind/unbind) without introducing a second HTTP client, parallel agent loop, or
Keychain-only path.

## Read-only inventory of `feat/gateway-diagnostic-suite-v1`

At audit time this branch **did not exist** on `origin`. No integration into
that suite was performed. Interfaces were not modified.

## Hermetic suite

`crates/cd-workflow/tests/gateway_diagnostic_contract_audit.rs`

| Contract | Test(s) |
| --- | --- |
| Exact discovery IDs + selected-model wire binding | `discovery_returns_exact_catalog_ids_and_selected_model_is_bound_on_the_wire` |
| Qualification key model + endpoint fingerprint | `qualification_key_binds_exact_model_and_fingerprints_endpoint_not_raw_url` |
| Generation / tools / continuation / structured | `qualification_suite_covers_generation_tools_continuation_and_structured_on_live_transport` |
| **Linked-log triage plumbing** (bind → `run_turn` → unbind → discard) | `linked_log_bind_search_and_unbind_reuse_production_turn_seams` |
| Gated / unsupported ≠ Pass | `gated_or_untested_capabilities_are_never_reported_as_pass`, `investigator_name_hint_cannot_force_a_pass_without_measured_contract` |
| Surface-neutral activity + telemetry DTO | `activity_and_provider_telemetry_are_surface_neutral_for_human_jsonl_and_no_color` |
| Protected-file credential, one read/turn | `protected_file_credential_resolves_once_per_turn_without_keychain` |
| Credential on wire, never in trace bodies | `resolved_credential_reaches_wire_header_but_never_trace_bodies` |
| **Production** path/body redaction (`opaque_absolute_paths`, `DeveloperPayload`) | `production_developer_payload_opaques_paths_and_scrubs_secrets_in_provider_bodies` |
| **Duration deadline → `TracedOutcome::TimedOut`** | `outer_deadline_race_records_traced_outcome_timed_out` |
| Cancel race retains non-completed attempt | `outer_cancel_race_records_traced_outcome_cancelled` |
| **`LogCorpus::discard` + `SessionStore::delete` per terminal** | `temporary_corpus_and_session_cleanup_uses_production_primitives_for_each_terminal` |
| Reuse `backend_for` / credential cache / qualification | `production_plumbing_entrypoints_exist_for_diagnostic_reuse` |

All traffic uses `cd_test_gateway::MockGateway`. Secrets are synthetic mode-600
files via `file_secret_ref` / `ReferencedSecretStore`.

## Commands

```bash
git rev-parse HEAD
cargo test -p cd-workflow --test gateway_diagnostic_contract_audit -- --nocapture
cargo fmt --all -- --check
cargo clippy -p cd-workflow -p cd-core --all-targets -- -D warnings
cargo test -p cd-workflow --test gateway_wire_credentials -- --nocapture
cargo test -p cd-workflow --test gateway_wire_qualification -- --nocapture
```

## Counts (green)

| Suite | Result |
| --- | --- |
| `gateway_diagnostic_contract_audit` | **15** passed |
| Related `gateway_wire_credentials` | **9** passed |
| Related `gateway_wire_qualification` | **2** passed |
| fmt / clippy (`cd-core`, `cd-workflow`) | pass |

## Mutation inversions (each fails, then restore green)

| Failure mode | Inversion | Outcome |
| --- | --- | --- |
| Wrong model ID | expect wire model = other catalog id | fails → restore green |
| Duplicated credential resolution | expect `read_count() == 2` | fails → restore green |
| Leaked secret in trace | assert serialized contains secret | fails → restore green |
| Skipped discard | invert `!corpus_root.exists()` after discard | fails → restore green |
| Unsupported marked green | require all Pass from empty transport | fails → restore green |
| Deadline bypass | expect `TracedOutcome::Completed` instead of `TimedOut` | fails → restore green |
| Second HTTP client | require non-existent `backend_for_COMPETING` | fails → restore green |

## Honest gaps / residuals

- CLI binary human / `--no-color` / JSONL rendering is proven at the shared DTO
  layer (`ProviderTurnTelemetry` + `ActivityRecorder`), not by spawning three
  full CLI processes per scenario.
- Full multi-stage broad-triage candidate ranking inside `agent.rs` is private
  (`run_multi_stage_broad_triage`); this audit drives the **public** linked-log
  path (`bind_linked_corpus` + `run_turn` with synthetic ingested corpus +
  MockGateway tool/answer script) that a diagnostic would call.
- Full workspace CI matrix not re-run; focused audit + related labs only.
- No live provider, real Keychain, or private corpus fixtures.

## Non-goals confirmed

- No production module behavior changes (only `cd-workflow` **dev-dependency**
  tokio `test-util` for paused-clock deadline races in tests).
- No new user-facing gateway-diagnostic command.
- No merge/rebase of unrelated feature branches.
