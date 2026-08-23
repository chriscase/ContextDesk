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
host-published process-local result
        │
        ▼
read-only Tauri DTO → Settings readiness panel
```

The webview has no setter for the qualification store. It can read or clear
the process-local readout, but it cannot submit evaluator truth, provider
credentials, or a fabricated `QualificationInput`. A future trusted runner
must publish only after it has assembled the exact role bindings, evidence
packet, policy/budget identity, attempt observations, and endpoint fingerprints.

## Status semantics

| Status | Meaning | Operator action |
| --- | --- | --- |
| `qualified` | All four axes meet their own contracts and attempts completed. | Still inspect the run record before relying on it. |
| `failed` | At least one capability, quality, speed, or resource axis failed. | Fix the named axis; do not call the team qualified. |
| `partial` | A failure, timeout, cancellation, or incomplete attempt remains. | Retry or inspect the incomplete attempt. |
| `stale` | The report’s suite evidence is no longer current. | Re-run against the current suite before use. |

The axes stay separate. A faster model is not automatically better, and a
capable model with unsupported claims is not a quality pass.

## Current limitation and next slice

The current bridge is process-local and read-only from the renderer. It does
not yet persist reports or invoke providers. The next production slice should
build a trusted runner from the existing bounded investigation pipeline, bind
each attempt to the exact snapshot/evidence identity, publish the resulting
redacted report, and add a synthetic end-to-end acceptance journey. Until then,
the Settings panel intentionally says when no host-produced team report is
attached.
