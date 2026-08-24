# Investigation Team qualification host seam V1

This slice connects the provider-neutral `cd_core::investigation_team_qualification`
contract to the shared `cd_workflow` boundary without claiming that a provider
was contacted. A trusted host builds a `QualificationInput` from exact role
bindings and recorded attempt observations, then calls:

```rust
let result = cd_workflow::investigation_team_qualification::execute(input)?;
```

The workflow seam:

1. runs the shipped core scorer and fingerprint builder;
2. renders the core-owned redacted JSON and Markdown reports;
3. parses the redacted JSON again with the fail-closed core parser;
4. exposes the exact fingerprint digest and an honest lifecycle status.

`qualified` means every scored axis is contract-compliant and every attempt is
complete. `failed` means at least one axis is not contract-compliant. `partial`
means an attempt is failed, cancelled, timed out, or incomplete. `stale` wins
over those states whenever the pipeline fingerprint says the suite evidence is
stale. No status is inferred from a model name, prose, or a successful network
request.

This is intentionally not a provider runner, credential path, persistence
layer, or UI. Those hosts must supply the exact input and preserve the returned
fingerprint when they store or compare results. The redacted exports contain
model/profile identity and hashed deployment identity as defined by the core
contract, but do not contain deployment URLs, evaluator truth, or evidence
excerpts.
