# Company import acceptance laboratory

Public-safe, deterministic ZIP corpus + aggregate oracle for evaluating
parser, timezone, import-progress, and diagnostic behavior **without private
company logs**.

## Schema

- Oracle: `contextdesk.company_import_lab.oracle.v1` (schema_version **2**, aggregate-only JSON)
- Generator: `contextdesk.company_import_lab.generator.v1` (fixed seed + fixed ZIP mtimes)

### External truth (fail-closed dimensions)

Oracle encodes **expected** mins, not only planned totals:

| Field | Purpose |
|-------|---------|
| `plannedEventsTotal` | Top-level ingest events (excludes nested members) |
| `plannedNestedMemberEvents` | Nested ZIP members that production must expand |
| `expectedLevelCountsMin` | Fail if level counts fall below |
| `expectedFormatCountsMin` | Fail if format counts fall below |
| `expectedPreviewStatusMins` | Fail if preview inventory undershoots |
| `minTemplateCount` / `minRepetitiveTemplateCount` | Template / repetitive-error families |
| `minUnresolvedLocalBefore` / `minExplicitWallBefore` | Provenance before TZ apply |
| `ingestEventToleranceAbs` | Absolute ± bound (not a percentage greenwash) |

## Production path (EngineClient boundary)

Verify mirrors the shipped host / EngineClient commands:

1. `preview_import_plan` → `import.preview` / `log_preview_import`
2. `verify_import_plan` + selection-bound ingest → `import.run` / `log_run_import`
3. Pre-cancelled `CancelFlag` → must return `CoreError::Cancelled` and publish **zero** events
4. Retry selection-bound ingest → observed `retryPublished` from durable corpus event count
5. `load_timezone_resolution_state` / `preview_source_timezone` / `apply_source_timezones` → `time.*`
6. Provenance histogram **before and after** apply; exception `explicit_wall` re-queried after apply
7. `diagnose_log_import` + temp cleanup

## Sizes

| Token | Target logical events |
|-------|------------------------|
| `25k` | 25_000 |
| `75k` | 75_000 (default) |
| `250k` | 250_000 |

## Shape categories (always present)

rolled filenames · nested ZIP members · macOS metadata · empty/binary/supporting ·
structured `ts` JSON · date-level-message · PostgreSQL/logfmt · multiline stacks ·
ambiguous local timestamps · one explicit timezone exception · malformed records ·
repetitive error families · high-cardinality noise

## One-command release path

```bash
cargo run --locked -p cd-core --bin cd-company-import-lab -- \
  release --size 75k --out ./company-import-lab-out
```

Exit `0` on pass; `1` on oracle drift / production mismatch; `2` usage.

Generate-only / verify-only:

```bash
cargo run --locked -p cd-core --bin cd-company-import-lab -- generate --size 25k --out /tmp/lab25
cargo run --locked -p cd-core --bin cd-company-import-lab -- verify --package /tmp/lab25
```

## Focused unit tests

```bash
cargo test -p cd-core --lib company_import_lab -- --nocapture
```

## Privacy

All content is synthetic. Oracle and reports are aggregate-only. Denylist /
canary scans run over oracle and diagnose JSON. Never point this lab at private
company corpora.
