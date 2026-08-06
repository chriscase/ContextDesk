# Real-format exception-episode acceptance lab (red checkpoint)

**Not SHIP.** This lab is a fail-closed product-path acceptance oracle for
exception-episode reconstruction against genuine WildFly/JBoss-shaped streams.

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
| Strongly supported episodes | 56 |
| Per episode: renderings / raw / stderr / app | 8 / 272 / 265 / 7 |
| Citation union | 15 232 unique real identities |

## Envelope shape

```
2026-03-15 12:00:00,123 ERROR [stderr] (pool-40-thread-1286) java.lang.RuntimeException: XYZ_PAY id=0
2026-03-15 12:00:00,000 ERROR [XYZ_app] (default task-1) XYZ_LAYER3: java.lang.RuntimeException: ...
```

Neutral `XYZ_*` markers only.

## How to run

```bash
cargo test -p cd-core --test real_format_exception_episode_acceptance_lab -- --nocapture
```

On current main-equivalent analyzer behavior the suite **must fail** with
semantic labels (under-merge of multi-app chains, WildFly timestamp/thread
envelope gaps, etc.). Do not relax exact equality to green the suite.

Truth: `truth/truth_manifest.json`.

## Integration

Product work that intends to pass this gate should:

1. Ingest generated logs via `ingest_path_with_policy`
2. Call `analyze_exception_episodes`
3. Optionally project through broad triage + triage-quality
4. Meet every exact total and conservation equation in the truth manifest
