# Import diagnose synthetic fixtures

Checked-in **synthetic only** corpora for `cd-diagnose-log-import` and
`log_analysis::import_diagnose` tests. No private or company data.

| Tree | Purpose |
|------|---------|
| `direct/` | Multi-format small files |
| `timestamps/` | Local unresolved + order-only |
| `multiline/` | Stack-style continuation |
| `macos_noise/` | `__MACOSX` + real log |
| `binary/` | NUL-bearing blob |
| `zero/` | Empty + hidden only |
| `archives/nested.zip` | ZIP with nested ZIP |
| `archives/not_a_zip.zip` | Invalid archive bytes |

Tests also rewrite these files idempotently via `ensure_fixtures()`.
