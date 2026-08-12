# Triage Policy V2 provider-free CLI proof

Status: **partial issue #872 implementation; policy authoring/preflight only,
not runtime orchestration or provider readiness.**

## Surface

```text
contextdesk triage-policy example
contextdesk triage-policy validate --policy FILE --preflight FILE
contextdesk triage-policy compile --policy FILE --preflight FILE
contextdesk triage-policy store list --store FILE
contextdesk triage-policy store save --store FILE --policy FILE --policy-id ID
contextdesk triage-policy store select --store FILE --policy-id ID
contextdesk triage-policy store clear --store FILE
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

## Residuals

- Automatic AppConfig migration and runtime policy selection are still
  intentionally not wired; the new store is an explicit file surface until
  the trusted resolver is integrated.
- No provider qualification evidence is gathered; preflight facts are explicit
  host input and the report says live compatibility was not evaluated.
- No runtime execution, cancellation, replay, finalization, review, GUI, or
  TypeScript parity is claimed by this slice.
- JSONL currently uses the normal one-shot envelope because compilation does
  not stream; the future execution surface will use shared SDK run events.
