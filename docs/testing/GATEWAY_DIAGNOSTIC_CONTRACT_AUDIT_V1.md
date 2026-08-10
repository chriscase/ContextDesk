# Gateway diagnostic contract audit v1

**Branch:** `test/gateway-diagnostic-contract-audit-v1`  
**Base:** `2339c38aeee31dcf5869c3d81bd373bf6974a30c`  
**Tip:** `aa62d700b21554c521bbbd41a0cdbb411b785c56`  
**Kind:** test/docs only — no production behavior change; no competing
gateway-diagnostic command.

## Purpose

Prove a future provider-neutral gateway diagnostic can safely **reuse**
ContextDesk production plumbing (discovery, `backend_for`, qualification,
credential cache, activity/trace, redaction, session/corpus cleanup) without
introducing a second HTTP client, parallel agent loop, or Keychain-only path.

## Read-only inventory of `feat/gateway-diagnostic-suite-v1`

At audit time this branch **did not exist** on `origin` (no local or remote
ref). No integration into that suite was performed. Interfaces were not
modified.

## Hermetic suite

`crates/cd-workflow/tests/gateway_diagnostic_contract_audit.rs`

| Contract | Test(s) |
| --- | --- |
| Exact discovery IDs + selected-model wire binding | `discovery_returns_exact_catalog_ids_and_selected_model_is_bound_on_the_wire` |
| Qualification key model + endpoint fingerprint | `qualification_key_binds_exact_model_and_fingerprints_endpoint_not_raw_url` |
| Generation / tools / continuation / structured | `qualification_suite_covers_generation_tools_continuation_and_structured_on_live_transport` |
| Gated / unsupported ≠ Pass | `gated_or_untested_capabilities_are_never_reported_as_pass`, `investigator_name_hint_cannot_force_a_pass_without_measured_contract` |
| Surface-neutral activity + telemetry DTO | `activity_and_provider_telemetry_are_surface_neutral_for_human_jsonl_and_no_color` |
| Protected-file credential, one read/turn, no Keychain | `protected_file_credential_resolves_once_per_turn_without_keychain` |
| Credential on wire header, never in trace bodies | `resolved_credential_reaches_wire_header_but_never_trace_bodies` |
| Redaction of secrets / paths / endpoints | `scrub_secrets_and_gateway_redact_cover_credentials_paths_and_endpoints` |
| Deadline/cancel bounds | `outer_deadline_and_cancel_bound_in_flight_provider_work` |
| Temp corpus/session cleanup | `temporary_corpus_and_session_cleanup_on_success_failure_timeout_and_cancel_paths` |
| Reuse `backend_for` / credential cache / qualification | `production_plumbing_entrypoints_exist_for_diagnostic_reuse` |

All traffic uses `cd_test_gateway::MockGateway`. Secrets are synthetic
mode-600 files via `file_secret_ref` / `ReferencedSecretStore`.

## Commands

```bash
git rev-parse HEAD   # base then tip
cargo test -p cd-workflow --test gateway_diagnostic_contract_audit -- --nocapture
cargo fmt --all -- --check
cargo clippy -p cd-workflow -p cd-core --all-targets -- -D warnings
# Related existing labs (sanity)
cargo test -p cd-workflow --test gateway_wire_credentials -- --nocapture
cargo test -p cd-workflow --test gateway_wire_qualification -- --nocapture
```

## Counts (green)

| Suite | Result |
| --- | --- |
| `gateway_diagnostic_contract_audit` | **13** passed |
| fmt / clippy (cd-workflow, cd-core) | pass (see gates log) |

## Mutation inversions (each fails, then restore green)

| Failure mode | Inversion | Outcome |
| --- | --- | --- |
| Wrong model ID | expect wire model = other catalog id | fails → restore green |
| Duplicated credential resolution | expect `read_count() == 2` | fails → restore green |
| Leaked secret in trace | assert serialized contains secret | fails → restore green |
| Skipped cleanup | assert session still exists after delete | fails → restore green |
| Unsupported marked green | require all Pass from empty transport | fails → restore green |
| Deadline bypass | require successful completion of NeverEnds | fails → restore green |
| Second HTTP client | require non-existent `backend_for_COMPETING_CLIENT` | fails → restore green |

## Honest gaps / residuals

- **Linked-log triage multi-stage end-to-end** against a full agent loop is not
  fully scripted here; the audit proves the same production chat transport +
  inert tool continuation qualification path a diagnostic would reuse, and
  that activity/telemetry capture is surface-neutral. Full multi-stage triage
  remains covered by existing agent/multi_stage labs.
- **CLI binary human / `--no-color` / JSONL rendering** is proven at the shared
  DTO layer (`ProviderTurnTelemetry` + `ActivityRecorder`), not by spawning
  three full CLI processes per scenario.
- **Full workspace CI** not re-run; focused audit + related credential/
  qualification labs only.
- No live provider, real Keychain, or private corpus fixtures.

## Non-goals confirmed

- No production module behavior changes on this branch.
- No new user-facing gateway-diagnostic command.
- No merge/rebase of unrelated feature branches.
