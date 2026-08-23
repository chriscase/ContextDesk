# Investigation Team synthetic desktop check V1

The Investigation Team readiness panel includes a deliberately explicit
**Run local check** action. It exercises the trusted qualification and report
redaction path with an opaque deterministic fixture.

This action is useful for acceptance testing the desktop wiring. It does **not**
contact a provider, resolve credentials, execute a model, measure model quality,
or prove that a configured role will succeed on a real investigation.

## What the action proves

The host derives the currently selected profile and, when the selected route is
the V1-supported reviewer path, the configured reviewer identity. It then:

1. builds an opaque host-owned evidence packet and evaluator ledger;
2. binds the configured roles to exact profile, model, and deployment fingerprints;
3. runs the shipped `cd_workflow` qualification seam;
4. round-trips the redacted JSON report through the contract parser; and
5. publishes the result to the process-local trusted readout.

The UI displays the resulting status, four separate axes, and the pipeline
fingerprint. The report never contains deployment URLs, evaluator truth, or
evidence excerpts.

## Honest limits

The V1 contract can represent `single`, `investigator`, `reviewer`, and
`synthesizer` roles. The current contribution-role topology is richer than
that vocabulary, so the synthetic action fails closed for contribution mode
until a role-aware adapter exists. This is intentional: a contribution role
must not be relabeled as a different role merely to make a demo pass.

`qualified` means only that the deterministic fixture satisfied the contract.
It is not a capability qualification result and must not authorize a provider
route. Real qualification remains a separate host-owned execution path whose
attempts, stale state, failure state, and exact pipeline identity must be
recorded independently.

## Acceptance checklist

- In Settings, open Investigation Team readiness.
- Confirm the panel distinguishes configured roles from host-produced reports.
- Choose a supported single or reviewer configuration and select **Run local
  check**.
- Confirm a report appears with a fingerprint and separate capability,
  quality, speed, and resource axes.
- Confirm the copy says that the check is provider-free and does not qualify a
  real model.
- Remove or invalidate the active profile and rerun; confirm the host error is
  visible and no stale success is claimed.
- Configure contributions and rerun; confirm the unsupported topology fails
  closed rather than being silently relabeled.
