# Investigation strategy connector v1

Status: **contract + dry-run planner only**. This note specifies a
provider-neutral connector contract so ContextDesk War Room can configure,
rerun, import, and compare investigation strategies against an exact frozen
snapshot. It does **not** ship provider calls, credentials, networking, UI
controls, or persistence.

Shipped module: `collab/contracts/src/investigation-strategy-connector.ts`

Schema: `collab/contracts/schemas/investigation-strategy-connector.v1.json`

The package barrel (`collab/contracts/src/index.ts`) re-exports the module.
Consumers import `@cd-collab/contracts`.

## Why this layer exists

War Room already has several investigation methods:

- built-in synthetic triage jobs (`cd-collab.triage_job.v1`);
- gateway-backed comparison lanes through the host bridge;
- manual imported runs and Experiment Lab strategy packages;
- future third-party methods that should not each invent a private job shape.

Those methods share a job: bind work to one investigation, one frozen
snapshot, a strategy/question, and selected evidence; keep earlier attempts;
compare without declaring a winner. This connector contract is the common
fail-closed envelope. It does not replace the existing triage or Experiment
Lab documents. It names how they fit together.

## Objects

| Object | Schema id | Role |
| --- | --- | --- |
| Connector capability / manifest | `cd-collab.investigation_strategy_connector.v1` | Stable identity, version, execution mode, inputs, host capabilities, privacy/egress, output schema, trace/cost/usage support, cancellation |
| Run request | `cd-collab.investigation_strategy_run_request.v1` | Investigation, job, strategy/question, exact snapshot fingerprint/lineage, evidence identities, connector identity/version, optional profile/model, operator consent, request fingerprint |
| Run result | `cd-collab.investigation_strategy_run_result.v1` | Append-only attempt: claims, citations, unknowns, status, trace/usage/cost, provenance. `humanFinding` is always false |
| History | `cd-collab.investigation_strategy_run_history.v1` | All attempts for one request fingerprint. Later runs append; they never overwrite |
| Host catalog | `cd-collab.investigation_strategy_host_catalog.v1` | Declared capabilities and frozen snapshots for planning. Not authorization |
| Plan | `cd-collab.investigation_strategy_plan.v1` | Dry-run: `can_execute`, `must_import`, `blocked`, or `unknown_capability`. `contactedProvider` is always false |
| Comparison projection | `cd-collab.investigation_strategy_comparison.v1` | Deterministic shared/unique evidence and claim agreement for the existing comparison pipeline. `winnerSelected` and `consensusAsTruth` are always false |

Deny-unknown `checkObject` rejects contract drift. SHA-256 request fingerprints
are integrity, not authenticity.

## Execution modes

| Mode | Meaning | Planner result when otherwise valid |
| --- | --- | --- |
| `host_run` | ContextDesk or its host executor runs the method | `can_execute` |
| `external_import` | Operator supplies output from outside the host | `must_import` |
| `manual` | Operator authors a structured result | `must_import` |

A third-party connector uses the same three modes. This slice does not load,
network, or trust a third-party binary.

## Built-in ContextDesk mappings

These manifests ship as parseable constants. They do not execute.

| Connector id | Fits | Host capabilities | Egress |
| --- | --- | --- | --- |
| `builtin.synthetic_triage` | Built-in deterministic mock triage | `snapshot_store`, `evidence_inventory`, `synthetic_executor` | `none` |
| `builtin.gateway_compare` | Gateway-backed lanes via the host bridge | `snapshot_store`, `evidence_inventory`, `gateway_bridge`, `profile_catalog` | `declared_provider` |
| `builtin.external_import` | Pasted or file-imported runs | `snapshot_store`, `evidence_inventory` | `none` |
| `builtin.manual_notes` | Operator-authored structured notes | `snapshot_store`, `evidence_inventory` | `none` |

Gateway lanes still require operator egress consent and a host-owned profile
identity. Share-safe requests cannot use declared-provider egress. Cost and
usage stay `unknown_only` until a later slice can prove observed metrics.

Existing `cd-collab.triage_job.v1` documents remain the live job records for
built-in and gateway runs. A future host may project those jobs into this
connector envelope; this contract does not rewrite triage persistence.

Existing Experiment Lab imports remain the live import path for strategy
packages and traces. `builtin.external_import` names that path as a connector
without changing the import parsers.

## Request fingerprint and reruns

The request fingerprint hashes investigation, strategy, question, snapshot
fingerprint and lineage, selected evidence, connector identity/version, and
profile/model. It does **not** include job id, attempt id, timestamps, or
operator identity. Same inputs therefore yield the same fingerprint.

Results are not required to be deterministic. History stores each attempt with
a contiguous revision starting at 1. Duplicate attempt ids and overwritten
revisions fail closed.

## Dry-run planner

`planInvestigationStrategyRun` is a pure function. It never contacts a
provider. It reports:

- `can_execute` — host-run connector, exact snapshot, evidence present, capabilities available, privacy/consent satisfied;
- `must_import` — external import or manual mode, otherwise valid;
- `blocked` — version drift, dangling evidence, snapshot mismatch, conflicting job strategy/question, denied capability, missing profile, or privacy/egress refusal;
- `unknown_capability` — a required host capability is neither available nor denied.

The host catalog is not an authorization document. A later apply/execute path
must revalidate host state.

## Comparison

`projectInvestigationStrategyComparison` requires at least two attempts on the
same snapshot fingerprint and strategy. It emits shared vs unique evidence and
text-hash claim agreement. It always includes:

- `Agreement is not proof of correctness.`
- `Textual similarity is not a winner.`
- `Consensus is not truth.`
- `No winner is selected.`
- `Imported or generated connector output is not a human finding.`

This projection is suitable as an input to the existing War Room / Experiment
Lab comparison pipeline. It does not select a winner or treat agreement as
gold.

## Honesty residuals

Not in this slice:

- executing a connector, including synthetic host runs
- provider credentials, endpoints, or live gateway calls
- UI controls that cannot execute
- persistence of history rows
- promoting a connector result to a human finding or accepted decision
- Ed25519 or other authenticity
- treating imported chat text as a native War Room run

Fixtures and tests are fully synthetic.
