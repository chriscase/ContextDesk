# Investigation Team qualification in the desktop

This page describes the first desktop bridge for the provider-neutral
Investigation Team qualification contract. It is deliberately a bridge, not a
claim that every configured model has already run.

## What the operator sees

Advanced AI settings contains an Investigation Team readiness panel. It shows:

- the selected route: Standard, Reviewer, or Contributions;
- host-recorded role assignments and model identities;
- measured qualification for additional roles when the host has recorded it;
- remote evidence-egress acknowledgement where it applies;
- whether a host-published qualification report is present;
- the exact pipeline fingerprint and four separate contract axes when a report
  is available; and
- stale or incomplete evidence as degraded, never as a clean pass.

The panel keeps three statements separate:

1. **Configured** means a role/profile assignment was saved.
2. **Measured qualified** means the host recorded a qualification result for
   that role or report.
3. **Executed** means a particular investigation actually admitted and ran the
   role; this is recorded by the run and is not inferred by this panel.

## Trust boundary

The core scorer lives in `cd_core` and the host-neutral execution seam lives in
`cd_workflow`. The desktop host owns the next boundary:

```text
host-built QualificationInput
        │
        ▼
cd_workflow::investigation_team_qualification::execute
        │  score + redact + round-trip parse
        ▼
host-published durable redacted history
        │
        ▼
read-only Tauri DTO → Settings readiness panel
```

The webview has no setter for the qualification store. It can read or clear
bounded redacted history, but it cannot submit evaluator truth, provider
credentials, or a fabricated `QualificationInput`. Every trusted publisher
must publish only after it has assembled the exact role bindings, evidence
packet, policy/budget identity, attempt observations, and endpoint fingerprints.
The desktop now provides both an explicit provider-free contract check and an
explicit measured provider check. The latter sends one bounded opaque fixture
per configured V1 role; it does not send workspace evidence.

## Status semantics

| Status | Meaning | Operator action |
| --- | --- | --- |
| `qualified` | All four axes meet their own contracts and attempts completed. | Still inspect the run record before relying on it. |
| `failed` | At least one capability, quality, speed, or resource axis failed. | Fix the named axis; do not call the team qualified. |
| `partial` | A failure, timeout, cancellation, or incomplete attempt remains. | Retry or inspect the incomplete attempt. |
| `stale` | The report’s suite evidence is no longer current. | Re-run against the current suite before use. |

The axes stay separate. A faster model is not automatically better, and a
capable model with unsupported claims is not a quality pass.

## Durable history and current limits

The host persists a bounded, owner-only, redacted history and reloads it before
each operation. Malformed or unavailable history fails closed and the UI shows
that the history cannot be trusted; a newer provider-free wiring check does not
displace measured provider evidence. Writes use atomic replacement and
compare-and-swap safeguards on supported hosts.

The measured check qualifies the exact configured role bindings against an
opaque fixture. It is still a preflight, not proof that a team executed a real
investigation successfully. Exact snapshot/evidence identity, budgets, stale
reports, and actual role admission remain runtime checks on each investigation.
Contribution-role topology is not represented by the V1 measured runner and
fails closed instead of being relabeled.
