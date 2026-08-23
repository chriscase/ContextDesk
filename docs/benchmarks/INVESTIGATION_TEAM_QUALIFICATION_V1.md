# Investigation Team qualification core V1

Status: hermetic, provider-neutral core slice of issue #726.  
**Does not prove** live-provider quality, in-app matrix UX, stored results, or recommended defaults.

## What this slice is

A deny-unknown, versioned qualification contract plus a pure scorer in
`cd_core::investigation_team_qualification`. Hosts can later persist and display
these reports; this slice does not add UI, transports, credentials, or stores.

Pipeline identity is an exact fingerprint of:

- investigation-team **role**
- **profile** identity
- exact **model** identity
- **deployment** identity hash (`fingerprint_endpoint`)
- **policy/budget** identity
- **suite version**
- **timestamp**
- **staleness**

[`quality_eval::ModelSubject`](../../crates/cd-core/src/quality_eval/types.rs) is
reused for gateway-scoped model identity. Deployment hashing reuses
[`capability_qualification::fingerprint_endpoint`](../../crates/cd-core/src/capability_qualification.rs).
Citation roles reuse [`EvidenceRole`](../../crates/cd-core/src/investigation_answer.rs).
Those types are not weakened.

Evaluator truth is a sibling of the provider-facing packet, not a field of it.
Fluent answers without validated evidence fail the **quality** axis. Failed,
partial, timed-out, and cancelled attempts remain visible. There is **no**
universal “best model” score: capability, quality, speed, and resource are
separate tradeoffs.

## Mutation matrix

Driven by `crates/cd-core/tests/investigation_team_qualification.rs` against the
shipped `qualify` / `parse_report` / `render_json` / `render_markdown` /
`pipeline_fingerprint` entry points.

| Row | Drive | Expected |
| --- | --- | --- |
| happy path | `qualify` | all four axis contracts met; JSON+Markdown leak-free |
| `truth_leakage_into_provider_facing` | `qualify` | fail closed `truth_leakage` |
| `persuasive_hallucination_fluent_without_evidence` | `qualify` | quality contract fails; attempt preserved |
| `alias_confusion_does_not_transfer_identity` | `qualify` | distinct subject storage ids |
| `crossed_deployment_identity` | `qualify` | fail closed `crossed_fingerprint` |
| `stale_suite_claim` | `qualify` | fail closed unless `stale=true` |
| `partial_execution_preserved` | `qualify` | partial status remains |
| `cancellation_preserved` | `qualify` | cancelled status remains |
| `timeout_preserved` | `qualify` | timed_out status + speed metric |
| `same_subject_two_roles` | `qualify` | Investigator+Reviewer may share one `ModelSubject`; both roles stay in the fingerprint |
| `duplicate_role_identities` | `qualify` | fail closed |
| `invalid_metrics_empty_citation` | `qualify` | fail closed |
| `dishonest_completion` | `qualify` | fail closed |
| `unknown_fields_on_input` | serde | fail closed |
| equivalent reorder | `qualify` | identical fingerprint + reports |
| `report_tampering_quality_axis` | `parse_report` | fail closed `tampered_aggregates` |
| `report_unknown_field` | `parse_report` | fail closed |
| `report_fingerprint_digest_tamper` | `parse_report` | fail closed `crossed_fingerprint` |
| privacy leakage | JSON/Markdown | credentials, endpoints, aliases, unrelated inventory, raw private evidence absent |

## Non-claims

- No live providers, Keychain, or network.
- No universal best model.
- No cryptographic signatures or provenance.
- No persistence, Help, routing, or production-default changes.

## Remaining #726 operator-journey work

- In-app qualification matrix for configured role bindings
- Stored results, staleness UI, and recommended defaults from local evidence
- Help/handbook reproduction steps for operators
- Split-role live runs against checked-in synthetic corpora

## Commands

```bash
cargo test -p cd-core --test investigation_team_qualification
cargo test -p cd-core
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
```
