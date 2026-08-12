# Triage Policy V2 provider-free CLI proof

Status: **partial issue #872 implementation; Enhanced/Advanced CLI execution is
wired through the trusted host resolver, with live provider readiness still
requiring explicit preflight evidence.**

## Surface

```text
contextdesk triage-policy example
contextdesk triage-policy validate --policy FILE --preflight FILE
contextdesk triage-policy compile --policy FILE --preflight FILE
contextdesk triage-policy store list --store FILE
contextdesk triage-policy store save --store FILE --policy FILE --policy-id ID
contextdesk triage-policy store select --store FILE --policy-id ID
contextdesk triage-policy store clear --store FILE
contextdesk triage run --request REQUEST.json --preflight PREFLIGHT.json
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

## Stateful V2 run

`triage run` accepts one bounded `contextdesk.triage.request.v2` document. An
Enhanced or Advanced request must include a host-authored
`TriagePolicyPreflightV2` document with `--preflight`; omission or malformed
preflight fails closed before a provider call. The command then uses the
existing CLI paths, app configuration, protected-file credential plumbing,
corpus binding, packet builder, provider backend factory, production runner,
validation hooks, replay, and cleanup. It does not create a second HTTP client
or a parallel triage implementation. The exact model id from each admitted
preflight slot is passed to the backend factory rather than allowing a global
default model to replace it.

The output is owner-only and contains the typed V2 result plus the ordered
replay. A grounded result reports `status: "completed"`; a host-validated
answer that does not establish a root cause reports `status: "partial"`. The
Standard selection remains intentionally state-free and returns a typed
`standard_uses_established_path` refusal; ordinary single-model work continues
through `contextdesk chat` and the established workflow.

## Residuals

- Automatic AppConfig migration and implicit policy selection remain deferred;
  the policy store and preflight are explicit opt-in inputs.
- No provider qualification evidence is gathered by this command; preflight
  facts are explicit host input and live compatibility is not inferred.
- Tauri/GUI live selection and server-side live execution still need to call
  the same host resolver; the CLI path is the first product surface wired.
- CLI output is emitted after the run. Incremental JSONL/Tauri event streaming
  remains follow-up work, although the returned replay is the shared ordered
  SDK event stream.
- JSONL currently uses the normal one-shot envelope because compilation does
  not stream; the future execution surface will use shared SDK run events.
