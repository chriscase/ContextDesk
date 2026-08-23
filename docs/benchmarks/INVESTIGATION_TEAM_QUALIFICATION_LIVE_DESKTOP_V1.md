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
a clean success by the renderer.

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

This is a bounded qualification measurement, not a guarantee that a later
investigation will execute successfully or that a model is universally best.
