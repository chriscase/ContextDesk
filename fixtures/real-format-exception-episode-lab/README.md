# Real-format exception-episode acceptance lab

Product-path acceptance oracle for exception-episode reconstruction against
genuine WildFly/JBoss-shaped streams. Distinguishes **anchored** certification
from **company-shaped unanchored** honesty.

## Why this exists

The simplified ISO dual-render 56×265 oracle is insufficient:

- ISO `T…Z` timestamps (not `YYYY-MM-DD HH:mm:ss,SSS`)
- One application rendering per execution (not a 7-hop wrapper chain)
- No real `[stderr] (thread)` envelope

## Geometry (exact)

| Quantity | Value |
| --- | ---: |
| Executions | 56 |
| Application full-stack/wrapper renderings per execution | 7 |
| Stderr records per execution | 265 |
| → `at` frames | 189 |
| → auxiliary/wrapper | 72 |
| → header/cause | 4 |
| Stderr raw | 14 840 |
| Application raw | 392 |
| Total raw | 15 232 |
| Physical renderings | 448 (392 app + 56 stderr) |
| Strongly supported episodes (anchored only) | 56 |
| Per episode: renderings / raw / stderr / app | 8 / 272 / 265 / 7 |
| Citation union | 15 232 unique real identities |

## Envelope shape

```
2026-03-15 12:00:00,123 ERROR [stderr] (pool-40-thread-1286) java.lang.RuntimeException: XYZ_PAY request_id=req-0
2026-03-15 12:00:00,000 ERROR [XYZ_app] (default task-1) XYZ_LAYER3: java.lang.RuntimeException: ... request_id=req-0
```

Neutral `XYZ_*` markers only. Bare `id=` is **not** an exact execution anchor.

## Anchored vs unanchored

- **Anchored** (`write_real_format_cascade`): shared `request_id=req-{N}` across
  the seven application renderings and one stderr rendering → product may certify
  `strong_derived_episode_count=56` with `semantic_counts_certified=true`.
- **Company-shaped unanchored** (`write_company_shaped_unanchored_cascade`): app
  thread `(default task-N)` vs stderr `(pool-40-thread-M)`, no
  request/trace/correlation/transaction field, no synthetic bare `id=` →
  physical reconstruction and application propagation may succeed where proven;
  chain-to-stderr remains Moderate/unresolved; `semantic_counts_certified=false`;
  no exact 56-episode fact reaches broad triage. Raw/rendering/unresolved counts
  remain available. Model-facing text explains repeated propagation groups without
  proving an independent incident count.

Do **not** claim the company corpus is solved until a real run establishes which
shared signals actually exist. Do not use the anchored synthetic fixture to
claim the unanchored company shape is solved.

## How to run

```bash
cargo test -p cd-core --test real_format_exception_episode_acceptance_lab -- --nocapture
```

Truth: `truth/truth_manifest.json`.

## Integration

Product work that intends to pass this gate should:

1. Ingest generated logs via `ingest_path_with_policy`
2. Call `analyze_exception_episodes`
3. Optionally project through broad triage + triage-quality
4. Meet every exact total and conservation equation in the truth manifest for the
   **anchored** path; keep unanchored uncertified
