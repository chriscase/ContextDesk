# Goal: Rich log corpus UX + versioned portable handoff

**Epic:** https://github.com/chriscase/ContextDesk/issues/467  
**Repo:** chriscase/ContextDesk  
**Priority:** P1 · **Areas:** area-logs, area-ui, area-desktop, area-core · **UX bar:** high (sleek Memory/Help-quality polish)

## Mission

Ship end-to-end:

1. Wizard post-ingest **stats hero** (reduction, sizes, top templates, levels).
2. **Persist** those stats in `meta.json` (`meta_version`) so they survive restart.
3. **Logs tab** Memory-style **list | detail** with overview/search/templates/analysis.
4. **Portable full package** export/import so peers with ContextDesk can load a finished analysis without re-ingest.
5. **Backward-compatible evolution** of both on-disk meta and the package format — version fields, dual-version importers, fixture regression suite. Compat is not optional.

## Owner-approved product locks

| Decision | Choice |
|----------|--------|
| Delivery | One PR stack, full feature |
| Logs UI | List \| detail (Memory-like) |
| Export | Full package: meta + stats + events.duckdb + templates.json **with vectors** |
| Import surfaces | Logs toolbar + wizard (chat drop stays session-context only) |

## Child issues (implement in order)

| # | Issue | Must ship |
|---|--------|-----------|
| 1 | #468 | Rich ingest stats + `meta_version`; legacy meta still opens |
| 2 | #470 | **Compat policy + reader registry + fixtures + CI** (design + code contract) |
| 3 | #469 | Versioned package export/import obeying #470 |
| 4 | #471 | Wizard stats UI |
| 5 | #472 | Logs list\|detail + Import logs / Import package / Export |
| 6 | #473 | Design / Help / CLAIMS |

Related: #464 (handoff bug), PR #466 (handoff fix — merge or stack if still open).

## Partial WIP

Branch `feat/log-corpus-rich-ux` may already have draft `store` meta/stats, `ingest` enrichment, and `package.rs`. **Inventory first; finish and harden** (especially #470 versioning fields: `format_version`, `min_reader_version`, unknown-field ignore, too-new refuse). Do not rewrite from zero without checking that branch.

## Versioning contract (non-negotiable)

### On-disk corpus (`meta.json`)

- `meta_version` integer; current = 2 when stats land.
- Readers **must** open older meta (missing stats → derive counts from DuckDB/templates).
- Never refuse open solely because stats keys are absent.
- No absolute home paths in meta (basename `source_label` only).

### Portable package (`contextdesk.log_corpus.vN`)

Manifest **must** include at least:

- `format_version` (string, e.g. `contextdesk.log_corpus.v1`)
- `min_reader_version` (semver or integer this build understands)
- `package_kind` = `log_corpus`
- `engine` = `duckdb` (refuse unknown)
- Per-payload SHA-256
- Optional: `features[]`, `writer_app_version`, stats snapshot

**Rules:**

1. **Additive within major:** new optional JSON keys / optional files only.
2. **Breaking:** new `format_version` major + dual-path importer for deprecation window (support N and N-1).
3. Readers **ignore unknown fields**; missing optional fields use defaults.
4. If `min_reader_version` / `format_version` is newer than this binary supports → **clear error**, no partial write under `log_corpora/`.
5. Import always assigns a **new** local corpus id; store `origin_corpus_id`.
6. Zip-slip, size caps, SoftWrite for import; export = user-chosen path only.

### Required tests

- Round-trip export → import (counts + optional vector search).
- Fixture / synthetic **older** package still imports.
- Package with **extra unknown JSON** still imports.
- Package with **too-new** version refused cleanly.
- Corrupt hash refuses; no orphan dirs.
- Legacy meta.json without stats still opens.
- Prefer checked-in fixtures under something like `crates/cd-core/tests/fixtures/log_packages/`.

## UI acceptance (high bar)

- Wizard ready: not just corpus id — reduction ×, sizes, top templates, levels.
- Logs: polished cards + detail tabs; set `active_log_corpus` on select.
- Toolbar: Import logs…, Import package…, Export package….
- Package version errors human-readable in UI.

## Implementation constraints

- SoftWrite Accept for ingest + package import (same discipline as wizard).
- No secrets / full home paths in progress, meta, or package.
- Reuse process-progress pattern; pane CSS tokens like Memory/Help.
- Prefer stacked PRs: core meta → compat+package → wizard UI → Logs UI → docs.
- Worktrees via `scripts/worktree-setup.sh ContextDesk <branch>` when parallelizing.
- Verify: `cargo test -p cd-core --lib log_analysis`, desktop vitest for UI, tauri `cargo check`.

## Definition of done

- [ ] All #468–#473 closed with evidence (tests/CLAIMS).
- [ ] Compat suite green on CI.
- [ ] Manual path: ingest zip → wizard shows stats → Logs detail → export .cdlog → import on fresh cache → search works.
- [ ] Epic #467 close criteria met.
- [ ] #464 remains fixed (handoff: seed + active corpus; no bogus corpus id prompts).

## Out of scope

Live streaming, S3 log source, encrypted packages (document as future only).
