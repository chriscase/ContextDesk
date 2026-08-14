# Triage Policy V2 overnight execution plan

Status: active implementation plan (2026-08-12)

## Authoritative starting point

- Branch: `integrate/triage-policy-sdk-v2`
- Exact starting SHA: `2ba4a08dcca0feaaefe65eb89614103fb06ad294`
- The starting worktree was clean and pushed. Feature lanes must use isolated
  worktrees and report exact commits before integration.

The established Standard path is the compatibility floor. It remains one
explicit answer model, the existing deterministic host retrieval/packet path,
and host validation. Selecting V2 is an explicit opt-in; a missing, stale, or
invalid V2 policy must never silently change Standard behavior.

## Canonical V2 execution graph

```text
host packet + neighborhood snapshot
  -> bounded contributors (sequential, independently accounted)
  -> preliminary host reconciliation
  -> conditional reviewer/challenger (only when policy condition is true)
  -> final host reconciliation
  -> optional finalizer over accepted reconciliation only
  -> host validation (citations, role integrity, chronology, privacy)
  -> at most one bounded semantic correction
  -> grounded final or honest partial / visible escalation
```

The model never owns evidence identity, chronology, causal-role promotion,
policy selection, provider selection, or terminal status. A reviewer is not a
peer vote and a finalizer is not a second investigator. A single exact
`ModelRef` filling several roles is several role attempts but one independent
model reference.

## Required product contract

One host-neutral runner/resolver must feed the Rust SDK, CLI JSON/JSONL, Tauri,
TypeScript mock, and server/SSE adapters. The event stream is ordered,
replayable, privacy-classified, and terminal exactly once. Every configured
slot is visible as admitted, completed, abstained, unavailable, invalid,
timed-out, cancelled, or not-admitted. Physical provider calls and semantic
corrections are separate counters; transport retries never masquerade as a
new role attempt.

Qualification is bound to exact profile, catalog model, workflow/role,
protocol/dialect, probe schema, and freshness. Name hints are never positive
evidence. Retrieval specialists may improve recall or ordering, but they do
not establish causal truth and remain separately qualified from answer roles.

## Exit gates

1. Contract freeze: Rust/TypeScript fixtures, unknown-field/version rejection,
   exact qualification binding, packet/neighborhood identity, budget/cancel/
   correction accounting, and Standard regression coverage.
2. Runner: canonical graph, trusted resolver, optional dropout, same-model
   independence, phase/call/context/deadline/reserve enforcement, and replay.
3. Product surfaces: CLI run/cancel/replay, Tauri/GUI activity, TypeScript
   mock, and server/SSE all expose the same event stream and terminal result.
4. Hermetic quality: adversarial and mutation matrices cover malformed cheap
   outputs, false consensus, role confusion, stale qualification, hidden
   substitution, clock-incompatible chronology, budget races, cancellation,
   replay, and privacy.
5. Full gates: Rust workspace, CLI, desktop native, frontend typecheck/lint/
   Vitest/build, privacy/path scans, and exact identity. Disposable targets
   are measured before cleanup; user data and active worktrees are preserved.
6. Live evidence: only after gates, run a bounded Vercel comparison through
   existing diagnostic plumbing. Keep raw owner-local; convert stable wire
   behavior into share-safe fixtures and the cost/reliability ledger. Separate
   compatibility, usefulness, reliability, latency, cost, and unknowns.
7. Employer handoff: provide one source-based procedure that preserves the
   existing corpus/config/timezone and never asks for credentials in chat.

## Delegation boundaries

- Claude high-end cloud: shared runner/resolver, finalizer/reviewer contracts,
  and budget ledger; no `fast` mode and no provider credentials.
- Grok Build: state-machine/mutation attacks, malformed-output and privacy
  campaign, and server/SSE disconnect conformance; hermetic only.
- Cursor cloud: progressive-disclosure CLI/GUI activity and Rust/TypeScript
  adapter parity after the contract is frozen.
- Release integrator: isolated-branch review, exact-SHA integration, private
  protected-file live runs, fixture conversion, and release claims.

No live run may be used to promote a model automatically. A live result is
evidence for this exact workflow and configuration, not a universal badge.
