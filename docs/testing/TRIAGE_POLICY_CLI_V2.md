# Triage Policy V2 CLI proof

Status: **provider-neutral policy compilation, exact-role qualification, and
the trusted Standard/Enhanced/Advanced production runner are available. Live
execution remains fail-closed until the exact selected profile exists and
every policy-required role has current host evidence.**

## Surface

```text
contextdesk triage-policy example
contextdesk triage-policy validate --policy FILE --preflight FILE
contextdesk triage-policy compile --policy FILE --preflight FILE
contextdesk triage-policy store list --store FILE
contextdesk triage-policy store save --store FILE --policy FILE --policy-id ID
contextdesk triage-policy store select --store FILE --policy-id ID
contextdesk triage-policy store clear --store FILE
contextdesk triage-policy qualify --profile PROFILE --model MODEL --role ROLE --yes
contextdesk triage run --request REQUEST.json
```

All three actions return `contextdesk.cli.triage_policy.v1` with
`privacy: "owner_only"`. Validation and compilation call
`cd_core::multi_model::triage_policy::compile_triage_policy_v2` directly. There
is no second policy implementation in the CLI.

The command is dispatched before ContextDesk path/config resolution. It reads
only the explicitly named JSON files, each bounded to 1 MiB. It does not read
or mutate AppConfig or CLI state, touch a corpus, read credentials or Keychain,
perform discovery, or contact a provider. Input paths and parse details are not
included in output. Exact profile/model identities are intentionally retained,
so this owner-local output is not described or tested as share-safe and must be
reviewed before sharing.

A rejected but well-formed policy is a completed report with process exit 8
(`not_ready`), preserving every typed rejection and configured slot disposition
inside JSON. Malformed/unsupported JSON is a user error. `compile` adds the
shared compiled plan; `validate` keeps the smaller result. Both report the
Standard/Enhanced/Advanced mode and separate role/model/gateway independence
counts when accepted.

## Focused gates

```text
cargo test -p cd-cli --test triage_policy_cli
cargo test -p cd-cli --bin contextdesk cli::tests
cargo clippy -p cd-cli --bin contextdesk --test triage_policy_cli -- -D warnings
cargo fmt --all -- --check
git diff --check
```

The six process tests cover exact namespaced model ids, invalid schema, required
and optional dropout, denied remote egress, same-model/multi-role accounting,
poisoned ambient state, bounded/path-safe and secret-free output, explicit
owner-only labelling, the safe Standard example, and both human and JSON
rendering.

The store actions operate only on the explicitly named non-secret policy-store
file. `save` validates the V2 schema, increments that policy identity's
revision, selects it, and publishes atomically. `select` and `clear` are
explicit reversible selection changes; no selection means Standard remains the
safe default. Store output contains policy ids and revisions only, never
credentials, endpoints, provider bodies, or corpus data.

`qualify` is the stateful exception: it requires an exact configured profile,
the exact catalog model id, one explicit role, and `--yes`. It uses the
existing provider backend and synthetic packet/validator seams, makes at most
one logical provider call, and atomically writes only the host-authored,
secret-free result to the local role store. Slow models may use a larger
`--deadline-ms` within the V2 global bound. TimelineAnalyst and Reviewer use
the typed contribution contract; Finalizer uses the host answer validator. An
unqualified result is retained as negative evidence and exits with
`not_ready`; it never silently upgrades a policy.

## Stateful V2 run

`triage run` accepts and validates one bounded
`contextdesk.triage.request.v2` document before resolving application state.
Standard uses the exact gateway-scoped model in that request. An Enhanced or
Advanced request fails closed with
`triage_role_qualification_unavailable` until the exact role records required
by the compiled policy exist; if `--preflight` is supplied it is rejected as
`caller_preflight_not_authoritative` for every runtime mode. This refusal is
state-free: it occurs before application configuration, ToolHost construction,
or credential resolution, and the supplied file is not read. The provider-free
`triage-policy validate/compile` commands continue to accept explicit
preflight JSON for simulation only. The live command and Tauri now use the
same trusted resolver, existing protected-file plumbing, corpus binding,
packet builder, provider factory, validation, replay, and cleanup.

The output is owner-only and contains the authoritative, canonically
request-bound V2 replay plus its typed terminal projection. Grounded and honest
partial completions report `completed` and `partial`; failed, timed-out, and
cancelled terminals remain distinct and retain any honest partial result. CLI
and Tauri call `cd_triage_runtime::triage` for Standard and
`cd_triage_runtime::triage_with_policy` for Saved/Inline through the same
`WorkflowTriageEngineV1`. Standard therefore uses the same immutable packet,
host validation, replay, deadline, cancellation, and cleanup path without
hidden routing or model substitution. The established `contextdesk chat`
surface remains available and unchanged.

## Residuals

- Automatic AppConfig migration and implicit policy selection remain deferred;
  the policy store is an explicit opt-in input.
- Dedicated exact role qualification is available through the CLI for typed
  contributors, Reviewer, and Finalizer; generic capability qualification is
  never promoted to V2 authority.
- Tauri uses the shared runtime façade, emits request-bound validated events
  progressively, returns the authoritative replay, and refreshes its in-memory
  qualification snapshot after the host publishes a matching probe record.
- The host rejects unsupported non-empty source scopes and corpus revision
  drift rather than silently widening the request.
- Policy compilation JSON remains a one-shot envelope; live execution returns
  the shared SDK replay/event stream.
