# Exception episode lab (neutral fixtures)

Synthetic dual-rendering corpus for deterministic exception episode correlation.

## Markers

Neutral `XYZ_*` identifiers only — no private product or company names.

## Dual-rendering 56×265 shape

Generated in unit tests (not checked in as 14k lines):

| Stream | Shape per occurrence | Occurrences |
| --- | --- | --- |
| `XYZ_app.log` | Conventional timestamped exception head + un-timestamped frames as **one** logical event | 56 |
| `XYZ_server.stderr` | Separately wrapped line-by-line records: 1 header + 72 wrappers + 189 `at` frames + 3 cause lines = **265** events | 56 |

Raw stderr volume: `56 × 265 = 14_840` records.

Correlation must report ~56 episode occurrences (or ~56 after dual-stream merge), not 14_840 independent incidents, and must disclose amplification.

## How to regenerate in tests

See `cd_core::log_analysis::exception_episodes::tests::write_dual_rendering_corpus`.
