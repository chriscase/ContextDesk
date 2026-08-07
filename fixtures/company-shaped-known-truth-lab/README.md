# Company-shaped known-truth fixture laboratory

This laboratory provides a deterministic, public-safe approximation of the
**structure** of a mixed server-log import. Every payload, identifier, class,
and source name is invented. It must never be populated from company logs.

## What the generator creates

- WildFly/JBoss envelopes with May 2017 **zone-less** local timestamps
- both `server.log` and rotated `server.log.1`, containing conventional
  multiline application stacks
- four independently timestamp-wrapped stderr runs, with exact records
  `60`, `71`, `81`, and `226`
- Elasticsearch, library, and configuration decoys
- explicit `Z` JSON rows and timestamp-free, order-only rows

The default `SmallCi` scenario is deliberately small. `LargerOptional` repeats
the same structural group 12 times and is ignored by normal CI.

## Known truth and privacy boundary

`evaluator-truth/manifest.json` contains aggregate geometry only. It is read by
the evaluator test and is **not** written into generated import roots. The
generator has no input path for source logs and makes no network calls.

Every incident-shaped generated record carries a unique `synthetic-cite` token.
The acceptance test checks its exact union against the independently generated
set: application + stderr counts must equal the complete citation union, with
no missing or duplicate identities.

## Anchoring variants

The generator supports four variants:

- `Anchored`: unique matching synthetic trace keys for the application and its
  stderr run.
- `Unanchored`: no named trace/request/correlation keys.
- `StaticReusedTrace`: matching but reused trace key; this must not certify.
- `ConflictingKeys`: application and stderr keys disagree; this must not
  certify.

Only unique, matched anchored keys are allowed to qualify as semantically
certified by the evaluator. The negative variants are deliberately part of the
default test suite.

## Time-zone contract

The source IANA zone is explicit and configurable in evaluator truth. The CI
test applies `America/Chicago`; in May 2017 this is UTC-05, therefore
`2017-05-10 14:10:00,000` normalizes to `2017-05-10T19:10:00Z`. Explicit UTC
rows remain unchanged, while timestamp-free records remain retained as
order-only rows.

## Run

```bash
cargo test -p cd-core --test company_shaped_known_truth_lab

# Optional larger generator scenario
cargo test -p cd-core --test company_shaped_known_truth_lab -- --ignored
```
