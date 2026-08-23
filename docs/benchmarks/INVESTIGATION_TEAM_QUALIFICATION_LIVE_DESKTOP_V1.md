# Investigation Team measured desktop check V1

The Investigation Team readiness panel now has an explicit **Run measured
check** action. It is user-triggered and host-owned. It sends a small opaque
qualification packet to one configured provider target per representable role;
it never sends case evidence, workspace text, evaluator truth, or credentials
to the provider.

## What is measured

Each attempt is bound to the exact role, provider profile, model id, and
deployment fingerprint captured before the call. The host records:

- completed, failed, cancelled, or partial attempt status;
- strict JSON response parsing and evidence-id citations;
- wall-clock latency;
- a bounded byte-count resource proxy when provider token usage is not
  available; and
- the qualification report's capability, quality, speed, and resource axes.

The report is produced through the shared `cd_workflow` execution seam, which
round-trips the redacted JSON through the core parser before publication. Any
role failure remains visible in the desktop readout and cannot be turned into
a clean success by the renderer. Timed-out and cancelled attempts are honest
lifecycle evidence, but neither satisfies the speed axis.

## Durable history and identity

The trusted host stores only the canonical redacted report plus bounded,
host-authored failure codes. History lives beside the existing qualification
evidence as `investigation-team-qualifications.json`; raw prompts, responses,
endpoints, credentials, and evaluator truth are not stored there.

Every reopened record is reparsed, re-rendered, and re-scored before display.
The stored lifecycle status is not trusted independently of its report. The
history is capped at 128 records and 8 MiB, atomically replaced, and keyed by
run kind, exact pipeline fingerprint, and scoring digest. A report from an
older suite is projected as stale even if it was current when originally
recorded.

Provider-free checks and measured runs are different evidence classes. The UI
labels them **Wiring check** and **Measured**, and a newer wiring check never
displaces the latest measured run on startup.

## Provider boundary

The provider sees only an opaque evidence id and neutral evidence text, plus a
strict output-shape instruction. Host-only source and time anchors are attached
after the response returns. Unknown citation ids, malformed JSON, transport
errors, cancellation, and unacknowledged remote reviewer egress fail closed.

The V1 role adapter represents `single`, `investigator`, and `reviewer`. The
contribution-role topology is richer than this contract and therefore refuses
to run until a role-aware adapter exists; it is never relabeled as a reviewer
or investigator.

## Acceptance checklist

1. Open Settings → Investigation Team readiness.
2. Confirm no provider call occurs on panel load.
3. Run **Run measured check** with a local single or reviewer configuration.
4. Confirm the report shows the exact fingerprint and all four axes.
5. Confirm the **Executed pipeline identity** section shows the exact role,
   profile, model, subject, and deployment fingerprint captured for that run.
6. Confirm the report contains no endpoint URL, credentials, case text, or
   evaluator truth.
7. Force a malformed/failed provider response and confirm the affected role,
   reason, and partial/failed status remain visible.
8. Cancel a running check and confirm cancellation is not presented as
   qualification.
9. Configure a remote reviewer without egress acknowledgment and confirm the
   host refuses the run before any provider call.
10. Configure Contributions and confirm the host refuses the unsupported role
   topology without relabeling or silently executing it.
11. Restart the desktop and confirm measured history reopens with the same
    fingerprint, scoring digest, axes, and redacted exports.
12. Run a provider-free check and confirm it is labelled **Wiring check**, is
    retained separately, and does not replace the latest measured report.
13. Inject a timeout or cancellation and confirm the speed axis reads
    **Needs attention**, with the corresponding metric retained.

This is a bounded qualification measurement, not a guarantee that a later
investigation will execute successfully or that a model is universally best.
The current measured packet validates an opaque response/citation contract;
checked-in known-answer investigations, exact contribution-role execution,
measured recommendations, and configured-provider packaged acceptance remain
required before issue #726 is complete.
