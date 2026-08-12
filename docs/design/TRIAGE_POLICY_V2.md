# Triage Policy V2

Status: **accepted implementation plan; not yet shipped**. GitHub issue
[#872](https://github.com/chriscase/ContextDesk/issues/872) tracks the work.

## Product outcome

ContextDesk should produce useful, evidence-grounded investigations with the
models a user can actually access. A capable single model must remain enough.
When several models or retrieval specialists are available, ContextDesk may
use their bounded contributions without making any model the authority for
evidence, chronology, causal roles, citations, policy, or accepted findings.

This is one product capability with three levels of disclosure:

| Level | User experience | Runtime meaning |
| --- | --- | --- |
| **Standard** | Select one model and investigate | Deterministic host retrieval and validation around one qualified answer model |
| **Enhanced** | Enable one saved, preflighted investigation policy | Explicit bounded contributors, optional retrieval specialists, deterministic reconciliation, and an optional finalizer/reviewer |
| **Advanced** | Inspect or edit roles, gateways, budgets, egress, and qualification | The same policy contract with every consequential choice visible; no separate expert-only engine |

Standard is the permanent default. Enhanced and Advanced are optional. The
product must never silently move a user between them.

## Authority boundary

The trusted host owns:

- corpus, source, revision, packet, candidate, and evidence identities;
- privacy, egress, credential, tool, cancellation, and budget policy;
- parsing, chronology compatibility, neighborhood construction, retrieval
  fusion, deduplication, and deterministic causal guardrails;
- contribution validation, reconciliation, citations, and the terminal result;
- the distinction between compatibility, retrieval quality, answer quality,
  orchestration quality, cost, and reliability evidence.

Models may interpret only the bounded material admitted for their role. They
cannot mint evidence, broaden scope, select an unapproved provider, promote a
symptom to a cause by assertion, or turn agreement into truth.

## Stable execution flow

1. **Compile policy.** Resolve exact gateway-scoped model references, role
   requirements, qualification, egress, and budgets before a provider call.
2. **Build host packet.** Pin corpus and revision, then assemble one immutable,
   bounded packet with canonical evidence identities and chronology rules.
3. **Retrieve.** Always retain the keyword/structured baseline. Optional dense,
   hybrid, and rerank specialists may reorder or recall permitted candidates;
   they do not create causal authority.
4. **Collect contributions.** Run explicitly admitted required and optional
   role slots. V2 remains sequential by default so accounting, cancellation,
   replay, and degradation stay deterministic.
5. **Reconcile.** Normalize accepted claims and report exact agreement,
   compatible support, contradiction, abstention, missing coverage, and role
   dropout without using prose similarity as truth.
6. **Finalize if eligible.** A separately qualified finalizer may draft from
   only the accepted reconciliation and permitted evidence identities.
7. **Review only if required.** A reviewer is a conditional, explicitly
   authorized phase for contested or policy-selected cases, not another peer
   contribution and not an automatic cross-provider retry.
8. **Validate and present.** Host citation, evidence, chronology, causal-role,
   and output validators return a grounded answer or an honest partial result.

No stage may hide completed deterministic work merely because a later model
timed out, failed, or abstained.

## Public contract

The implementation uses additive, versioned contracts:

- `TriageRequestV2`: task, governed scope, policy reference or inline policy,
  user-authored overrides, and cancellation identity.
- `TriagePolicyV2`: experience level, role slots, retrieval policy, finalizer,
  conditional reviewer, egress rules, and typed budgets.
- `ModelRef`: exact provider profile and catalog model identity. Workflow,
  protocol/dialect, and qualification evidence remain bound separately.
- `RetrievalSnapshotV1`: exact lexical/dense/fusion/rerank configuration and
  evidence fingerprints used for the run.
- `TriageRunEventV2`: ordered host-authored progress, attempts, degradation,
  reconciliation, validation, and one terminal event.
- `TriageResultV2`: grounded final answer or honest partial result, accepted
  evidence, role/model/gateway support counts, conflicts, gaps, and safe usage.

Unknown contract versions fail visibly. New optional fields are additive;
changing the meaning of a field requires a new schema version.

## Budget semantics

`round` is not a provider-call counter. V2 names independent limits:

- monotonic whole-turn deadline;
- maximum admitted provider calls;
- contributor-phase allowance and per-contributor operation cap;
- validation/correction allowance;
- finalizer reserve and operation cap;
- conditional reviewer reserve and operation cap;
- bounded context characters/tokens and output limits.

The compiler rejects internally impossible budgets. Runtime admission never
extends a user-authored whole-turn deadline. Every configured slot receives an
explicit terminal disposition, including slots rejected during preflight or
not admitted after a deadline/cancellation.

Parallel execution is deferred. When introduced, it must be an explicit policy
choice with deterministic result ordering, cancellation, accounting, egress,
and replay semantics. It is not a timeout workaround.

## Model independence and reconciliation

One exact gateway/model may fill several roles. That can be useful, but it is
one model, not several independent witnesses. Results report at least:

- configured and completed role slots;
- distinct exact models;
- distinct gateways;
- normalized supported claims and evidence coverage;
- contradictions, abstentions, invalid attempts, and missing required roles.

Exact normalized claim equality is strong agreement. Compatible partial
support may be reported separately when bounded evidence sets overlap without
contradiction. Neither category establishes root cause; only the host answer
validator may accept a causal finding.

## Qualification and routing

A generic JSON response is not sufficient evidence for every role. Eligibility
is bound to the exact profile, endpoint fingerprint, model, protocol/dialect,
workflow, role, probe schema, and product version. Stale or missing evidence
cannot become positive through a model-name hint.

There is no silent gateway substitution. Adaptive routing remains deferred to
[#727](https://github.com/chriscase/ContextDesk/issues/727) and may later choose
only among explicitly authorized, currently qualified candidates. Cost and
quality ledgers inform a user or an explicit policy; they never write readiness
or automatically select a winner.

## Retrieval remains optional and separately evidenced

Keyword and structured retrieval are the dependable baseline. Embedding,
hybrid fusion, and reranking are independently configured specialists with
their own endpoint dialect, qualification, egress, deadlines, and quality
evidence. A retrieval failure preserves the baseline order and remains visible.
Better retrieval can help a cheap answer model, but it cannot recover evidence
discarded by scope, parsing, privacy, truncation, or an earlier host decision.

## SDK and product surfaces

The same implementation must package cleanly rather than being recreated per
surface:

- `cd-core`: pure policy, packet identity, reconciliation, validation, schema,
  and migration logic;
- `cd-workflow`: host-neutral orchestration, cancellation, backend traits, and
  event emission;
- Rust SDK facade: `triage(...)` for Standard and
  `triage_with_policy(...)` for Enhanced/Advanced, plus compile, preflight,
  cancel, replay, and evaluate seams;
- CLI: human progress plus stable JSON/JSONL from the shared event stream;
- GUI: Settings-first policy setup, preflight, progressive disclosure, and the
  same shared run state;
- server/other languages: HTTP/SSE or subprocess adapters over the same
  versioned contracts;
- deterministic Mock adapter: contract, replay, cancellation, and privacy
  conformance without a network or secret store.

Reusable layers must not require `AppConfig`, Tauri state, CLI arguments,
Keychain, or a fixed filesystem. ContextDesk must dogfood the public workflow;
the desktop receives no privileged orchestration path.

## Delivery order

1. Add V2 policy/request/event/result contracts and pure compiler while
   preserving all V1 and single-model behavior.
2. Correct role-slot, budget, dropout, same-model independence, finalizer, and
   conditional-reviewer semantics behind an explicit opt-in.
3. Add Mock/CLI contract conformance and Rust/TypeScript golden fixtures.
4. Expose Settings-first Standard/Enhanced/Advanced policy management.
5. Integrate separately proven chat dialect, reasoning-effort, embedding,
   reranking, diagnostic, quality, and cost/reliability lanes.
6. Run controlled live diagnostics, convert stable wire observations into
   hermetic fixtures, and evaluate usefulness without promoting readiness.
7. Add parallelism or adaptive routing only after the sequential policy is
   demonstrably correct and useful.

## Current production adapter boundary

The first trusted-host adapter is deliberately narrower than the full policy.
It can convert a fully admitted Enhanced/Advanced contributor-only plan into
the established linked-log contribution runtime for observation extraction,
causal proposals, contradiction checking, and evidence-gap finding. That reuses
the existing immutable host packet, provider backends, cancellation, budgets,
stage events, validation, reconciliation, renderer, and cleanup.

The trusted host resolver now binds this production runner for the explicit CLI
`triage run --request ... --preflight ...` surface. It resolves the exact
corpus, packet, profile, protected-file credentials, qualified model ids, and
backend through the existing plumbing, then returns the shared typed replay and
result. It refuses Standard (which stays on the established single-model
route), timeline analysis, a finalizer, a reviewer, visible optional-role
dropout, or deadline semantics the established route cannot enforce. Tauri/GUI
and server live selection are still follow-up surfaces; they must call this
same resolver rather than recreate it. See
[`TRIAGE_POLICY_V2_PRODUCTION_ADAPTER_V1.md`](../testing/TRIAGE_POLICY_V2_PRODUCTION_ADAPTER_V1.md).

## Release proof

Release claims require clean exact identity; legacy migration; provider-free
contract, mutation, privacy, cancellation, replay, and parity gates; production
CLI/GUI path proof; and controlled live evidence for each claimed workflow.
Partial implementation remains labelled partial. A fluent response, successful
transport, or green compatibility probe is never by itself a useful-triage
claim.
