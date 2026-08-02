# Company import acceptance laboratory

Public-safe, deterministic ZIP corpus + aggregate oracle for evaluating
parser, timezone, import-progress, and diagnostic behavior **without private
company logs**.

## Schema

- Oracle: `contextdesk.company_import_lab.oracle.v1` (aggregate-only JSON)
- Generator: `contextdesk.company_import_lab.generator.v1` (fixed seed)

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
