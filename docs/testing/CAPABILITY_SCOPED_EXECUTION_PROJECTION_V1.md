# Capability-scoped execution projection v1

This lane makes qualification evidence usable by both the CLI and desktop
without turning a model-name hint or an aggregate readiness label into a
permission to execute a richer workflow.

## Contracts

`cd_core::capability_qualification::CapabilityContract` exposes three narrow
execution modes:

| Wire mode | Required evidence |
| --- | --- |
| `host_grounded_generation` | basic generation |
| `validated_structured_proposal` | basic generation + structured output |
| `native_tool_loop` | basic generation + native tool call + tool-result continuation |

The host still owns grounding, JSON validation, and tool authorization. A
`qualified` result is therefore only permission to attempt that measured wire
contract; it is not a claim that a model's answer is useful or that a tool is
safe to run.

## Three-state projection

Every contract is one of:

- `qualified`: all required probes are current and passed;
- `unqualified`: a required probe ran and failed or was degraded;
- `inconclusive`: evidence is absent, stale, cancelled, or all required
  probes were `untested`.

The `inconclusive` state is intentional. It prevents a cancelled or
role-gated run from appearing as a failed model, and prevents an all-NotRun
diagnostic from being reported as compatibility or usefulness evidence.

An explicit profile tools-off gate forces `native_tool_loop` to remain
`inconclusive`, even if an old report contains tool passes. The configuration
is never silently broadened by the projection.

## Shared transport

`cd_workflow::capability_qualification::QualificationReportDto` now carries
the same `CapabilityContractProjection` consumed by the CLI and desktop host.
No second provider client or qualification implementation is introduced.

Hermetic coverage in `cd-core` proves scoped independence, stale/cancelled and
all-NotRun handling, and tools-off preservation. The existing gateway
diagnostic `VerdictStatus::Inconclusive` remains the report-level projection
for cases where no applicable lane executed.

## Follow-up

Callers that have a profile gate should use
`capability_contract_projection(report, Some(&gate))`; callers rendering a
cached report without the gate can pass `None`, in which case report evidence
alone is projected. Future capability-specific adapters should add a new
`CapabilityContract` and required probe set rather than reusing another mode's
pass.
