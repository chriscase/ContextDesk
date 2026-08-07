# Bounded multi-stage broad-log triage (experimental)

This is an experimental shared-core extension of deterministic broad-log
triage. It is used only when the host has produced at least two candidate
groups and the ordinary turn's provider-round and context budgets can reserve a
final comparison. Otherwise the established single-stage broad-log synthesis
continues unchanged.

```mermaid
flowchart TD
    H["Host: pin corpus + suppression revision"] --> B["Host: bounded broad brief"]
    B --> C["Host: <=4 structural candidates"]
    C --> S["LLM: candidate-only synthesis\n(max 2 attempts each)"]
    S --> V["Host: validate citations against that candidate only"]
    V -->|"valid groups >=2"| F["LLM: final ranked comparison"]
    V -->|"no groups / insufficient starting budget"| L["Existing single-stage path"]
    F --> G["Host: validate citations + every group remains named"]
    G --> O["Shared CLI / GUI stream events + telemetry"]
```

## Responsibility boundary

The host alone opens the corpus, pins revisions and suppression, constructs the
bounded broad brief, and selects no more than four groups. Parser-true
cross-source trace groups rank first; ungrouped ERROR/FATAL template groups
fill remaining slots. Warning and non-error noise candidates never become
incident groups. The LLM interprets a supplied group but cannot retrieve,
create groups, or move citations between groups.

Each candidate has a stable `group_id`, a small structural brief, and its own
trusted identity ledger (`seq`, `source`, `template_id`). A candidate response
must cite an identity from its own ledger. Invalid responses receive at most
one correction attempt and are then withheld. The final response sees only
accepted candidate drafts, must name each accepted `group_id`, keep sections
separate, rank them, and cite only their union. This avoids a global evidence
set incorrectly validating a decoy's citation from another incident.

## Bounds and failures

`AgentOptions.max_rounds` is the hard provider-call cap for this path. It
includes candidate attempts and the final comparison; the experimental path
never starts without room for a comparison. Candidate and final contexts use
the same headroom-aware context budget as ordinary linked synthesis. The current
implementation has an in-flight concurrency cap of one (conservative while
preserving one ordered provider trace); it is designed so a future bounded
parallel executor can raise that cap without changing the evidence contract.

Cancellation and the whole-turn deadline use the existing shared agent clock.
Every provider request still passes through the normal backend/trace observer,
so CLI and Tauri project the same events and provider telemetry. No provider is
called in tests: scripted hermetic cases cover three independent groups, a
cross-group decoy, bounded invalid retry, and total-round caps.

If groups are absent, the initial round budget is too small, or a candidate
context cannot fit, the workflow falls back before any multi-stage provider
request. Once an invalid candidate/comparison request has started, it fails
closed rather than silently mixing it into a global single-stage answer.

## Limitations

Candidate grouping is intentionally structural, not a root-cause verdict.
Cross-source trace identity is only parser-populated `trace_id`; no request,
span, or message token is promoted to a trace key. A no-trace corpus uses the
ERROR/FATAL template fallback and may not capture multi-template incidents.
The bounded sequential executor favors predictable cancellation, cost, and
telemetry over latency; live-provider quality and safe parallelism remain
separate acceptance work.
